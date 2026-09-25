import type { AgentPlan } from './agent.types';

/**
 * Eventos de progreso en vivo de un turno (streaming en el chat web,
 * ver plan de la sesión). Solo se emiten cuando el caller pasa
 * `onProgress` a `AgentService.runTurn()` — Telegram y `POST /api/chat`
 * nunca lo pasan, así que para ellos este módulo no existe en la
 * práctica (mismo comportamiento de siempre, sin streaming).
 */
export type AgentProgressEvent =
  | { readonly type: 'plan'; readonly plan: AgentPlan }
  | {
      readonly type: 'tool-call-started';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool-call-finished';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly outcome: 'success' | 'error' | 'deferred';
      readonly summary?: string;
    }
  | {
      /**
       * `iteration` es el mismo `iterationsUsed` del loop de `runTurn` —
       * el frontend lo usa para distinguir "sigue la misma respuesta" de
       * "esto es texto nuevo de la siguiente vuelta del loop" (el texto
       * de una iteración con tool_use se descarta al pasar a la
       * siguiente, ver `runTurn`). `snapshot` es el texto acumulado
       * completo hasta este punto, no solo el incremento — el consumidor
       * sobrescribe con `snapshot` en vez de concatenar `delta` a mano,
       * evitando duplicados si un evento se reprocesa.
       */
      readonly type: 'text-delta';
      readonly iteration: number;
      readonly delta: string;
      readonly snapshot: string;
    };

export type AgentProgressListener = (event: AgentProgressEvent) => void;
