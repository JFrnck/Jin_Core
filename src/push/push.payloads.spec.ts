import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appleDate,
  approvalExpiringPayload,
  approvalNewPayload,
  bridgeMessagePayload,
  liveActivityStartPayload,
  liveActivityUpdatePayload,
  orchestrationContentState,
  truncate,
  type OrchestrationSnapshot,
} from './push.payloads';
import { PUSH_CATEGORIES } from './push.types';

/**
 * Misma fixture que decodifica Jin_iOS (JinUITests/PushContentStateTests.swift):
 * si cambia la forma del `content-state`, fallan los dos lados.
 */
const FIXTURE_PATH = join(
  __dirname,
  '__fixtures__',
  'orchestration-content-state.json',
);

const SNAPSHOT: OrchestrationSnapshot = {
  run: {
    objective: 'Preparar semana de parciales',
    status: 'running',
    createdAt: new Date('2026-09-26T10:00:00.000Z'),
    completedAt: null,
  },
  tickets: [
    {
      description: 'Material de laboratorio',
      status: 'done',
      assignedSubAgentId: 'sub-3',
      commentKinds: ['result'],
      lastConflictBody: null,
    },
    {
      description: 'Bloque de estudio',
      status: 'in-progress',
      assignedSubAgentId: 'sub-1',
      commentKinds: [],
      lastConflictBody: null,
    },
    {
      description: 'Mover asesoría',
      status: 'blocked',
      assignedSubAgentId: 'sub-2',
      commentKinds: ['conflict'],
      lastConflictBody: 'Choca con la asesoría',
    },
    {
      description: 'Avisar al grupo',
      status: 'pending',
      assignedSubAgentId: null,
      commentKinds: [],
      lastConflictBody: null,
    },
  ],
};

describe('avisos', () => {
  it('una aprobación NUNCA lleva acciones de decidir: categoría sin acciones y solo un enlace', () => {
    for (const payload of [
      approvalNewPayload({
        requestId: 'r1',
        toolName: 'sendEmail',
        level: 'dual-confirm',
        planSummary: 'x',
      }),
      approvalExpiringPayload({ requestId: 'r1', toolName: 'sendEmail' }),
    ]) {
      const aps = payload.body.aps as Record<string, unknown>;
      expect(aps.category).toBe(PUSH_CATEGORIES.approval);
      expect(aps['mutable-content']).toBeUndefined();
      expect(JSON.stringify(payload.body)).not.toMatch(
        /approve|reject|aprobar|rechazar/i,
      );
      expect(payload.body.link).toBe('jin://approval/r1');
    }
  });

  it('marca dual vs confirm y trunca el texto del agente', () => {
    const dual = approvalNewPayload({
      requestId: 'r',
      toolName: 'deleteEvent',
      level: 'dual-confirm',
      planSummary: 'a'.repeat(500),
    });
    const alert = (dual.body.aps as { alert: { title: string; body: string } })
      .alert;
    expect(alert.title).toBe('◆◆ Aprobación dual · deleteEvent');
    expect(alert.body.length).toBeLessThanOrEqual(180);
    expect(truncate('  hola \n  mundo ')).toBe('hola mundo');
  });

  it('Claude Code con opciones: categoría del puente y mutable para que la extensión ponga los botones', () => {
    const withOptions = bridgeMessagePayload({
      id: 'm1',
      body: '¿Sigo con el deploy?',
      options: ['Sí', 'No', 'Esperar'],
    });
    const plain = bridgeMessagePayload({
      id: 'm2',
      body: 'Build listo',
      options: null,
    });
    expect(
      (withOptions.body.aps as Record<string, unknown>)['mutable-content'],
    ).toBe(1);
    expect(withOptions.body).toMatchObject({
      bridgeMessageId: 'm1',
      options: ['Sí', 'No', 'Esperar'],
    });
    expect(
      (plain.body.aps as Record<string, unknown>)['mutable-content'],
    ).toBeUndefined();
    expect((plain.body.aps as Record<string, unknown>).category).toBe(
      PUSH_CATEGORIES.bridge,
    );
  });
});

describe('Live Activities', () => {
  it('fechas en segundos desde 2001 (el JSONDecoder por defecto de ActivityKit)', () => {
    expect(appleDate(new Date('2001-01-01T00:00:00Z'))).toBe(0);
    expect(appleDate(new Date('2026-09-26T10:00:00Z'))).toBe(812109600);
  });

  it('content-state de la orquestación = fixture compartida con Jin_iOS', () => {
    const state = orchestrationContentState(SNAPSHOT);
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
    expect(state).toEqual(fixture);
    expect(state.segments).toEqual(['done', 'running', 'conflict', 'pending']);
    expect(state.phase).toBe('conflict');
    expect(state.badge).toBe('1/4');
  });

  it('run terminado: hora de fin y `ready`; con un ticket fallido, "failed"', () => {
    const done = orchestrationContentState({
      run: {
        ...SNAPSHOT.run,
        status: 'done',
        completedAt: new Date('2026-09-26T10:12:00Z'),
      },
      tickets: SNAPSHOT.tickets.map((t) => ({
        ...t,
        status: 'done' as const,
        commentKinds: [],
      })),
    });
    expect(done).toMatchObject({ phase: 'done', ready: true, badge: '4/4' });
    expect(done.endsAt).toBe(appleDate(new Date('2026-09-26T10:12:00Z')));

    const failed = orchestrationContentState({
      run: { ...SNAPSHOT.run, status: 'done', completedAt: new Date() },
      tickets: [
        { ...SNAPSHOT.tickets[0]!, status: 'failed', commentKinds: [] },
      ],
    });
    expect(failed.phase).toBe('failed');
  });

  it('update / end / start llevan lo que pide ActivityKit', () => {
    const state = orchestrationContentState(SNAPSHOT);
    const now = new Date('2026-09-26T10:05:00Z');
    const update = liveActivityUpdatePayload({
      kind: 'orchestration',
      state,
      now,
    });
    expect(update).toMatchObject({ pushType: 'liveactivity', priority: 5 });
    expect(update.body.aps).toMatchObject({
      event: 'update',
      timestamp: 1790417100,
      'relevance-score': 50,
    });

    const end = liveActivityUpdatePayload({
      kind: 'orchestration',
      state,
      now,
      end: { dismissAfterSeconds: 4 },
    });
    expect(end.body.aps).toMatchObject({
      event: 'end',
      'dismissal-date': 1790417104,
    });

    const start = liveActivityStartPayload({
      kind: 'killSwitch',
      referenceId: 'kill',
      state: {
        title: 'Agentes congelados',
        ready: false,
        segments: [],
        agents: [],
        phase: 'running',
      },
      alert: { title: 'x', body: 'y' },
      now,
    });
    expect(start.body.aps).toMatchObject({
      event: 'start',
      'attributes-type': 'JinActivityAttributes',
      attributes: { kind: 'killSwitch', referenceId: 'kill' },
    });
  });
});
