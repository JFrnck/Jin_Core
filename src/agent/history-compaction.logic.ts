import { estimateTokens } from '../budget/cost';
import type { ModelMessage } from '../model-provider/model-provider.types';

/**
 * Lógica pura de poda + compresión del historial de chat
 * (docs/RECOMENDACIONES.md #2 + requisito del owner 2026-08-04). Sin
 * red/DB — mismo criterio que agent.logic.ts/budget.logic.ts: todo lo
 * que toca el LLM o `MemoryService` vive en history-compaction.service.ts.
 */

export interface HistoryCompactionConfig {
  readonly maxHistoryTokens: number;
  readonly preserveLastTurns: number;
}

export interface HistoryCompactionPlan {
  readonly toCompact: readonly ModelMessage[];
  readonly toPreserve: readonly ModelMessage[];
}

function messageContentToText(message: ModelMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);
}

export function estimateMessagesTokens(
  messages: readonly ModelMessage[],
): number {
  return messages.reduce(
    (sum, message) => sum + estimateTokens(messageContentToText(message)),
    0,
  );
}

/**
 * Un turno real empieza en `role:'user'` con `content` STRING (el
 * `objective` que arma `AgentService.runTurn` o que reenvía el cliente
 * en `input.history`). El loop de tools también pushea
 * `{role:'user', content: [...]}` para los `tool_result` intermedios
 * (`agent.service.ts`, tras cada tanda de tool calls) — mismo `role`,
 * pero `content` es un array de bloques, nunca un objective nuevo.
 * Contar turnos por `role==='user'` sin este filtro rompería el piso de
 * `preserveLastTurns`: un turno con varias tool calls se contaría como
 * varios turnos distintos.
 */
export function findTurnStartIndices(
  messages: readonly ModelMessage[],
): readonly number[] {
  const indices: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user' && typeof message.content === 'string') {
      indices.push(index);
    }
  });
  return indices;
}

/**
 * Decide si hace falta comprimir y, si es así, dónde cae el corte.
 * `undefined` si no hace falta: el historial estimado ya está bajo
 * `maxHistoryTokens`, o no hay más turnos que `preserveLastTurns` (nada
 * que comprimir sin violar el piso).
 */
export function planHistoryCompaction(
  messages: readonly ModelMessage[],
  config: HistoryCompactionConfig,
): HistoryCompactionPlan | undefined {
  if (estimateMessagesTokens(messages) <= config.maxHistoryTokens) {
    return undefined;
  }

  const turnStarts = findTurnStartIndices(messages);
  if (turnStarts.length <= config.preserveLastTurns) {
    return undefined;
  }

  const boundaryTurnIndex = turnStarts.length - config.preserveLastTurns;
  const boundaryMessageIndex = turnStarts[boundaryTurnIndex];
  if (boundaryMessageIndex === undefined || boundaryMessageIndex === 0) {
    return undefined;
  }

  return {
    toCompact: messages.slice(0, boundaryMessageIndex),
    toPreserve: messages.slice(boundaryMessageIndex),
  };
}

const ROLE_LABELS: Record<ModelMessage['role'], string> = {
  user: 'Usuario',
  assistant: 'Jin',
};

/**
 * Serializa un tramo de `messages` a texto plano legible, para el
 * prompt de compresión y para `MemoryService.consolidate()`. Los
 * bloques `tool_use`/`tool_result` se aplanan a una línea descriptiva —
 * el detalle exacto de cada tool call no es lo que vale la pena
 * recordar de una conversación vieja, el resultado narrado sí.
 */
export function renderMessagesAsTranscript(
  messages: readonly ModelMessage[],
): string {
  return messages
    .map((message) => {
      const label = ROLE_LABELS[message.role];
      if (typeof message.content === 'string') {
        return `${label}: ${message.content}`;
      }
      const rendered = message.content
        .map((block) => {
          if (block.type === 'text') return block.text;
          if (block.type === 'tool_use') {
            return `[llamó a la tool ${block.toolCall.name}]`;
          }
          return `[resultado de tool: ${
            typeof block.output === 'string'
              ? block.output
              : JSON.stringify(block.output)
          }]`;
        })
        .join('\n');
      return `${label}: ${rendered}`;
    })
    .join('\n');
}
