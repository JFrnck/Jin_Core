import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  startTestDb,
  type TestDb,
} from '../../test/support/postgres-testcontainer';
import { DB_CONNECTION } from '../db/db.module';
import { pendingApprovals } from '../db/schema';
import {
  DualConfirmService,
  PendingApprovalNotFoundError,
  SecondApprovalTooEarlyError,
} from './dual-confirm.service';

describe('DualConfirmService (integración, Postgres real)', () => {
  let testDb: TestDb;
  let service: DualConfirmService;

  beforeAll(async () => {
    testDb = await startTestDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        DualConfirmService,
        { provide: DB_CONNECTION, useValue: testDb.db },
      ],
    }).compile();
    service = moduleRef.get(DualConfirmService);
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.delete(pendingApprovals);
  });

  it('createPendingApproval + getPending persisten los datos correctamente', async () => {
    await service.createPendingApproval({
      requestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'sendEmail',
      level: 'confirm',
      inputsHash: 'h1',
    });

    const pending = await service.getPending(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(pending?.toolName).toBe('sendEmail');
    expect(pending?.level).toBe('confirm');
    expect(pending?.firstApprovedAt).toBeNull();
  });

  it('createPendingApproval persiste el payload cuando se provee, y null cuando se omite', async () => {
    await service.createPendingApproval({
      requestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'sendEmail',
      level: 'confirm',
      inputsHash: 'h1',
      payload: {
        to: 'destinatario@example.com',
        subject: 'Asunto',
        body: 'Cuerpo',
      },
    });
    await service.createPendingApproval({
      requestId: '22222222-2222-4222-8222-222222222222',
      toolName: 'unpause',
      level: 'confirm',
      inputsHash: 'h2',
    });

    const withPayload = await service.getPending(
      '11111111-1111-4111-8111-111111111111',
    );
    const withoutPayload = await service.getPending(
      '22222222-2222-4222-8222-222222222222',
    );

    expect(withPayload?.payload).toEqual({
      to: 'destinatario@example.com',
      subject: 'Asunto',
      body: 'Cuerpo',
    });
    expect(withoutPayload?.payload).toBeNull();
  });

  it('recordApproval resuelve de inmediato para nivel confirm', async () => {
    await service.createPendingApproval({
      requestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'sendEmail',
      level: 'confirm',
      inputsHash: 'h1',
    });

    const outcome = await service.recordApproval(
      '11111111-1111-4111-8111-111111111111',
      'owner',
    );
    expect(outcome).toBe('resolved');
  });

  it('dual-confirm: la primera aprobación devuelve awaiting-second y arma el temporizador de 30s', async () => {
    await service.createPendingApproval({
      requestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'deleteFiles',
      level: 'dual-confirm',
      inputsHash: 'h1',
    });
    const t0 = new Date('2026-01-01T00:00:00.000Z');

    const outcome = await service.recordApproval(
      '11111111-1111-4111-8111-111111111111',
      'owner',
      t0,
    );
    expect(outcome).toBe('awaiting-second');

    const pending = await service.getPending(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(pending?.firstApprovedAt?.toISOString()).toBe(t0.toISOString());
    expect(pending?.availableAt?.toISOString()).toBe(
      '2026-01-01T00:00:30.000Z',
    );
  });

  it('dual-confirm: la segunda aprobación ANTES de 30s lanza SecondApprovalTooEarlyError', async () => {
    await service.createPendingApproval({
      requestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'deleteFiles',
      level: 'dual-confirm',
      inputsHash: 'h1',
    });
    await service.recordApproval(
      '11111111-1111-4111-8111-111111111111',
      'owner',
      new Date('2026-01-01T00:00:00.000Z'),
    );

    await expect(
      service.recordApproval(
        '11111111-1111-4111-8111-111111111111',
        'owner',
        new Date('2026-01-01T00:00:29.999Z'),
      ),
    ).rejects.toThrow(SecondApprovalTooEarlyError);
  });

  it('dual-confirm: la segunda aprobación a los 30s exactos resuelve', async () => {
    await service.createPendingApproval({
      requestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'deleteFiles',
      level: 'dual-confirm',
      inputsHash: 'h1',
    });
    await service.recordApproval(
      '11111111-1111-4111-8111-111111111111',
      'owner',
      new Date('2026-01-01T00:00:00.000Z'),
    );

    const outcome = await service.recordApproval(
      '11111111-1111-4111-8111-111111111111',
      'owner',
      new Date('2026-01-01T00:00:30.000Z'),
    );
    expect(outcome).toBe('resolved');
  });

  it('recordApproval lanza PendingApprovalNotFoundError si el requestId no existe', async () => {
    await expect(
      service.recordApproval('99999999-9999-4999-8999-999999999999', 'owner'),
    ).rejects.toThrow(PendingApprovalNotFoundError);
  });

  it('removePending borra la fila persistida', async () => {
    await service.createPendingApproval({
      requestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'sendEmail',
      level: 'confirm',
      inputsHash: 'h1',
    });

    await service.removePending('11111111-1111-4111-8111-111111111111');

    expect(
      await service.getPending('11111111-1111-4111-8111-111111111111'),
    ).toBeUndefined();
  });
});
