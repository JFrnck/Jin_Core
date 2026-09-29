import OpenAI from 'openai';
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

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Traduce un turno vendor-agnóstico a los mensajes de OpenAI. A diferencia
 * de Anthropic/Gemini (que meten el resultado de una tool en un content
 * block dentro del mismo mensaje), OpenAI exige un mensaje `role: 'tool'`
 * propio por cada resultado — un solo `ModelMessage` con varios
 * `tool_result` se expande acá a varios mensajes de OpenAI.
 */
function toOpenAIMessages(messages: readonly ModelMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      result.push(
        message.role === 'assistant'
          ? { role: 'assistant', content: message.content }
          : { role: 'user', content: message.content },
      );
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] =
      [];
    const toolResultMessages: OpenAIMessage[] = [];
    for (const block of message.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.toolCall.id,
          type: 'function',
          function: {
            name: block.toolCall.name,
            arguments: JSON.stringify(block.toolCall.input ?? {}),
          },
        });
      } else {
        toolResultMessages.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          content:
            typeof block.output === 'string'
              ? block.output
              : JSON.stringify(block.output),
        });
      }
    }

    // Los tool_result son la respuesta a llamadas de un turno anterior: van
    // primero. El propio mensaje (texto y/o tool_calls) va después.
    result.push(...toolResultMessages);
    if (textParts.length > 0 || toolCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('') : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }
  return result;
}

function toModelStopReason(
  finishReason: string | null | undefined,
): ModelStopReason {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  // OpenAI no tiene un `stop_reason` de rechazo explícito (a diferencia del
  // `refusal` de Anthropic): un bloqueo de contenido sale como `content_filter`.
  if (finishReason === 'content_filter') return 'refusal';
  return 'end_turn';
}

function parseToolArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments);
  } catch {
    // El modelo mandó JSON inválido en los argumentos: se trata como un
    // input vacío en vez de tirar la respuesta entera — el ejecutor de la
    // tool (src/tools/registry.ts) ya valida el input contra su schema y
    // rechaza uno vacío que no cumpla los campos requeridos.
    return {};
  }
}

/**
 * Cliente de OpenAI (GPT-5.1 y su variante mini), 2026-09-28. Mismo
 * contrato `ModelProviderClient` que Anthropic y Google — ver esos dos
 * providers para el patrón general. Sin streaming propio todavía (como
 * Google): `ModelRouterService.completeOrStream` degrada a `complete()` +
 * un único delta si se elige un modelo de este vendor.
 */
@Injectable()
export class OpenAIProvider implements ModelProviderClient {
  readonly vendor = 'openai' as const;

  private readonly client: OpenAI;

  constructor(@Inject(ConfigService) configService: AppConfigService) {
    this.client = new OpenAI({ apiKey: configService.get('OPENAI_API_KEY') });
  }

  async complete(
    modelId: string,
    request: ModelCompletionRequest,
  ): Promise<ModelCompletionResponse> {
    const messages: OpenAIMessage[] = [
      ...(request.systemPrompt !== undefined
        ? [{ role: 'system' as const, content: request.systemPrompt }]
        : []),
      ...toOpenAIMessages(request.messages),
    ];

    const response = await this.client.chat.completions.create({
      model: modelId,
      messages,
      max_completion_tokens: request.maxOutputTokens,
      // Los modelos de razonamiento (reasoning_effort presente) rechazan
      // temperature — mismo criterio que anthropicModelAcceptsSampling en
      // sampling.ts: un parámetro de muestreo no se manda nunca si el
      // modelo no lo acepta.
      ...(request.effort === undefined
        ? { temperature: request.temperature }
        : { reasoning_effort: request.effort }),
      ...(request.tools !== undefined
        ? {
            tools: request.tools.map(
              (tool): OpenAI.Chat.Completions.ChatCompletionFunctionTool => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              }),
            ),
          }
        : {}),
    });

    const choice = response.choices[0];
    const rawToolCalls = (choice?.message.tool_calls ?? []).filter(
      (
        call,
      ): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
        call.type === 'function',
    );
    const toolCalls: ModelToolCall[] = rawToolCalls.map((call) => ({
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    }));

    return {
      content: choice?.message.content ?? '',
      modelId: response.model,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      stopReason: toModelStopReason(choice?.finish_reason),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}
