import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type {
  ModelMessage,
  ModelMessageContentBlock,
} from '../model-provider/model-provider.types';

// Espejo Zod de `ModelMessage`/`ModelMessageContentBlock`
// (`src/model-provider/model-provider.types.ts`, Fase 5.1) — primer
// caller externo (Web/CLI) que envía un historial de turno ya armado, así
// que necesita validarse en runtime, a diferencia de los callers internos
// (Telegram/orquestador) que construyen el `ModelMessage[]` en TS
// directamente. Reusado por `chat.controller.ts` (REST) y
// `chat.gateway.ts` (WS) — mismo body, dos transportes.
const ModelToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

const ModelMessageContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), toolCall: ModelToolCallSchema }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    output: z.unknown(),
    isError: z.boolean().optional(),
  }),
]);

export const ModelMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(ModelMessageContentBlockSchema)]),
});

export const ChatBodySchema = z.object({
  sessionId: z.string().min(1),
  objective: z.string().min(1),
  history: z.array(ModelMessageSchema).optional(),
});

export type ChatBody = z.infer<typeof ChatBodySchema>;

// DTO nestjs-zod (Fase 6.1.1) — solo lo usa `chat.controller.ts` (REST).
// `chat.gateway.ts` sigue con `ChatBodySchema.safeParse()` a mano: el
// handshake WS no pasa por el pipeline de pipes de Nest.
export class ChatDto extends createZodDto(ChatBodySchema) {}

function toContentBlock(
  block: z.infer<typeof ModelMessageContentBlockSchema>,
): ModelMessageContentBlock {
  if (block.type !== 'tool_result') {
    return block;
  }
  // Zod infiere `isError?: boolean | undefined` para un campo opcional —
  // incompatible con `exactOptionalPropertyTypes` contra el target, que
  // exige que la clave esté ausente en vez de presente-con-undefined
  // (mismo criterio que `google.module.ts`).
  return {
    type: 'tool_result',
    toolCallId: block.toolCallId,
    output: block.output,
    ...(block.isError !== undefined ? { isError: block.isError } : {}),
  };
}

/**
 * Convierte el body ya validado por `ChatBodySchema` al tipo real que
 * consume `AgentService.runTurn()` — separado de la validación porque
 * Zod y `ModelMessage`/`ModelMessageContentBlock` divergen en cómo
 * representan "campo opcional ausente" bajo `exactOptionalPropertyTypes`.
 */
export function toModelMessages(
  history: ChatBody['history'],
): readonly ModelMessage[] | undefined {
  if (!history) return undefined;
  return history.map((message) => ({
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map(toContentBlock),
  }));
}
