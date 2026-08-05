import { randomBytes } from 'node:crypto';
import { InvalidSessionNonceError } from './errors';
import type { ModelMessage } from '../model-provider/model-provider.types';

// 16 caracteres hex exactos (AGENTS.md 5.1) → 8 bytes, no 16. randomBytes(16)
// produciría 32 caracteres — ver ADR 0004 para el porqué de este detalle.
const SESSION_NONCE_BYTES = 8;
const SESSION_NONCE_RE = /^[0-9a-f]{16}$/;

/**
 * Nonce por sesión de agente (AGENTS.md 5.1): se genera una vez al
 * inicio de cada sesión, no por llamada — todo el contenido envuelto
 * durante esa sesión comparte el mismo nonce.
 */
export function generateSessionNonce(): string {
  return randomBytes(SESSION_NONCE_BYTES).toString('hex');
}

/**
 * Escapa los tres caracteres que permitirían a un payload malicioso
 * cerrar el delimitador antes de tiempo (AGENTS.md 5.1: "Escapa
 * caracteres HTML del contenido (&, <, >) para prevenir escape de
 * delimitador"). El orden importa: `&` primero, o se escaparían dos
 * veces los `&` producidos por escapar `<`/`>`.
 */
function escapeDelimiterChars(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Envuelve contenido de origen externo (correos, PDFs, páginas web,
 * Telegram entrante, Canvas) antes de que entre al contexto de un LLM
 * (AGENTS.md 5.1, golden rule #6 de BLUEPRINT §15). El nonce por sesión
 * es la segunda capa de defensa: aunque un atacante conociera el formato
 * del tag, no puede predecir el nonce específico de esta sesión para
 * fabricar un cierre de tag falso que el system prompt trate como
 * confiable (ver ADR 0004).
 */
export function wrapUntrustedContent(
  content: string,
  source: string,
  sessionNonce: string,
): string {
  if (!SESSION_NONCE_RE.test(sessionNonce)) {
    throw new InvalidSessionNonceError(sessionNonce);
  }

  const escapedContent = escapeDelimiterChars(content);
  const escapedSource = escapeDelimiterChars(source).replace(/"/g, '&quot;');

  return (
    `<untrusted_content_${sessionNonce} source="${escapedSource}">` +
    `${escapedContent}` +
    `</untrusted_content_${sessionNonce}>`
  );
}

/**
 * Sanitización para el segundo caso de uso que exige AGENTS.md 5.1
 * (punto 2): contenido externo indexado en pgvector o en la memoria
 * sqlite-vec, sin envolver en un tag de sesión (no hay una sesión de
 * agente activa en el momento de indexar). Mismo escapado que
 * `wrapUntrustedContent` — si ese contenido se recupera después vía RAG
 * y se re-inserta en un prompt, no debe poder actuar como un cierre de
 * delimitador.
 *
 * Sin consumidor todavía: `src/memory/**` no existe (Fase 5+). Se deja
 * listo para cuando exista, en vez de construirlo sin un caller real
 * (AGENTS.md 1.1 — sin abstracciones prematuras, pero esta función SÍ es
 * un requisito explícito del documento, no una anticipación).
 */
export function sanitizeForIndexing(content: string): string {
  return escapeDelimiterChars(content);
}

const UNTRUSTED_SOURCE_RE = /<untrusted_content_[0-9a-f]{16} source="([^"]*)"/g;

function unescapeDelimiterChars(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Contraparte de lectura de `wrapUntrustedContent` (AGENTS.md 5.1 punto 3:
 * "aparecer en el campo external_inputs_summary... cuando influya en una
 * decisión HITL"). Dado el historial de un turno de agente, extrae qué
 * tools ya ejecutadas (auto/notify, iteraciones previas del mismo turno)
 * dejaron contenido envuelto antes de la tool confirm/dual-confirm que se
 * está clasificando ahora — la traza real de qué pudo influir en la
 * decisión del LLM, no un resumen inventado. Sin consumidor fuera de
 * `agent.service.ts`: `orchestrator.service.ts` no tiene `messages` de LLM
 * en su propio path de `createPendingApproval` (ver plan de esta fase).
 */
export function summarizeUntrustedSources(
  messages: readonly ModelMessage[],
): string | undefined {
  const counts = new Map<string, number>();

  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type !== 'tool_result' || typeof block.output !== 'string') {
        continue;
      }
      for (const match of block.output.matchAll(UNTRUSTED_SOURCE_RE)) {
        const source = unescapeDelimiterChars(match[1] ?? '');
        counts.set(source, (counts.get(source) ?? 0) + 1);
      }
    }
  }

  if (counts.size === 0) return undefined;
  return [...counts.entries()]
    .map(([source, count]) => `${source} (${count})`)
    .join(', ');
}
