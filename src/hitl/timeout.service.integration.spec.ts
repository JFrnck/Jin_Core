import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  startTestDb,
  type TestDb,
} from '../../test/support/postgres-testcontainer';
import { AuditService } from '../audit/audit.service';
import { ChainVerificationService } from '../audit/chain-verification.service';
import { DB_CONNECTION } from '../db/db.module';
import { auditLog, pendingApprovals } from '../db/schema';
import { TimeoutService } from './timeout.service';

// Nota de cobertura: solo se prueba aquí el camino 'discard' (usado por
// sendEmail, la única tool 'confirm' registrada en esta fase). El camino
// 'escalate'/'abandon' requeriría una tool registrada con
// timeoutBehavior: 'escalate' — ninguna existe todavía (llega con Canvas
// en Fase 3) y el registry no está pensado para fixtures de test
// (AGENTS.md 5.4: es config de seguridad curada, no un mock inyectable).
// La lógica de decisión 'escalate'/'abandon' en sí ya tiene cobertura
// completa en timeout.logic.spec.ts (puro, sin DB); lo que este archivo
// prueba es el cableado con la base de datos, que es estructuralmente
// idéntico entre las 4 ramas de decideTimeoutOutcome.
describe('TimeoutService (integración, Postgres real)', () => {
  let testDb: TestDb;
  let service: TimeoutService;

  beforeAll(async () => {
    testDb = await startTestDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        TimeoutService,
        AuditService,
        ChainVerificationService,
        { provide: DB_CONNECTION, useValue: testDb.db },
      ],
    }).compile();
    service = moduleRef.get(TimeoutService);
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.delete(pendingApprovals);
    await testDb.db.delete(auditLog);
  });

  it('descarta una aprobación sendEmail vencida hace más de 24h, y registra el timeout en audit_log', async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await testDb.db.insert(pendingApprovals).values({
      requestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'sendEmail',
      level: 'confirm',
      inputsHash: 'h1',
      createdAt: oldDate,
    });

    await service.sweep();

    const pending = await testDb.db.select().from(pendingApprovals);
    expect(pending).toHaveLength(0);

    const logs = await testDb.db.select().from(auditLog);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.approvalStatus).toBe('timeout');
    expect(logs[0]?.requestId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('no toca una aprobación reciente (dentro de la ventana de 24h)', async () => {
    await testDb.db.insert(pendingApprovals).values({
      requestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'sendEmail',
      level: 'confirm',
      inputsHash: 'h1',
      createdAt: new Date(),
    });

    await service.sweep();

    const pending = await testDb.db.select().from(pendingApprovals);
    expect(pending).toHaveLength(1);
  });

  it('una tool no registrada en el registry usa "discard" como default seguro', async () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await testDb.db.insert(pendingApprovals).values({
      requestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'toolNoRegistrada',
      level: 'confirm',
      inputsHash: 'h1',
      createdAt: oldDate,
    });

    await service.sweep();

    const pending = await testDb.db.select().from(pendingApprovals);
    expect(pending).toHaveLength(0);
  });
});
