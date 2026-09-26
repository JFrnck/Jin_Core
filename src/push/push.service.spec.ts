import { generateKeyPairSync } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LedgerRepository } from '../agent/ledger.repository';
import type { Env } from '../config/env.schema';
import type { Db } from '../db/db.module';
import type { PushDeviceRow, PushActivityTokenRow } from '../db/schema';
import type { ApnsClient } from './apns.client';
import { PushService } from './push.service';
import type { PushStore } from './push.store';
import type { ApnsNotification } from './push.types';

const privateKeyPem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

function config(withKeys: boolean): ConfigService<Env, true> {
  const values: Record<string, string | undefined> = withKeys
    ? {
        APNS_KEY_ID: 'ABC123DEFG',
        APNS_TEAM_ID: 'TEAM123456',
        APNS_PRIVATE_KEY: privateKeyPem,
        APNS_BUNDLE_ID: 'com.jeanfranck.jin',
      }
    : { APNS_BUNDLE_ID: 'com.jeanfranck.jin' };
  return { get: (key: string) => values[key] } as unknown as ConfigService<
    Env,
    true
  >;
}

function device(
  token: string,
  preferences: Record<string, boolean> = {},
): PushDeviceRow {
  return {
    token,
    environment: 'sandbox',
    preferences,
    createdAt: new Date(),
    lastSeenAt: new Date(),
  };
}

/** Db falso: cualquier select devuelve `rows`. */
function fakeDb(rows: unknown[]): Db {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  return chain as unknown as Db;
}

describe('PushService', () => {
  let store: {
    listDevices: ReturnType<typeof vi.fn>;
    deleteDevice: ReturnType<typeof vi.fn>;
    activityTokensFor: ReturnType<typeof vi.fn>;
    startTokens: ReturnType<typeof vi.fn>;
    deleteActivityToken: ReturnType<typeof vi.fn>;
  };
  let sent: { token: string; notification: ApnsNotification }[];
  let send: ReturnType<typeof vi.fn>;

  function service(
    options: {
      withKeys?: boolean;
      rows?: unknown[];
      ledger?: Partial<LedgerRepository>;
    } = {},
  ): PushService {
    const push = new PushService(
      config(options.withKeys ?? true),
      store as unknown as PushStore,
      (options.ledger ?? {}) as LedgerRepository,
      fakeDb(options.rows ?? []),
    );
    if (options.withKeys ?? true) {
      Object.assign(push, {
        client: { send, close: vi.fn() } as unknown as ApnsClient,
      });
    }
    return push;
  }

  beforeEach(() => {
    sent = [];
    send = vi.fn(
      (_env: string, token: string, notification: ApnsNotification) => {
        sent.push({ token, notification });
        return Promise.resolve({ ok: true });
      },
    );
    store = {
      listDevices: vi
        .fn()
        .mockResolvedValue([
          device('a'.repeat(64)),
          device('b'.repeat(64), { approval_new: false }),
        ]),
      deleteDevice: vi.fn(),
      activityTokensFor: vi.fn().mockResolvedValue([]),
      startTokens: vi.fn().mockResolvedValue([]),
      deleteActivityToken: vi.fn(),
    };
  });

  it('sin claves APNs queda apagado: no toca la base ni Apple', async () => {
    const push = service({ withKeys: false });
    expect(push.enabled).toBe(false);
    await push.onApprovalCreated({
      requestId: 'r1',
      toolName: 'sendEmail',
      level: 'confirm',
    });
    expect(store.listDevices).not.toHaveBeenCalled();
    expect(await push.sendTest()).toEqual({
      enabled: false,
      sent: 0,
      failed: 0,
    });
  });

  it('respeta las preferencias de cada iPhone', async () => {
    const push = service({ rows: [{ planSummary: 'Responder a Martínez' }] });
    await push.onApprovalCreated({
      requestId: 'r1',
      toolName: 'sendEmail',
      level: 'confirm',
    });
    expect(sent.map((s) => s.token)).toEqual(['a'.repeat(64)]);
    expect(JSON.stringify(sent[0]?.notification.body)).toContain(
      'Responder a Martínez',
    );
  });

  it('notify_executed está apagado por defecto', async () => {
    const push = service();
    await push.onActionNotified({
      requestId: 'r',
      toolName: 'readEmails',
      actor: 'agent',
    });
    expect(sent).toHaveLength(0);
  });

  it('borra un token que Apple da por muerto', async () => {
    send.mockResolvedValueOnce({
      ok: false,
      status: 410,
      reason: 'Unregistered',
      invalidToken: true,
    });
    const push = service();
    await push.onBudgetThreshold({ ratio: 0.81, threshold: 0.8 });
    expect(store.deleteDevice).toHaveBeenCalledWith('a'.repeat(64));
  });

  it('lo que escribe el owner en el puente no se le notifica a sí mismo', async () => {
    const push = service({ rows: [{ body: 'x', options: null }] });
    await push.onRelayMessage({ id: 'm1', direction: 'in' });
    expect(sent).toHaveLength(0);
    await push.onRelayMessage({ id: 'm2', direction: 'out' });
    expect(sent).toHaveLength(2);
  });

  it('un fallo al enviar nunca se propaga al emisor del evento', async () => {
    store.listDevices.mockRejectedValue(new Error('db caída'));
    const push = service();
    await expect(
      push.onKillSwitch({ reason: null, activatedAt: null }),
    ).resolves.toBeUndefined();
  });

  it('orquestación: sin actividad viva la inicia por push; con actividad, la actualiza', async () => {
    const ledger: Partial<LedgerRepository> = {
      getRun: vi.fn().mockResolvedValue({
        id: 'run1',
        objective: 'Semana de parciales',
        status: 'running',
        parentSessionId: 's',
        finalResponse: null,
        createdAt: new Date('2026-09-26T10:00:00Z'),
        completedAt: null,
      }),
      getTickets: vi.fn().mockResolvedValue([
        {
          id: 't1',
          runId: 'run1',
          description: 'Leer Canvas',
          status: 'pending',
          assignedSubAgentId: null,
          allowedTools: [],
          dependsOn: [],
          result: null,
        },
      ]),
      getComments: vi.fn().mockResolvedValue([]),
    };
    const start: PushActivityTokenRow = {
      token: 's'.repeat(64),
      environment: 'sandbox',
      purpose: 'start',
      kind: null,
      referenceId: null,
      createdAt: new Date(),
    };
    store.startTokens.mockResolvedValue([start]);

    const push = service({ ledger });
    await push.onRunChanged({ runId: 'run1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.notification.body.aps).toMatchObject({
      event: 'start',
      attributes: { kind: 'orchestration', referenceId: 'run1' },
    });

    sent = [];
    store.activityTokensFor.mockResolvedValue([
      {
        ...start,
        token: 'u'.repeat(64),
        purpose: 'update',
        kind: 'orchestration',
        referenceId: 'run1',
      },
    ]);
    await push.onRunChanged({ runId: 'run1' });
    expect(sent[0]?.token).toBe('u'.repeat(64));
    expect(sent[0]?.notification.body.aps).toMatchObject({ event: 'update' });
  });
});
