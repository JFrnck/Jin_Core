import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { getToken } from '@willsoto/nestjs-prometheus';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  startTestDb,
  type TestDb,
} from '../../test/support/postgres-testcontainer';
import { AuditService } from '../audit/audit.service';
import { ChainVerificationService } from '../audit/chain-verification.service';
import { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import { BUDGET_CONFIG, MODEL_PRICES } from '../budget/budget.tokens';
import type { BudgetConfig } from '../budget/budget.types';
import { BudgetService } from '../budget/budget.service';
import { KillSwitchService } from '../budget/kill-switch.service';
import { DB_CONNECTION } from '../db/db.module';
import {
  agentOrchestrationRuns,
  agentTicketComments,
  agentTickets,
  auditLog,
  budgetKillSwitch,
  pendingApprovals,
} from '../db/schema';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import {
  BUDGET_REMAINING_RATIO,
  RUNAWAY_DETECTED_TOTAL,
  TOKENS_CONSUMED_TOTAL,
} from '../metrics/metrics.module';
import { ModelRouterService } from '../model-provider/router.service';
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
} from '../model-provider/model-provider.types';
import type { AgentConfig } from './agent-config.schema';
import { AGENT_CONFIG } from './agent.tokens';
import { AgentService } from './agent.service';
import { LedgerRepository } from './ledger.repository';
import { OrchestratorService } from './orchestrator.service';
import { ReconciliationService } from './reconciliation.service';
import { TicketDecompositionService } from './ticket-decomposition.service';

const TEST_BUDGET_CONFIG: BudgetConfig = {
  sessionMaxInputTokens: 1_000_000,
  sessionMaxOutputTokens: 500_000,
  dailyMaxTokens: 10_000_000,
  dailyMaxUsd: 1000,
  runawayMultiplier: 2,
  runawayLookbackHours: 3,
};

const TEST_METRIC_PROVIDERS = [
  { provide: getToken(TOKENS_CONSUMED_TOTAL), useValue: { inc: vi.fn() } },
  { provide: getToken(BUDGET_REMAINING_RATIO), useValue: { set: vi.fn() } },
  { provide: getToken(RUNAWAY_DETECTED_TOTAL), useValue: { inc: vi.fn() } },
];

function endTurnResponse(content: string): ModelCompletionResponse {
  return {
    content,
    modelId: 'test-model',
    inputTokens: 100,
    outputTokens: 50,
    stopReason: 'end_turn',
  };
}

function objectiveOf(request: ModelCompletionRequest): string {
  const last = request.messages.at(-1);
  return typeof last?.content === 'string' ? last.content : '';
}

type CompleteFn = (
  taskProfile: string,
  request: ModelCompletionRequest,
) => ModelCompletionResponse | Promise<ModelCompletionResponse>;

