import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import { HitlPolicyService } from '../hitl-policy/hitl-policy.service';
import {
  HITL_ACTION_NOTIFIED_EVENT,
  type HitlActionNotifiedEvent,
} from '../hitl/notify.events';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import type {
  ModelCompletionResponse,
  ModelMessage,
  ModelMessageContentBlock,
  ModelToolCall,
  ModelToolDeclaration,
} from '../model-provider/model-provider.types';
import {
  buildSessionUntrustedContentInstruction,
  generateSessionNonce,
  summarizeUntrustedSources,
  wrapUntrustedContent,
} from '../security/injection-sanitizer';
import { getToolDefinition, listRegisteredTools } from '../tools/registry';
import type { AgentConfig } from './agent-config.schema';
import type { AgentProgressListener } from './agent-progress.types';
import { AGENT_CONFIG } from './agent.tokens';
import {
  buildToolCallKey,
  computeInputsHash,
  declarePlan,
  stringifyToolResult,
  updatePlanStep,
} from './agent.logic';
import type {
  AgentPendingApproval,
  AgentPlan,
  AgentTurnInput,
  AgentTurnResult,
} from './agent.types';
import { AGENT_STEP_STATUSES } from './agent.types';
import { planHistoryCompaction } from './history-compaction.logic';
import { HistoryCompactionService } from './history-compaction.service';

const DECLARE_PLAN_TOOL_NAME = 'declarePlan';
const UPDATE_PLAN_STEP_TOOL_NAME = 'updatePlanStep';

const DECLARE_PLAN_TOOL: ModelToolDeclaration = {
  name: DECLARE_PLAN_TOOL_NAME,
  description:
    'Declara o reemplaza el plan de pasos para cumplir el objetivo actual. Usala al arrancar una tarea no trivial, o para revisar el plan tras un fallo — esa revisión ES la autocorrección.',
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Lista de pasos hacia el objetivo, en orden.',
      },
    },
    required: ['steps'],
  },
};

const UPDATE_PLAN_STEP_TOOL: ModelToolDeclaration = {
  name: UPDATE_PLAN_STEP_TOOL_NAME,
  description:
    'Actualiza el estado de un paso del plan ya declarado con declarePlan.',
  inputSchema: {
    type: 'object',
    properties: {
      stepIndex: {
        type: 'number',
        description: 'Índice 0-based del paso, según el orden de declarePlan.',
      },
      status: { type: 'string', enum: AGENT_STEP_STATUSES },
      note: {
        type: 'string',
        description: 'Detalle opcional, ej. motivo de un fallo.',
      },
    },
    required: ['stepIndex', 'status'],
  },
};

const DeclarePlanInputSchema = z.object({ steps: z.array(z.string()) });
const UpdatePlanStepInputSchema = z.object({
  stepIndex: z.number().int(),
  status: z.enum(AGENT_STEP_STATUSES),
  note: z.string().optional(),
});

const CHAT_MAX_OUTPUT_TOKENS = 2000;
const CHAT_TEMPERATURE = 0.7;

function buildSystemPrompt(sessionNonce: string): string {
  return (
    'Sos Jin, un agente autónomo orientado a objetivos. Para tareas no ' +
    'triviales, declará primero un plan con la tool declarePlan, y ' +
    'actualizalo con updatePlanStep a medida que avanzás — incluido tras ' +
    'un fallo, ajustando el enfoque (autocorrección). Si un intento se ' +
    'agota sin éxito, decilo explícitamente en tu respuesta final: nunca ' +
    'inventes que algo se logró cuando no fue así.\n\n' +
    buildSessionUntrustedContentInstruction(sessionNonce)
  );
}

// Cap defensivo para el evento `tool-call-started` (streaming en vivo):
// un input grande (ej. contenido de un archivo) no debería mandar un
// frame de WS gigante al chat web.
const PROGRESS_INPUT_MAX_CHARS = 4000;

