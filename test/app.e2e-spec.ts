import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module';
import type { AuditLogRow } from '../src/db/schema';
import { AuditService } from '../src/audit/audit.service';
import { AuthService } from '../src/auth/auth.service';
import { InvalidCredentialsError } from '../src/auth/errors';
import { BudgetService } from '../src/budget/budget.service';
import { KillSwitchService } from '../src/budget/kill-switch.service';
import type { PendingApprovalRow } from '../src/db/schema';
import { ApprovalExecutionService } from '../src/hitl/approval-execution.service';
import { DualConfirmService } from '../src/hitl/dual-confirm.service';
import { MemoryService } from '../src/memory/memory.service';
import type { MemoryEntry } from '../src/memory/memory.types';
import { AgentService } from '../src/agent/agent.service';
import type { AgentTurnResult } from '../src/agent/agent.types';
import {
  LedgerRepository,
  type RunSummary,
} from '../src/agent/ledger.repository';
import type { Ticket, TicketComment } from '../src/agent/orchestrator.types';
import { ExecutorClientService } from '../src/executor-client/executor-client.service';
import type { PreviewServiceInfo } from '../src/executor-client/executor-client.service';
import { HealthService } from '../src/health/health.service';
import type { HealthReport } from '../src/health/health.service';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterEach(async () => {
    await app.close();
  });
});

describe('BudgetController (e2e) — pipeline real: guard + ZodSerializerInterceptor', () => {
  let app: INestApplication<App>;
  let token: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(BudgetService)
      .useValue({
        getLimits: () => ({ dailyMaxTokens: 1_000_000, dailyMaxUsd: 5 }),
        getDailyUsage: () =>
          Promise.resolve({
            inputTokens: 600_000,
            outputTokens: 242_340,
            costUsd: 4.31,
          }),
        getDailyUsageRatio: () => Promise.resolve(0.86),
      })
      .overrideProvider(KillSwitchService)
      .useValue({
        getStatus: () =>
          Promise.resolve({
            active: true,
            activatedAt: '2026-08-03T23:14:52.000Z',
            reason: 'Consumo de la hora actual supera 2x el promedio.',
            currentHourTokens: 10_000,
            avgHourlyTokens: 4166.67,
          }),
        unpause: () => Promise.resolve(undefined),
      })
      .overrideProvider(AuditService)
      .useValue({ recordApproval: () => Promise.resolve(undefined) })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Cualquier JWT firmado por la misma llave alcanza — el guard solo
    // verifica la firma (ver `JwtAuthGuard.canActivate`), sin claims
    // específicos requeridos.
    const jwtService = moduleFixture.get(JwtService);
    token = await jwtService.signAsync({ sub: 'owner' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/budget sin token → 401 (guard global real)', () => {
    return request(app.getHttpServer()).get('/api/budget').expect(401);
  });

  it('GET /api/budget con token → el payload real sobrevive a ZodSerializerInterceptor sin perder campos', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/budget')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      dailyUsageRatio: 0.86,
      dailyUsageUsd: 4.31,
      dailyUsageTokens: 842_340,
      dailyLimitUsd: 5,
      dailyLimitTokens: 1_000_000,
      killSwitchActive: true,
      killSwitch: {
        activatedAt: '2026-08-03T23:14:52.000Z',
        reason: 'Consumo de la hora actual supera 2x el promedio.',
        currentHourTokens: 10_000,
        avgHourlyTokens: 4166.67,
      },
    });
  });
});

describe('AuthController (e2e) — login/logout reales, sin mockear el guard', () => {
  let app: INestApplication<App>;
  let token: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthService)
      .useValue({
        login: (password: string) => {
          if (password !== 'correct-password') {
            return Promise.reject(new InvalidCredentialsError());
          }
          return Promise.resolve({ accessToken: 'signed.jwt.token' });
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const jwtService = moduleFixture.get(JwtService);
    token = await jwtService.signAsync({ sub: 'owner' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /api/auth/login con contraseña incorrecta → 401', () => {
    return request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: 'wrong' })
      .expect(401);
  });

  it('POST /api/auth/login con contraseña correcta → 200, cookie __Host- y accessToken en el body', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ password: 'correct-password' })
      .expect(200);

    expect(response.body).toEqual({ accessToken: 'signed.jwt.token' });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('__Host-jin_session='))).toBe(true);
  });

  it('POST /api/auth/login con body inválido (sin password) → 400 (ZodValidationPipe real)', () => {
    return request(app.getHttpServer())
      .post('/api/auth/login')
      .send({})
      .expect(400);
  });

  it('POST /api/auth/logout sin token → 401 (no es @Public(), a diferencia de login)', () => {
    return request(app.getHttpServer()).post('/api/auth/logout').expect(401);
  });

  it('POST /api/auth/logout con token → 200 y borra la cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({ ok: true });
  });
});

