/**
 * Notificaciones push de la app iOS (ADR 0014).
 *
 * Push solo AVISA: ningún payload de aprobación lleva acciones para decidir
 * (regla dura del diseño, `Jin Sistema.dc.html` §9). Tocar abre la tarjeta.
 */

export const APNS_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type ApnsEnvironment = (typeof APNS_ENVIRONMENTS)[number];

/**
 * Tipos de aviso, uno por toggle de Ajustes de la app. Ids estables: la app
 * los manda al registrarse y el servidor filtra con ellos.
 */
export const PUSH_KINDS = [
  'approval_new',
  'approval_expiring',
  'notify_executed',
  'budget',
  'kill_switch',
  'bridge_message',
  'morning_summary',
  'chat_done',
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/** Sin preferencia guardada: todo encendido salvo el aviso post-hoc de `notify`. */
export const DEFAULT_PREFERENCES: Readonly<Record<PushKind, boolean>> = {
  approval_new: true,
  approval_expiring: true,
  notify_executed: false,
  budget: true,
  kill_switch: true,
  bridge_message: true,
  morning_summary: true,
  chat_done: true,
};

export function wantsKind(
  preferences: Readonly<Record<string, boolean>>,
  kind: PushKind,
): boolean {
  return preferences[kind] ?? DEFAULT_PREFERENCES[kind];
}

/** Categorías que registra la app (JinUI/PushCoordinator.swift). */
export const PUSH_CATEGORIES = {
  /** Aprobaciones: SIN acciones. Tocar abre la tarjeta. */
  approval: 'JIN_APPROVAL',
  /** Avisos informativos: sin acciones. */
  info: 'JIN_INFO',
  /**
   * Claude Code (mensajería, no HITL): responder con texto. Si la pregunta
   * trae opciones, la extensión de notificaciones agrega un botón por opción.
   */
  bridge: 'JIN_BRIDGE',
} as const;

export const APNS_PUSH_TYPES = ['alert', 'liveactivity', 'background'] as const;
export type ApnsPushType = (typeof APNS_PUSH_TYPES)[number];

/** Un envío listo para `ApnsClient`: qué, a qué tópico y con qué prioridad. */
export interface ApnsNotification {
  readonly pushType: ApnsPushType;
  /** 10 = inmediato; 5 = cuando convenga a la batería. */
  readonly priority: 5 | 10;
  readonly body: Readonly<Record<string, unknown>>;
  /** Reemplaza un aviso anterior con el mismo id (≤64 bytes). */
  readonly collapseId?: string;
  /** Segundos desde epoch; 0 = no reintentar si el iPhone no está. */
  readonly expiration?: number;
}

export type ApnsSendResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: number;
      readonly reason: string;
      /** El token ya no sirve (desinstalada, otro entorno): borrarlo. */
      readonly invalidToken: boolean;
    };
