import Anthropic from '@anthropic-ai/sdk';
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
import { anthropicModelAcceptsSampling } from './sampling';

function toAnthropicContent(
  content: ModelMessage['content'],
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((block): Anthropic.ContentBlockParam => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_use',
        id: block.toolCall.id,
        name: block.toolCall.name,
        input: block.toolCall.input,
      };
    }
    return {
      type: 'tool_result',
      tool_use_id: block.toolCallId,
      content:
        typeof block.output === 'string'
          ? block.output
          : JSON.stringify(block.output),
      ...(block.isError !== undefined ? { is_error: block.isError } : {}),
    };
  });
}

function toModelStopReason(
  stopReason: Anthropic.Messages.Message['stop_reason'],
): ModelStopReason {
  if (stopReason === 'tool_use') return 'tool_use';
  if (stopReason === 'max_tokens') return 'max_tokens';
  return 'end_turn';
}

@Injectable()
export class AnthropicProvider implements ModelProviderClient {
  readonly vendor = 'anthropic' as const;

  private readonly client: Anthropic;

  // `@Inject(ConfigService)` explícito: permite tipar el parámetro como
  // el alias `AppConfigService` (get() estricto por Env) sin romper la
  // resolución de DI de Nest, que de otro modo depende del tipo
  // reflejado del constructor (mismo problema encontrado y documentado
  // en Jin_Executor/src/k8s/k8s.service.ts).
  constructor(@Inject(ConfigService) configService: AppConfigService) {
    this.client = new Anthropic({
      apiKey: configService.get('ANTHROPIC_API_KEY'),
    });
  }

  async complete(
    modelId: string,
    request: ModelCompletionRequest,
  ): Promise<ModelCompletionResponse> {
    const response = await this.client.messages.create({
      model: modelId,
      max_tokens: request.maxOutputTokens,
      // Solo si el modelo lo acepta: Sonnet 5, Opus 5/4.8/4.7 y Fable 5 lo
      // rechazan con 400 (ver sampling.ts). Ningún otro parámetro de muestreo
      // se manda nunca.
      ...(anthropicModelAcceptsSampling(modelId)
        ? { temperature: request.temperature }
        : {}),
      // Spread condicional, no `system: request.systemPrompt`: con
      // `exactOptionalPropertyTypes`, el SDK distingue "la clave está
      // ausente" de "la clave está presente con valor undefined", y su
      // tipo (`string | TextBlockParam[]`) no acepta lo segundo.
      ...(request.systemPrompt !== undefined
        ? { system: request.systemPrompt }
        : {}),
      messages: request.messages.map((message) => ({
        role: message.role,
        content: toAnthropicContent(message.content),
      })),
      ...(request.tools !== undefined
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
    });

    const textParts: string[] = [];
    const toolCalls: ModelToolCall[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    return {
      content: textParts.join(''),
      modelId: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: toModelStopReason(response.stop_reason),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }
}
