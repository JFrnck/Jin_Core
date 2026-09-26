import type {
  AgentRunStatus,
  AgentTicketStatus,
} from '../agent/orchestrator.types';
import { PUSH_CATEGORIES, type ApnsNotification } from './push.types';

/**
 * Builders puros de los payloads de APNs (ADR 0014). Separados del servicio
 * para testear el contenido exacto: en particular, que ninguna aprobación
 * lleve acciones de decidir y que el `content-state` de las Live Activities
 * decodifique en la app.
 */

/** Tope de texto del agente en un aviso (mismo criterio que Telegram: truncar, no confiar). */
const MAX_BODY_CHARS = 180;

export function truncate(text: string, max = MAX_BODY_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

interface AlertInput {
  readonly title: string;
  readonly body: string;
  readonly subtitle?: string;
  readonly category: string;
  readonly threadId: string;
  readonly link: string;
  readonly timeSensitive?: boolean;
  readonly collapseId?: string;
  /** La extensión de notificaciones puede reescribirla (opciones del puente). */
  readonly mutable?: boolean;
  readonly extra?: Readonly<Record<string, unknown>>;
}

function alert(input: AlertInput): ApnsNotification {
  return {
    pushType: 'alert',
    priority: 10,
    ...(input.collapseId !== undefined ? { collapseId: input.collapseId } : {}),
    body: {
      aps: {
        alert: {
          title: input.title,
          ...(input.subtitle !== undefined ? { subtitle: input.subtitle } : {}),
          body: input.body,
        },
        sound: 'default',
        category: input.category,
        'thread-id': input.threadId,
        ...(input.timeSensitive
          ? { 'interruption-level': 'time-sensitive' }
          : {}),
        ...(input.mutable ? { 'mutable-content': 1 } : {}),
      },
      link: input.link,
      ...input.extra,
    },
  };
}

// MARK: - Avisos

export function approvalNewPayload(input: {
  requestId: string;
  toolName: string;
  level: 'confirm' | 'dual-confirm';
  planSummary: string | null;
}): ApnsNotification {
  const dual = input.level === 'dual-confirm';
  return alert({
    title: `${dual ? '◆◆ Aprobación dual' : '◆ Aprobación'} · ${input.toolName}`,
    body: truncate(input.planSummary ?? input.toolName),
    subtitle: 'Toca para leer el payload',
    category: PUSH_CATEGORIES.approval,
    threadId: 'approvals',
    link: `jin://approval/${input.requestId}`,
    timeSensitive: true,
    collapseId: input.requestId,
    extra: { requestId: input.requestId },
  });
}

export function approvalExpiringPayload(input: {
  requestId: string;
  toolName: string;
}): ApnsNotification {
  return alert({
    title: `Por vencer · ${input.toolName}`,
    body: 'Sigue esperando tu decisión. Si vence, NO se ejecuta.',
    category: PUSH_CATEGORIES.approval,
    threadId: 'approvals',
    link: `jin://approval/${input.requestId}`,
    timeSensitive: true,
    collapseId: input.requestId,
    extra: { requestId: input.requestId },
  });
}

export function notifyExecutedPayload(input: {
  toolName: string;
  relaxedBy?: string;
}): ApnsNotification {
  return alert({
    title: `Ejecutada · ${input.toolName}`,
    body: input.relaxedBy
      ? `Se ejecutó sola porque el modo ${input.relaxedBy.replace('autonomy:', '')} la relajó.`
      : 'Acción de nivel notify: se ejecutó y queda en el Audit.',
    category: PUSH_CATEGORIES.info,
    threadId: 'activity',
    link: 'jin://audit',
  });
}

export function budgetPayload(input: {
  ratio: number;
  threshold: number;
}): ApnsNotification {
  const percent = Math.round(input.ratio * 100);
  return alert({
    title: input.threshold >= 1 ? 'Presupuesto agotado' : 'Presupuesto al 80 %',
    body:
      input.threshold >= 1
        ? `Gasto de hoy al ${percent} %: los agentes se detienen hasta mañana.`
        : `Gasto de hoy al ${percent} % del límite diario.`,
    category: PUSH_CATEGORIES.info,
    threadId: 'spend',
    link: 'jin://spend',
    timeSensitive: input.threshold >= 1,
  });
}

export function killSwitchPayload(input: {
  reason: string | null;
}): ApnsNotification {
  return alert({
    title: '❄ Agentes congelados',
    body: truncate(
      `Kill switch activado${input.reason ? `: ${input.reason}` : ''}. Reanudar exige mantener pulsado 3 s en Gasto.`,
    ),
    category: PUSH_CATEGORIES.info,
    threadId: 'spend',
    link: 'jin://spend',
    timeSensitive: true,
    collapseId: 'kill-switch',
  });
}

export function bridgeMessagePayload(input: {
  id: string;
  body: string;
  options: readonly string[] | null;
}): ApnsNotification {
  return alert({
    title: 'Claude Code',
    body: truncate(input.body, 400),
    category: PUSH_CATEGORIES.bridge,
    threadId: 'bridge',
    link: 'jin://bridge',
    mutable: (input.options?.length ?? 0) > 0,
    extra: {
      bridgeMessageId: input.id,
      ...(input.options?.length ? { options: [...input.options] } : {}),
    },
  });
}

export function morningSummaryPayload(
  input:
    | { kind: 'summary'; summaryMarkdown: string }
    | { kind: 'failed'; error: string }
    | { kind: 'missing' },
): ApnsNotification {
  const body =
    input.kind === 'summary'
      ? truncate(input.summaryMarkdown.replace(/[*_`#>]/g, ''), 300)
      : input.kind === 'failed'
        ? 'El análisis de la noche falló: hoy no hay resumen. Revisa Canvas en la web.'
        : 'No hubo análisis a medianoche: hoy no hay resumen.';
  return alert({
    title: 'Resumen de la mañana',
    body,
    category: PUSH_CATEGORIES.info,
    threadId: 'morning',
    link: 'jin://home',
  });
}

export function chatDonePayload(input: {
  conversationId: string;
  objective: string;
  ok: boolean;
}): ApnsNotification {
  return alert({
    title: input.ok ? 'Jin terminó' : 'El turno no terminó bien',
    body: truncate(input.objective, 120),
    category: PUSH_CATEGORIES.info,
    threadId: `chat-${input.conversationId}`,
    link: `jin://chat/${input.conversationId}`,
  });
}

export function testPayload(): ApnsNotification {
  return alert({
    title: 'Jin · prueba',
    body: 'Las notificaciones push funcionan.',
    category: PUSH_CATEGORIES.info,
    threadId: 'test',
    link: 'jin://settings',
  });
}

// MARK: - Live Activities

/**
 * ActivityKit decodifica el `content-state` con el `JSONDecoder` por defecto:
 * las fechas van como segundos desde 2001-01-01, no desde 1970.
 */
const APPLE_REFERENCE_EPOCH_SECONDS = 978_307_200;

export function appleDate(date: Date): number {
  return date.getTime() / 1000 - APPLE_REFERENCE_EPOCH_SECONDS;
}

/** Espejo de `JinActivityAttributes.Mark` / `.Phase` (JinActivity en Jin_iOS). */
export type ActivityMark =
  'done' | 'running' | 'pending' | 'conflict' | 'failed';
export type ActivityPhase = 'running' | 'conflict' | 'done' | 'failed';

/** Espejo de `JinActivityAttributes.ContentState`. Opcionales ausentes = nil. */
export interface ActivityContentState {
  readonly title: string;
  readonly detail?: string;
  readonly startsAt?: number;
  readonly endsAt?: number;
  readonly ready: boolean;
  readonly badge?: string;
  readonly tool?: string;
  readonly segments: readonly ActivityMark[];
  readonly agents: readonly { id: string; ticket: string; working: boolean }[];
  readonly phase: ActivityPhase;
}

export interface OrchestrationSnapshot {
  readonly run: {
    readonly objective: string;
    readonly status: AgentRunStatus;
    readonly createdAt: Date;
    readonly completedAt: Date | null;
  };
  readonly tickets: readonly {
    readonly description: string;
    readonly status: AgentTicketStatus;
    readonly assignedSubAgentId: string | null;
    readonly commentKinds: readonly string[];
    readonly lastConflictBody: string | null;
  }[];
}

/**
 * Mismo cálculo que `TimerActivities.orchestrationState` en la app (un
 * segmento por ticket, un punto por sub-agente, fase según conflicto/estado).
 * Si cambia uno, cambia el otro: la fixture de `push.payloads.spec.ts` se
 * decodifica en un test de Jin_iOS.
 */
export function orchestrationContentState(
  snapshot: OrchestrationSnapshot,
): ActivityContentState {
  const { run, tickets } = snapshot;
  const hasOpenConflict = (kinds: readonly string[]) =>
    kinds.includes('conflict') && !kinds.includes('resolution');

  const segments: ActivityMark[] = tickets.map((ticket) => {
    if (hasOpenConflict(ticket.commentKinds)) return 'conflict';
    switch (ticket.status) {
      case 'done':
        return 'done';
      case 'in-progress':
        return 'running';
      case 'failed':
        return 'failed';
      default:
        return 'pending';
    }
  });

  const agents: { id: string; ticket: string; working: boolean }[] = [];
  for (const ticket of tickets) {
    const agent = ticket.assignedSubAgentId;
    if (!agent || agents.some((existing) => existing.id === agent)) continue;
    const own = tickets.filter((t) => t.assignedSubAgentId === agent);
    const current = own.find((t) => t.status === 'in-progress');
    agents.push({
      id: agent,
      ticket: (current ?? own[own.length - 1])?.description ?? '',
      working: current !== undefined,
    });
  }

  let phase: ActivityPhase;
  switch (run.status) {
    case 'running':
    case 'blocked':
      phase =
        segments.includes('conflict') || run.status === 'blocked'
          ? 'conflict'
          : 'running';
      break;
    case 'done':
      phase = segments.includes('failed') ? 'failed' : 'done';
      break;
    default:
      phase = 'failed';
  }
  const finished = phase === 'done' || phase === 'failed';
  const conflictBody =
    phase === 'conflict'
      ? tickets.find((t) => hasOpenConflict(t.commentKinds))?.lastConflictBody
      : null;

  return {
    title: run.objective,
    ...(conflictBody ? { detail: conflictBody } : {}),
    startsAt: appleDate(run.createdAt),
    ...(finished && run.completedAt
      ? { endsAt: appleDate(run.completedAt) }
      : {}),
    ready: finished,
    ...(segments.length > 0
      ? {
          badge: `${segments.filter((s) => s === 'done').length}/${segments.length}`,
        }
      : {}),
    segments,
    agents,
    phase,
  };
}

export function killSwitchContentState(input: {
  reason: string | null;
  activatedAt: Date | null;
}): ActivityContentState {
  return {
    title: 'Agentes congelados',
    ...(input.reason ? { detail: input.reason } : {}),
    ...(input.activatedAt ? { startsAt: appleDate(input.activatedAt) } : {}),
    ready: false,
    badge: 'kill',
    segments: [],
    agents: [],
    phase: 'running',
  };
}

/** Relevancia igual que `JinActivityAttributes.Kind.relevance`. */
export const ACTIVITY_RELEVANCE = {
  dualConfirm: 100,
  killSwitch: 80,
  chatTurn: 60,
  orchestration: 50,
  relaxedMode: 40,
} as const;
export type ActivityKind = keyof typeof ACTIVITY_RELEVANCE;

/** Actualiza (o termina) una Live Activity que la app ya inició. */
export function liveActivityUpdatePayload(input: {
  kind: ActivityKind;
  state: ActivityContentState;
  end?: { dismissAfterSeconds: number };
  alert?: { title: string; body: string };
  now?: Date;
}): ApnsNotification {
  const now = input.now ?? new Date();
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    pushType: 'liveactivity',
    priority: input.alert || input.end ? 10 : 5,
    body: {
      aps: {
        timestamp,
        event: input.end ? 'end' : 'update',
        'content-state': input.state,
        'relevance-score': ACTIVITY_RELEVANCE[input.kind],
        ...(input.end
          ? { 'dismissal-date': timestamp + input.end.dismissAfterSeconds }
          : {}),
        ...(input.alert
          ? { alert: { title: input.alert.title, body: input.alert.body } }
          : {}),
      },
    },
  };
}

/** Inicia una Live Activity con la app cerrada (push-to-start, iOS 17.2+). */
export function liveActivityStartPayload(input: {
  kind: ActivityKind;
  referenceId: string;
  state: ActivityContentState;
  alert: { title: string; body: string };
  now?: Date;
}): ApnsNotification {
  const now = input.now ?? new Date();
  return {
    pushType: 'liveactivity',
    priority: 10,
    body: {
      aps: {
        timestamp: Math.floor(now.getTime() / 1000),
        event: 'start',
        'attributes-type': 'JinActivityAttributes',
        attributes: { kind: input.kind, referenceId: input.referenceId },
        'content-state': input.state,
        'relevance-score': ACTIVITY_RELEVANCE[input.kind],
        alert: { title: input.alert.title, body: input.alert.body },
      },
    },
  };
}