describe('HitlController (e2e) — Date real y payload arbitrario a través de ZodSerializerInterceptor', () => {
  let app: INestApplication<App>;
  let token: string;

  const pendingRow: PendingApprovalRow = {
    requestId: 'a3f9c1e2-0000-4000-8000-000000000000',
    toolName: 'sendEmail',
    level: 'confirm',
    inputsHash: 'sha256:fake',
    planSummary: 'Responder a Prof. Martínez confirmando asistencia',
    payload: { to: 'l.martinez@uni.edu', subject: 'Re: Asesoría', body: 'Ok.' },
    actor: 'web-chat',
    externalInputsSummary: 'readEmails (1)',
    createdAt: new Date('2026-08-03T23:41:00.000Z'),
    firstApprovedAt: null,
    firstApprover: null,
    availableAt: null,
    escalatedAt: null,
    executingAt: null,
    executionError: null,
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DualConfirmService)
      .useValue({ listPending: () => Promise.resolve([pendingRow]) })
      .overrideProvider(ApprovalExecutionService)
      .useValue({
        resolveAndExecute: () =>
          Promise.resolve({
            outcome: 'resolved',
            toolName: 'sendEmail',
            result: { messageId: 'msg-1' },
          }),
        resolveRejection: () => Promise.resolve(undefined),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const jwtService = moduleFixture.get(JwtService);
    token = await jwtService.signAsync({ sub: 'owner' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/hitl/pending — el Date real de Postgres/Drizzle sobrevive como ISO string, el payload arbitrario no se recorta', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/hitl/pending')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual([
      {
        ...pendingRow,
        createdAt: '2026-08-03T23:41:00.000Z',
      },
    ]);
  });

  it('POST /api/hitl/:requestId/approve — union discriminado (outcome resolved) serializa result:unknown intacto', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/hitl/${pendingRow.requestId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      outcome: 'resolved',
      toolName: 'sendEmail',
      result: { messageId: 'msg-1' },
    });
  });
});

describe('AuditController (e2e) — id bigint real a través de JSON.stringify real', () => {
  let app: INestApplication<App>;
  let token: string;

  const row = {
    id: 4192n,
    requestId: 'b1b2b3b4-0000-4000-8000-000000000000',
    timestamp: new Date('2026-08-03T23:31:44.000Z'),
    actor: 'user',
    actionType: 'approval',
    toolName: 'sendEmail',
    inputsHash: 'sha256:fake',
    planSummary: null,
    approvalStatus: 'approved',
    approver: 'owner',
    externalInputsSummary: null,
    prevHash: '1b8d...c045',
    currentHash: '42fa...9e77',
  } as unknown as AuditLogRow;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuditService)
      .useValue({
        listRecent: () => Promise.resolve({ items: [row], nextCursor: null }),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const jwtService = moduleFixture.get(JwtService);
    token = await jwtService.signAsync({ sub: 'owner' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/audit — un id bigint real no revienta JSON.stringify (bug real, preexistente, sin este test)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/audit')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      items: [{ ...row, id: '4192', timestamp: '2026-08-03T23:31:44.000Z' }],
      nextCursor: null,
    });
  });
});