describe('OrchestratorService (integración, Postgres real + ModelRouterService mockeado)', () => {
  let testDb: TestDb;
  let orchestrator: OrchestratorService;
  let ledger: LedgerRepository;
  let dualConfirmService: DualConfirmService;
  let budgetService: BudgetService;
  let completeMock: ReturnType<typeof vi.fn<CompleteFn>>;

  beforeAll(async () => {
    testDb = await startTestDb();
    const agentConfig: AgentConfig = {
      maxIterationsPerTurn: 5,
      maxConsecutiveToolFailures: 2,
      maxConcurrentSubAgents: 3,
    };
    completeMock = vi.fn<CompleteFn>();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        { provide: DB_CONNECTION, useValue: testDb.db },
        { provide: BUDGET_CONFIG, useValue: TEST_BUDGET_CONFIG },
        {
          provide: MODEL_PRICES,
          useValue: {
            'test-model': { inputPerMillion: 100, outputPerMillion: 100 },
          },
        },
        { provide: AGENT_CONFIG, useValue: agentConfig },
        { provide: ModelRouterService, useValue: { complete: completeMock } },
        ...TEST_METRIC_PROVIDERS,
        ToolExecutorRegistry,
        ChainVerificationService,
        AuditService,
        DualConfirmService,
        BudgetService,
        KillSwitchService,
        BudgetGuardedModelRouter,
        AgentService,
        LedgerRepository,
        TicketDecompositionService,
        ReconciliationService,
        OrchestratorService,
      ],
    }).compile();

    orchestrator = moduleRef.get(OrchestratorService);
    ledger = moduleRef.get(LedgerRepository);
    dualConfirmService = moduleRef.get(DualConfirmService);
    budgetService = moduleRef.get(BudgetService);
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.delete(agentTicketComments);
    await testDb.db.delete(agentTickets);
    await testDb.db.delete(agentOrchestrationRuns);
    await testDb.db.delete(pendingApprovals);
    await testDb.db.delete(auditLog);
    await testDb.db.delete(budgetKillSwitch);
    completeMock.mockReset();
  });

  it('descomposición con dependencias respeta el orden: el sub-agente dependiente arranca DESPUÉS de que el otro termina', async () => {
    const callOrder: string[] = [];

    completeMock.mockImplementation(
      (taskProfile: string, request: ModelCompletionRequest) => {
        if (taskProfile === 'reasoning_heavy') {
          if (request.systemPrompt?.includes('descomposición')) {
            return endTurnResponse(
              JSON.stringify([
                {
                  description: 'leer correo',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
                {
                  description: 'proponer agenda',
                  allowedTools: [],
                  dependsOnIndexes: [0],
                },
              ]),
            );
          }
          return endTurnResponse(
            JSON.stringify({ finalResponse: 'listo', conflicts: [] }),
          );
        }
        const objective = objectiveOf(request);
        callOrder.push(objective);
        return endTurnResponse(`resultado de: ${objective}`);
      },
    );

    const result = await orchestrator.runObjective({
      sessionId: 'sess-1',
      objective: 'revisa mi correo y proponme la agenda',
    });

    expect(result.status).toBe('done');
    expect(callOrder).toEqual(['leer correo', 'proponer agenda']);
  });

  it('tareas independientes corren en paralelo: ninguna espera a que la otra termine para arrancar', async () => {
    let started = 0;
    let resolveBothStarted: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });

    completeMock.mockImplementation(
      async (taskProfile: string, request: ModelCompletionRequest) => {
        if (taskProfile === 'reasoning_heavy') {
          if (request.systemPrompt?.includes('descomposición')) {
            return endTurnResponse(
              JSON.stringify([
                {
                  description: 'tarea A',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
                {
                  description: 'tarea B',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
              ]),
            );
          }
          return endTurnResponse(
            JSON.stringify({ finalResponse: 'listo', conflicts: [] }),
          );
        }
        started += 1;
        if (started === 2) resolveBothStarted();
        // Si el orquestador corriera esto secuencialmente, la primera
        // llamada quedaría esperando acá para siempre (la segunda nunca
        // arrancaría) — el test fallaría por timeout, no por assertion.
        await bothStarted;
        return endTurnResponse(`ok: ${objectiveOf(request)}`);
      },
    );

    const result = await orchestrator.runObjective({
      sessionId: 'sess-1',
      objective: 'dos tareas independientes',
    });

    expect(result.status).toBe('done');
    expect(started).toBe(2);
  }, 10_000);

  it('conflicto de BAJO riesgo se resuelve en modo-auto: comentario de resolución, sin pending approval, run queda done', async () => {
    completeMock.mockImplementation(
      (taskProfile: string, request: ModelCompletionRequest) => {
        if (taskProfile === 'reasoning_heavy') {
          if (request.systemPrompt?.includes('descomposición')) {
            return endTurnResponse(
              JSON.stringify([
                {
                  description: 'tarea A',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
                {
                  description: 'tarea B',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
              ]),
            );
          }
          const ticketIds = [
            ...(typeof request.messages[0]?.content === 'string'
              ? request.messages[0].content
              : ''
            ).matchAll(/Ticket ([0-9a-f-]{36})/g),
          ].map((m) => m[1]!);
          return endTurnResponse(
            JSON.stringify({
              finalResponse: 'listo, con una discrepancia menor ya resuelta',
              conflicts: [
                {
                  ticketIds,
                  summary:
                    'redacciones levemente distintas del mismo resultado',
                  riskLevel: 'low',
                  proposedResolution: 'se usó la redacción de tarea A',
                },
              ],
            }),
          );
        }
        return endTurnResponse(`ok: ${objectiveOf(request)}`);
      },
    );

    const result = await orchestrator.runObjective({
      sessionId: 'sess-1',
      objective: 'dos tareas con una discrepancia menor',
    });

    expect(result.status).toBe('done');
    expect(result.pendingApprovals).toEqual([]);

    const tickets = await ledger.getTickets(result.runId);
    const [firstTicket] = tickets;
    const comments = await ledger.getComments(firstTicket!.id);
    expect(comments.some((c) => c.kind === 'resolution')).toBe(true);
  });

  it('contradicción entre sub-agentes dispara reconciliación: conflicto material crea una pending approval real y el run queda blocked', async () => {
    completeMock.mockImplementation(
      (taskProfile: string, request: ModelCompletionRequest) => {
        if (taskProfile === 'reasoning_heavy') {
          if (request.systemPrompt?.includes('descomposición')) {
            return endTurnResponse(
              JSON.stringify([
                {
                  description: 'tarea A',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
                {
                  description: 'tarea B',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
              ]),
            );
          }
          // El prompt de reconciliación incluye "Ticket <uuid> (status: ...)"
          // por cada ticket real (ver reconciliation.service.ts) — se
          // extraen acá porque los ids son generados en runtime, no se
          // conocen de antemano al armar este mock.
          const ticketIds = [
            ...(typeof request.messages[0]?.content === 'string'
              ? request.messages[0].content
              : ''
            ).matchAll(/Ticket ([0-9a-f-]{36})/g),
          ].map((m) => m[1]!);
          return endTurnResponse(
            JSON.stringify({
              finalResponse: 'hay una contradicción que requiere tu decisión',
              conflicts: [
                {
                  ticketIds,
                  summary: 'A y B contradicen la hora del evento',
                  riskLevel: 'material',
                  proposedResolution: 'confirmar con el calendario real',
                },
              ],
            }),
          );
        }
        return endTurnResponse(`ok: ${objectiveOf(request)}`);
      },
    );

    const result = await orchestrator.runObjective({
      sessionId: 'sess-1',
      objective: 'dos tareas que se contradicen',
    });

    expect(result.status).toBe('blocked');
    expect(result.pendingApprovals).toHaveLength(1);

    const pending = await dualConfirmService.getPending(
      result.pendingApprovals[0]!.requestId,
    );
    expect(pending?.toolName).toBe('resolveAgentConflict');
    expect(pending?.level).toBe('confirm');
    expect(pending?.actor).toBe('orchestrator');
    expect(pending?.externalInputsSummary).toBeNull();
  });

  it('un confirm de un sub-agente NO bloquea tareas independientes: la otra llega a done igual', async () => {
    completeMock.mockImplementation(
      (taskProfile: string, request: ModelCompletionRequest) => {
        if (taskProfile === 'reasoning_heavy') {
          if (request.systemPrompt?.includes('descomposición')) {
            return endTurnResponse(
              JSON.stringify([
                {
                  description: 'manda un correo',
                  allowedTools: ['sendEmail'],
                  dependsOnIndexes: [],
                },
                {
                  description: 'tarea independiente',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
              ]),
            );
          }
          return endTurnResponse(
            JSON.stringify({ finalResponse: 'listo', conflicts: [] }),
          );
        }
        const objective = objectiveOf(request);
        if (objective === 'manda un correo') {
          if (!request.tools?.some((t) => t.name === 'sendEmail')) {
            throw new Error('sendEmail no estaba en allowedTools');
          }
          return {
            content: '',
            modelId: 'test-model',
            inputTokens: 100,
            outputTokens: 50,
            stopReason: 'tool_use',
            toolCalls: [
              {
                id: 'call-1',
                name: 'sendEmail',
                input: { to: 'x@y.com', subject: 'hola', body: 'mundo' },
              },
            ],
          };
        }
        if (objective.startsWith('Tool "sendEmail"')) {
          return endTurnResponse('correo pendiente de aprobación');
        }
        return endTurnResponse(`ok: ${objective}`);
      },
    );

    const result = await orchestrator.runObjective({
      sessionId: 'sess-1',
      objective: 'mandá un correo y hacé algo más, independiente',
    });

    const tickets = await ledger.getTickets(result.runId);
    const emailTicket = tickets.find(
      (t) => t.description === 'manda un correo',
    );
    const otherTicket = tickets.find(
      (t) => t.description === 'tarea independiente',
    );
    expect(emailTicket?.status).toBe('blocked');
    expect(otherTicket?.status).toBe('done');
  });

  it('un ticket cuyo sub-agente falla (error real, no kill switch) queda failed sin tirar abajo tareas independientes', async () => {
    completeMock.mockImplementation(
      (taskProfile: string, request: ModelCompletionRequest) => {
        if (taskProfile === 'reasoning_heavy') {
          if (request.systemPrompt?.includes('descomposición')) {
            return endTurnResponse(
              JSON.stringify([
                {
                  description: 'tarea que falla',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
                {
                  description: 'tarea independiente',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
              ]),
            );
          }
          return endTurnResponse(
            JSON.stringify({ finalResponse: 'listo', conflicts: [] }),
          );
        }
        const objective = objectiveOf(request);
        if (objective === 'tarea que falla') {
          throw new Error('API externa caída');
        }
        return endTurnResponse(`ok: ${objective}`);
      },
    );

    const result = await orchestrator.runObjective({
      sessionId: 'sess-1',
      objective: 'una tarea falla, la otra no',
    });

    const tickets = await ledger.getTickets(result.runId);
    const failedTicket = tickets.find(
      (t) => t.description === 'tarea que falla',
    );
    const otherTicket = tickets.find(
      (t) => t.description === 'tarea independiente',
    );
    expect(failedTicket?.status).toBe('failed');
    expect(otherTicket?.status).toBe('done');
    expect(result.status).toBe('failed');

    const comments = await ledger.getComments(failedTicket!.id);
    expect(
      comments.some(
        (c) => c.kind === 'note' && c.body.includes('API externa caída'),
      ),
    ).toBe(true);
  });

  it('el kill switch activado ANTES del segundo batch detiene TODO el run — el ticket dependiente ni arranca', async () => {
    completeMock.mockImplementation(
      async (taskProfile: string, request: ModelCompletionRequest) => {
        if (taskProfile === 'reasoning_heavy') {
          if (request.systemPrompt?.includes('descomposición')) {
            return endTurnResponse(
              JSON.stringify([
                {
                  description: 'tarea A',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
                {
                  description: 'tarea B',
                  allowedTools: [],
                  dependsOnIndexes: [0],
                },
              ]),
            );
          }
          return endTurnResponse(
            JSON.stringify({
              finalResponse: 'no debería llegar acá',
              conflicts: [],
            }),
          );
        }
        const objective = objectiveOf(request);
        if (objective === 'tarea A') {
          // Activa el kill switch a mano (simula que se activó "a mitad
          // del turno multi-agente", entre el batch 1 y el batch 2).
          await testDb.db
            .insert(budgetKillSwitch)
            .values({ id: 1, active: true, reason: 'test' })
            .onConflictDoUpdate({
              target: budgetKillSwitch.id,
              set: { active: true, reason: 'test' },
            });
          return endTurnResponse('tarea A resuelta');
        }
        throw new Error('tarea B NO debería haber arrancado nunca');
      },
    );

    const result = await orchestrator.runObjective({
      sessionId: 'sess-1',
      objective: 'dos tareas dependientes',
    });

    expect(result.status).toBe('killed');
    expect(result.finalResponse).toBeNull();

    const tickets = await ledger.getTickets(result.runId);
    const ticketB = tickets.find((t) => t.description === 'tarea B');
    expect(ticketB?.status).toBe('pending');
  });

  it('el kill switch propagado por un sub-agente a mitad de un batch también detiene TODO el run', async () => {
    completeMock.mockImplementation(
      async (taskProfile: string, request: ModelCompletionRequest) => {
        if (taskProfile === 'reasoning_heavy') {
          if (request.systemPrompt?.includes('descomposición')) {
            return endTurnResponse(
              JSON.stringify([
                {
                  description: 'tarea A',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
                {
                  description: 'tarea B',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
              ]),
            );
          }
          return endTurnResponse('no debería llegar acá');
        }
        const objective = objectiveOf(request);
        if (objective === 'tarea A') {
          await testDb.db
            .insert(budgetKillSwitch)
            .values({ id: 1, active: true, reason: 'test' })
            .onConflictDoUpdate({
              target: budgetKillSwitch.id,
              set: { active: true, reason: 'test' },
            });
        }
        return endTurnResponse(`ok: ${objective}`);
      },
    );

    const result = await orchestrator.runObjective({
      sessionId: 'sess-1',
      objective: 'dos tareas independientes, una activa el kill switch',
    });

    expect(result.status).toBe('killed');
  });

  it('presupuesto agregado del turno = suma real de lo consumido por cada sub-agente (BudgetService.getSessionUsage)', async () => {
    completeMock.mockImplementation(
      (taskProfile: string, request: ModelCompletionRequest) => {
        if (taskProfile === 'reasoning_heavy') {
          if (request.systemPrompt?.includes('descomposición')) {
            return {
              content: JSON.stringify([
                {
                  description: 'tarea A',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
                {
                  description: 'tarea B',
                  allowedTools: [],
                  dependsOnIndexes: [],
                },
              ]),
              modelId: 'test-model',
              inputTokens: 200,
              outputTokens: 100,
              stopReason: 'end_turn',
            };
          }
          return {
            content: JSON.stringify({ finalResponse: 'listo', conflicts: [] }),
            modelId: 'test-model',
            inputTokens: 300,
            outputTokens: 150,
            stopReason: 'end_turn',
          };
        }
        return {
          content: `ok: ${objectiveOf(request)}`,
          modelId: 'test-model',
          inputTokens: 10,
          outputTokens: 5,
          stopReason: 'end_turn',
        };
      },
    );

    const result = await orchestrator.runObjective({
      sessionId: 'sess-1',
      objective: 'dos tareas',
    });

    const tickets = await ledger.getTickets(result.runId);
    const perTicketUsage = tickets.map((t) =>
      budgetService.getSessionUsage(`${result.runId}:${t.id}`),
    );
    const orchestratorUsage = budgetService.getSessionUsage(result.runId);

    const totalInput =
      orchestratorUsage.inputTokens +
      perTicketUsage.reduce((sum, u) => sum + u.inputTokens, 0);
    const totalOutput =
      orchestratorUsage.outputTokens +
      perTicketUsage.reduce((sum, u) => sum + u.outputTokens, 0);

    // decomposición (200/100) + reconciliación (300/150) + 2 sub-agentes (10/5 c/u)
    expect(totalInput).toBe(200 + 300 + 10 + 10);
    expect(totalOutput).toBe(100 + 150 + 5 + 5);
    // Cada sub-agente tuvo su propio consumo — ninguno en cero.
    for (const usage of perTicketUsage) {
      expect(usage.inputTokens).toBeGreaterThan(0);
    }
  });
});
