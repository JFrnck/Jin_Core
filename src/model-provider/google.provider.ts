import { randomUUID } from 'node:crypto';
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Part,
} from '@google/genai';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfigService } from '../config';
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelMessage,
  ModelProviderClient,
  ModelStopReason,
  ModelToolCall,
} from './model-provider.types';

/**
 * Gemini exige `name` en `functionResponse` (además del `id`) para
 * correlacionar la respuesta con su llamada — a diferencia de Anthropic,
 * que solo necesita `tool_use_id`. En vez de cargar `toolName` en el tipo
 * de dominio (vendor-agnóstico a propósito), se reconstruye acá un mapa
 * `toolCallId → name` escaneando los `tool_use` de los mensajes de la
 * misma request — la traducción específica del vendor vive en el vendor.
 */
function buildToolCallIdToNameMap(
  messages: ModelCompletionRequest['messages'],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        map.set(block.toolCall.id, block.toolCall.name);
      }
    }
  }
  return map;
}

function toGeminiParts(
  content: ModelMessage['content'],
  toolCallIdToName: ReadonlyMap<string, string>,
): Part[] {
  if (typeof content === 'string') {
    return [{ text: content }];
  }
  return content.map((block): Part => {
    if (block.type === 'text') {
      return { text: block.text };
    }
    if (block.type === 'tool_use') {
      return {
        functionCall: {
          id: block.toolCall.id,
          name: block.toolCall.name,
          args: (block.toolCall.input ?? {}) as Record<string, unknown>,
        },
      };
    }
    return {
      functionResponse: {
        id: block.toolCallId,
        name: toolCallIdToName.get(block.toolCallId) ?? block.toolCallId,
        response: block.isError
          ? { error: block.output }
          : { output: block.output },
      },
    };
  });
}

function toModelStopReason(
  hasFunctionCalls: boolean,
  finishReason: string | undefined,
): ModelStopReason {
  if (hasFunctionCalls) return 'tool_use';
  if (finishReason === 'MAX_TOKENS') return 'max_tokens';
  return 'end_turn';
}

@Injectable()
export class GoogleProvider implements ModelProviderClient {
  readonly vendor = 'google' as const;

  private readonly client: GoogleGenAI;

  constructor(@Inject(ConfigService) configService: AppConfigService) {
    this.client = new GoogleGenAI({
      apiKey: configService.get('GEMINI_API_KEY'),
    });
  }

  async complete(
    modelId: string,
    request: ModelCompletionRequest,
  ): Promise<ModelCompletionResponse> {
    const toolCallIdToName = buildToolCallIdToNameMap(request.messages);

    const response = await this.client.models.generateContent({
      model: modelId,
      contents: request.messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: toGeminiParts(message.content, toolCallIdToName),
      })),
      config: {
        // Mismo motivo que en anthropic.provider.ts: exactOptionalPropertyTypes
        // no acepta `systemInstruction: undefined` explícito.
        ...(request.systemPrompt !== undefined
          ? { systemInstruction: request.systemPrompt }
          : {}),
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        ...(request.tools !== undefined
          ? {
              tools: [
                {
                  functionDeclarations: request.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parametersJsonSchema: tool.inputSchema,
                  })),
                },
              ],
              toolConfig: {
                functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
              },
            }
          : {}),
      },
    });

    const geminiToolCalls = response.functionCalls ?? [];
    const toolCalls: ModelToolCall[] = geminiToolCalls.map((call) => ({
      id: call.id ?? randomUUID(),
      name: call.name ?? '',
      input: call.args ?? {},
    }));

    return {
      content: response.text ?? '',
      modelId: response.modelVersion ?? modelId,
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      stopReason: toModelStopReason(
        toolCalls.length > 0,
        response.candidates?.[0]?.finishReason,
      ),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}