describe('MemoryController (e2e) — campos opcionales presentes y ausentes', () => {
  let app: INestApplication<App>;
  let token: string;

  const entries: MemoryEntry[] = [
    {
      id: 1,
      content: 'Prefiere confirmar asesorías el mismo día',
      tipo: 'preferencia',
      fuente: 'conversación',
      fecha: '2026-05-11T00:00:00.000Z',
      modeloEmbedding: 'text-embedding-3-large',
      sessionId: 'sess-1',
      distance: 0.19,
    },
    {
      id: 2,
      content: 'Reviso el correo de la universidad después de las 22:00',
      tipo: 'preferencia',
      fuente: 'conversación',
      fecha: '2026-04-01T00:00:00.000Z',
      modeloEmbedding: 'text-embedding-3-large',
      // sin sessionId ni distance — el caso que rompería un `.optional()`
      // mal declarado bajo `exactOptionalPropertyTypes`.
    },
  ];

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MemoryService)
      .useValue({ recall: () => Promise.resolve(entries) })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const jwtService = moduleFixture.get(JwtService);
    token = await jwtService.signAsync({ sub: 'owner' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /api/memory/recall — entries con y sin sessionId/distance sobreviven intactos', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/memory/recall')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'asesorías', k: 5 })
      .expect(200);

    expect(response.body).toEqual(entries);
  });
});

describe('ChatController (e2e) — plan anidado, note opcional, arrays vacíos', () => {
  let app: INestApplication<App>;
  let token: string;

  const turnResult: AgentTurnResult = {
    finalResponse: 'Leí 18 correos y propuse 4 bloques.',
    plan: {
      steps: [
        { description: 'Leer correos sin responder', status: 'done' },
        {
          description: 'Extraer compromisos con fecha',
          status: 'failed',
          note: '401, reintentando',
        },
        { description: 'Redactar respuestas', status: 'pending' },
      ],
    },
    pendingApprovals: [
      { requestId: 'req-1', toolName: 'sendEmail' },
      { requestId: 'req-2', toolName: 'sendEmail' },
    ],
    iterationsUsed: 4,
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AgentService)
      .useValue({ runTurn: () => Promise.resolve(turnResult) })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const jwtService = moduleFixture.get(JwtService);
    token = await jwtService.signAsync({ sub: 'owner' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /api/chat — el plan con pasos en distintos estados y note opcional sobrevive intacto', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId: 's1', objective: 'revisa mi correo' })
      .expect(200);

    expect(response.body).toEqual(turnResult);
  });

  it('POST /api/chat con pendingApprovals/steps vacíos — arrays vacíos no se confunden con ausentes', async () => {
    const emptyResult: AgentTurnResult = {
      finalResponse: 'Todo al día.',
      plan: { steps: [] },
      pendingApprovals: [],
      iterationsUsed: 1,
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AgentService)
      .useValue({ runTurn: () => Promise.resolve(emptyResult) })
      .compile();
    const emptyApp: INestApplication<App> =
      moduleFixture.createNestApplication();
    await emptyApp.init();

    const response = await request(emptyApp.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId: 's1', objective: 'nada que hacer' })
      .expect(200);

    expect(response.body).toEqual(emptyResult);
    await emptyApp.close();
  });

  it('POST /api/chat con compactedHistory — sobrevive intacto al ZodSerializerInterceptor (poda + compresión, docs/RECOMENDACIONES.md #2)', async () => {
    const compactedResult: AgentTurnResult = {
      ...turnResult,
      compactedHistory: [
        {
          role: 'user',
          content: '[Resumen automático de turnos previos]\nresumen viejo',
        },
        { role: 'user', content: 'objective actual' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              toolCall: { id: 't1', name: 'readEmails', input: {} },
            },
          ],
        },
      ],
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AgentService)
      .useValue({ runTurn: () => Promise.resolve(compactedResult) })
      .compile();
    const compactedApp: INestApplication<App> =
      moduleFixture.createNestApplication();
    await compactedApp.init();

    const response = await request(compactedApp.getHttpServer())
      .post('/api/chat')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionId: 's1', objective: 'revisa mi correo' })
      .expect(200);

    expect(response.body).toEqual(compactedResult);
    await compactedApp.close();
  });
});