function truncateForProgress(input: unknown): unknown {
  const serialized = JSON.stringify(input);
  if (
    serialized === undefined ||
    serialized.length <= PROGRESS_INPUT_MAX_CHARS
  ) {
    return input;
  }
  return `${serialized.slice(0, PROGRESS_INPUT_MAX_CHARS)}…[truncado]`;
}

function buildToolResultBlock(
  toolCallId: string,
  output: string,
  isError = false,
): ModelMessageContentBlock {
  return {
    type: 'tool_result',
    toolCallId,
    output,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Agent loop (Fase 5.1, requisito del owner: agentic workflow con
 * plan-and-solve + self-correction). Orquesta tool-calling nativo del
 * ModelProvider con el HITL/audit/budget ya existentes — no reimplementa
 * ninguno. Alcance de esta fase: un solo turno, un solo agente; el plan
 * es transient (no persiste en Postgres — eso es el ledger de Fase 5.4).
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly budgetGuardedRouter: BudgetGuardedModelRouter,
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly dualConfirmService: DualConfirmService,
    private readonly auditService: AuditService,
    private readonly historyCompactionService: HistoryCompactionService,
    private readonly featureFlagsService: FeatureFlagsService,
    private readonly hitlPolicyService: HitlPolicyService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(AGENT_CONFIG) private readonly config: AgentConfig,
  ) {}

  async runTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const sessionNonce = generateSessionNonce();
    const systemPrompt = buildSystemPrompt(sessionNonce);
    const tools = this.buildToolDeclarations(input.allowedTools);
    const actorLabel = input.actorLabel ?? 'agent';

    const messages: ModelMessage[] = [
      ...(input.history ?? []),
      { role: 'user', content: input.objective },
    ];

    let plan: AgentPlan = { steps: [] };
    const pendingApprovals: AgentPendingApproval[] = [];
    const consecutiveFailures = new Map<string, number>();
    let iterationsUsed = 0;
    const modelsUsed: string[] = [];

    while (iterationsUsed < this.config.maxIterationsPerTurn) {
      iterationsUsed += 1;
      const currentIteration = iterationsUsed;

      // Rama según `input.onProgress` en vez de un único camino "siempre
      // streaming con callback no-op": así Telegram y `POST /api/chat`
      // nunca tocan `messages.stream()` del SDK, ni siquiera indirectamente
      // (garantía fuerte de "no tocar Telegram", ver plan de la sesión).
      const response = input.onProgress
        ? await this.budgetGuardedRouter.completeStream(
            'chat_conversational',
            {
              systemPrompt,
              messages,
              maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
              temperature: CHAT_TEMPERATURE,
              tools,
            },
            (delta, snapshot) =>
              input.onProgress?.({
                type: 'text-delta',
                iteration: currentIteration,
                delta,
                snapshot,
              }),
            undefined,
            input.sessionId,
          )
        : await this.budgetGuardedRouter.complete(
            'chat_conversational',
            {
              systemPrompt,
              messages,
              maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
              temperature: CHAT_TEMPERATURE,
              tools,
            },
            undefined,
            input.sessionId,
          );
      if (!modelsUsed.includes(response.modelId)) {
        modelsUsed.push(response.modelId);
      }

      if (response.stopReason !== 'tool_use' || !response.toolCalls?.length) {
        return this.finalizeTurn(
          input.sessionId,
          messages,
          this.resolveFinalResponseText(response),
          plan,
          pendingApprovals,
          iterationsUsed,
          modelsUsed,
        );
      }

      messages.push({
        role: 'assistant',
        content: response.toolCalls.map(
          (toolCall): ModelMessageContentBlock => ({
            type: 'tool_use',
            toolCall,
          }),
        ),
      });

      const toolResultBlocks: ModelMessageContentBlock[] = [];
      for (const call of response.toolCalls) {
        if (call.name === DECLARE_PLAN_TOOL_NAME) {
          plan = this.handleDeclarePlan(call, toolResultBlocks);
          input.onProgress?.({ type: 'plan', plan });
          continue;
        }
        if (call.name === UPDATE_PLAN_STEP_TOOL_NAME) {
          plan = this.handleUpdatePlanStep(call, plan, toolResultBlocks);
          input.onProgress?.({ type: 'plan', plan });
          continue;
        }

        // Secuencial a propósito: las tool calls de una misma respuesta
        // se resuelven en orden (dual-confirm/audit escriben a la misma
        // conexión, y el cap de fallos consecutivos necesita ver el
        // conteo actualizado antes de la siguiente llamada idéntica).
        await this.handleRealToolCall(
          call,
          input.sessionId,
          sessionNonce,
          actorLabel,
          consecutiveFailures,
          pendingApprovals,
          toolResultBlocks,
          messages,
          input.onProgress,
        );
      }

      messages.push({ role: 'user', content: toolResultBlocks });
    }

    return this.finalizeTurn(
      input.sessionId,
      messages,
      'Se alcanzó el límite de iteraciones del turno sin llegar a una respuesta final.',
      plan,
      pendingApprovals,
      iterationsUsed,
      modelsUsed,
    );
  }

  /**
   * `stopReason: 'refusal'` (clasificador de seguridad de Anthropic corta
   * la respuesta, `content` viene vacío o casi vacío) nunca debe llegar al
   * owner como un mensaje en blanco — antes de este fix, `finalizeTurn`
   * reenviaba `response.content` tal cual, y en Telegram/WS el owner solo
   * veía el footer de modelo sin texto (bug real, encontrado 2026-09-24
   * reproduciendo localmente un pedido de deploy con Vite+React+Tailwind
   * que dispara el refusal de forma consistente). Mismo criterio que ya
   * exige `buildSystemPrompt`: "nunca inventes que algo se logró cuando no
   * fue así" — acá aplica a Jin mismo, no solo al contenido que genera.
   */
  private resolveFinalResponseText(response: ModelCompletionResponse): string {
    if (
      response.stopReason === 'refusal' ||
      response.content.trim().length === 0
    ) {
      this.logger.warn(
        `Turno sin texto útil del modelo (stopReason=${response.stopReason}, modelo=${response.modelId}) — probablemente el clasificador de seguridad de Anthropic cortó la respuesta.`,
      );
      return (
        'No pude generar una respuesta para este pedido: el modelo cortó la ' +
        'respuesta sin devolver contenido (probablemente su propio filtro de ' +
        'seguridad, no un error de Jin). Probá reformular el objetivo o ' +
        'dividirlo en pasos más chicos.'
      );
    }
    return response.content;
  }

  /**
   * Punto único de salida de `runTurn` (docs/RECOMENDACIONES.md #2 +
   * requisito del owner 2026-08-04: poda + compresión). Decide si el
   * historial de ESTE turno (`input.history` + lo que se generó acá)
   * necesita comprimirse antes de devolverse al caller — si `/chat` es
   * stateless, el caller reenvía `history` completo en el próximo turno,
   * así que comprimir sin devolver `compactedHistory` no reduciría nada
   * real (el trabajo se repetiría cada turno). `historyCompactionService.
   * compact()` nunca lanza — una falla ahí solo hace que este turno no
   * incluya `compactedHistory`, nunca rompe el turno en sí.
   */
  private async finalizeTurn(
    sessionId: string,
    messages: readonly ModelMessage[],
    finalResponse: string,
    plan: AgentPlan,
    pendingApprovals: readonly AgentPendingApproval[],
    iterationsUsed: number,
    modelsUsed: readonly string[],
  ): Promise<AgentTurnResult> {
    const base: AgentTurnResult = {
      finalResponse,
      plan,
      pendingApprovals,
      iterationsUsed,
      modelsUsed,
    };

    const compactionPlan = planHistoryCompaction(messages, {
      maxHistoryTokens: this.config.maxHistoryTokens,
      preserveLastTurns: this.config.preserveLastTurns,
    });
    if (!compactionPlan) return base;

    const summary = await this.historyCompactionService.compact(
      sessionId,
      compactionPlan,
    );
    if (!summary) return base;

    return {
      ...base,
      compactedHistory: [summary, ...compactionPlan.toPreserve],
    };
  }

  private buildToolDeclarations(
    allowedTools?: readonly string[],
  ): readonly ModelToolDeclaration[] {
    const allowedSet = allowedTools ? new Set(allowedTools) : undefined;
    const realTools = listRegisteredTools()
      .filter((tool) => !allowedSet || allowedSet.has(tool.name))
      .map((tool): ModelToolDeclaration => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    return [DECLARE_PLAN_TOOL, UPDATE_PLAN_STEP_TOOL, ...realTools];
  }

  private handleDeclarePlan(
    call: ModelToolCall,
    toolResultBlocks: ModelMessageContentBlock[],
  ): AgentPlan {
    const parsed = DeclarePlanInputSchema.safeParse(call.input);
    if (!parsed.success) {
      toolResultBlocks.push(
        buildToolResultBlock(
          call.id,
          `Input inválido para declarePlan: ${parsed.error.message}`,
          true,
        ),
      );
      return { steps: [] };
    }

    const plan = declarePlan(parsed.data.steps);
    toolResultBlocks.push(
      buildToolResultBlock(
        call.id,
        `Plan declarado con ${plan.steps.length} paso(s).`,
      ),
    );
    return plan;
  }

  private handleUpdatePlanStep(
    call: ModelToolCall,
    plan: AgentPlan,
    toolResultBlocks: ModelMessageContentBlock[],
  ): AgentPlan {
    const parsed = UpdatePlanStepInputSchema.safeParse(call.input);
    if (!parsed.success) {
      toolResultBlocks.push(
        buildToolResultBlock(
          call.id,
          `Input inválido para updatePlanStep: ${parsed.error.message}`,
          true,
        ),
      );
      return plan;
    }

    try {
      const updated = updatePlanStep(
        plan,
        parsed.data.stepIndex,
        parsed.data.status,
        parsed.data.note,
      );
      toolResultBlocks.push(
        buildToolResultBlock(
          call.id,
          `Paso ${parsed.data.stepIndex} actualizado.`,
        ),
      );
      return updated;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toolResultBlocks.push(buildToolResultBlock(call.id, msg, true));
      return plan;
    }
  }

  /**
   * Tools reales (no meta-tools de plan): `auto`/`notify` se ejecutan ya
   * (vía `ToolExecutorRegistry`, reusado también para ejecución diferida
   * — PR #8); `confirm`/`dual-confirm` difieren creando una pending
   * approval con el payload, sin ejecutar nada en este turno.
   */
  private async handleRealToolCall(
    call: ModelToolCall,
    sessionId: string,
    sessionNonce: string,
    actorLabel: string,
    consecutiveFailures: Map<string, number>,
    pendingApprovals: AgentPendingApproval[],
    toolResultBlocks: ModelMessageContentBlock[],
    messages: readonly ModelMessage[],
    onProgress: AgentProgressListener | undefined,
  ): Promise<void> {
    onProgress?.({
      type: 'tool-call-started',
      toolCallId: call.id,
      toolName: call.name,
      input: truncateForProgress(call.input),
    });
    const finish = (
      outcome: 'success' | 'error' | 'deferred',
      summary?: string,
    ): void => {
      onProgress?.({
        type: 'tool-call-finished',
        toolCallId: call.id,
        toolName: call.name,
        outcome,
        ...(summary !== undefined ? { summary } : {}),
      });
    };

    // Fase 9.5: chequeo único de integración apagada, antes de clasificar
    // o contar fallos -- una integración desactivada no es un "fallo" de
    // la tool, es una decisión operativa del owner (config/feature-flags.yaml).
    const toolDefinition = getToolDefinition(call.name);
    if (
      toolDefinition?.integration &&
      !this.featureFlagsService.isIntegrationEnabled(toolDefinition.integration)
    ) {
      const summary = `La integración "${toolDefinition.integration}" está desactivada (feature flag). No se ejecutó "${call.name}".`;
      toolResultBlocks.push(buildToolResultBlock(call.id, summary, true));
      finish('error', summary);
      return;
    }

    const failureKey = buildToolCallKey(call.name, call.input);
    const priorFailures = consecutiveFailures.get(failureKey) ?? 0;

    if (priorFailures >= this.config.maxConsecutiveToolFailures) {
      const summary = `Este intento exacto de "${call.name}" ya falló ${priorFailures} veces seguidas — no se reintenta más. Probá un enfoque distinto o reportá el fallo.`;
      toolResultBlocks.push(buildToolResultBlock(call.id, summary, true));
      finish('error', summary);
      return;
    }

    try {
      // ÚNICA puerta de decisión del nivel HITL (ADR 0010): nivel estático
      // del registry -> overrides de feature flags -> modo de autonomía.
      // `classifyToolCall` sigue siendo la única fuente del nivel BASE.
      const decision = await this.hitlPolicyService.decide(
        call.name,
        call.input,
      );
      const inputsHash = computeInputsHash(call.input);

      if (decision.level === 'confirm' || decision.level === 'dual-confirm') {
        const externalInputsSummary = summarizeUntrustedSources(messages);
        await this.dualConfirmService.createPendingApproval({
          requestId: decision.requestId,
          toolName: call.name,
          level: decision.level,
          inputsHash,
          planSummary: `Tool "${call.name}" invocada por ${actorLabel} (sesión ${sessionId})`,
          payload: call.input,
          actor: actorLabel,
          ...(externalInputsSummary !== undefined
            ? { externalInputsSummary }
            : {}),
        });
        pendingApprovals.push({
          requestId: decision.requestId,
          toolName: call.name,
        });
        consecutiveFailures.delete(failureKey);
        const summary = `Acción diferida — requiere aprobación humana (requestId: ${decision.requestId}). No se ejecutó todavía.`;
        toolResultBlocks.push(buildToolResultBlock(call.id, summary));
        finish('deferred', summary);
        return;
      }

      const result = await this.toolExecutorRegistry.execute(
        call.name,
        call.input,
      );
      consecutiveFailures.delete(failureKey);

      await this.auditService.recordToolCall({
        requestId: decision.requestId,
        actor: actorLabel,
        toolName: call.name,
        inputsHash,
        approvalStatus: decision.level === 'auto' ? 'auto' : 'notified',
        // Si un modo de autonomía la relajó, el audit lo dice: se ve POR QUÉ
        // esta acción no pidió aprobación.
        ...(decision.relaxedBy !== undefined
          ? {
              planSummary: `Autoejecutada sin aprobación (${decision.relaxedBy}): "${call.name}" era confirm`,
            }
          : {}),
      });

      // Notificación post-hoc real (BLUEPRINT 9.1). Antes `notify` solo
      // dejaba la fila del audit y nadie avisaba al owner.
      if (decision.level === 'notify') {
        this.eventEmitter.emit(HITL_ACTION_NOTIFIED_EVENT, {
          requestId: decision.requestId,
          toolName: call.name,
          actor: actorLabel,
          ...(decision.relaxedBy !== undefined
            ? { relaxedBy: decision.relaxedBy }
            : {}),
        } satisfies HitlActionNotifiedEvent);
      }

      const sanitized = wrapUntrustedContent(
        stringifyToolResult(result),
        call.name,
        sessionNonce,
      );
      toolResultBlocks.push(buildToolResultBlock(call.id, sanitized));
      finish('success');
    } catch (err: unknown) {
      consecutiveFailures.set(failureKey, priorFailures + 1);
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Tool "${call.name}" falló (intento ${priorFailures + 1}): ${msg}`,
      );
      const summary = `Error ejecutando ${call.name}: ${msg}`;
      toolResultBlocks.push(buildToolResultBlock(call.id, summary, true));
      finish('error', summary);
    }
  }
}