describe('OrchestratorController (e2e) — board de orquestación, Date real anidada', () => {
  let app: INestApplication<App>;
  let token: string;

  const run: RunSummary = {
    id: 'a1a2a3a4-0000-4000-8000-000000000000',
    objective: 'publicar dashboard de tesis',
    status: 'running',
    parentSessionId: 'sess-1',
    finalResponse: null,
    createdAt: new Date('2026-08-03T23:36:00.000Z'),
    completedAt: null,
  };
  const ticket: Ticket = {
    id: 'ticket-28',
    runId: run.id,
    description: 'Implementar parser de CSV',
    status: 'in-progress',
    assignedSubAgentId: 'builder',
    allowedTools: ['runCode'],
    dependsOn: [],
    result: null,
  };
  const comment: TicketComment = {
    id: '1',
    ticketId: ticket.id,
    authorType: 'sub_agent',
    authorId: 'builder',
    kind: 'conflict',
    body: 'El CSV usa punto y coma; cambio el delimitador en el parser.',
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LedgerRepository)
      .useValue({
        listRuns: () => Promise.resolve({ items: [run], nextCursor: null }),
        getRun: (id: string) => Promise.resolve(id === run.id ? run : null),
        getTickets: () => Promise.resolve([ticket]),
        getComments: () => Promise.resolve([comment]),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const jwtService = moduleFixture.get(JwtService);
    token = await jwtService.signAsync({ sub: 'owner' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/orchestrator/runs — createdAt (Date real) sobrevive como ISO string', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/orchestrator/runs')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      items: [
        { ...run, createdAt: '2026-08-03T23:36:00.000Z', completedAt: null },
      ],
      nextCursor: null,
    });
  });

  it('GET /api/orchestrator/runs/:runId — tickets con hilo de comentarios, conflicto visible', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/orchestrator/runs/${run.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({
      run: { ...run, createdAt: '2026-08-03T23:36:00.000Z', completedAt: null },
      tickets: [{ ...ticket, comments: [comment] }],
    });
  });

  it('GET /api/orchestrator/runs/:runId sobre un id inexistente → 404 (JinErrorFilter real)', () => {
    return request(app.getHttpServer())
      .get('/api/orchestrator/runs/no-existe')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});

describe('PreviewServicesController (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;

  const service: PreviewServiceInfo = {
    id: 'svc-1',
    slug: 'tesis-dashboard-a7f3k9',
    url: 'https://tesis-dashboard-a7f3k9.jinserver.com',
    status: 'running',
    expiresAt: '2026-08-04T08:52:00.000Z',
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ExecutorClientService)
      .useValue({
        listPreviewServices: () => Promise.resolve([service]),
        stopPreviewService: () => Promise.resolve(undefined),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const jwtService = moduleFixture.get(JwtService);
    token = await jwtService.signAsync({ sub: 'owner' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/preview-services — lista las apps corriendo', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/preview-services')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual([service]);
  });

  it('DELETE /api/preview-services/:id — detiene la app', async () => {
    const response = await request(app.getHttpServer())
      .delete('/api/preview-services/svc-1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({ ok: true });
  });
});

describe('HealthController (e2e) — pipeline real: guard global + status code', () => {
  let app: INestApplication<App>;

  async function bootstrap(report: HealthReport): Promise<void> {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(HealthService)
      .useValue({ check: () => Promise.resolve(report) })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  }

  afterEach(async () => {
    await app.close();
  });

  // Sin `Authorization`: el kubelet no tiene JWT. Si `@Public()` faltara,
  // el `JwtAuthGuard` global devolvería 401 y K8s leería el pod como
  // caído para siempre — el modo de falla que este test existe para
  // detectar, invisible en un unit spec del controller.
  it('GET /health/live sin token → 200 (ruta pública, guard global real)', async () => {
    await bootstrap({ status: 'ok', postgres: 'up', redis: 'up' });

    const response = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready sin token → 200 y el reporte sobrevive al ZodSerializerInterceptor', async () => {
    await bootstrap({ status: 'ok', postgres: 'up', redis: 'up' });

    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      postgres: 'up',
      redis: 'up',
    });
  });

  it('GET /health/ready con Redis caído → 200 degraded: el pod sigue sirviendo', async () => {
    await bootstrap({ status: 'degraded', postgres: 'up', redis: 'down' });

    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);

    expect(response.body).toEqual({
      status: 'degraded',
      postgres: 'up',
      redis: 'down',
    });
  });

  it('GET /health/ready con Postgres caído → 503 con cuerpo, no una respuesta vacía', async () => {
    await bootstrap({ status: 'error', postgres: 'down', redis: 'up' });

    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);

    expect(response.body).toEqual({
      status: 'error',
      postgres: 'down',
      redis: 'up',
    });
  });
});
