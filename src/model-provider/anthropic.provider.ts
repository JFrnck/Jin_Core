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
  ModelStreamDeltaListener,
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
  if (stopReason === 'refusal') return 'refusal';
  return 'end_turn';
}

/** Mapea la respuesta cruda del SDK al contrato propio — compartido por `complete()` y `completeStream()` (`.finalMessage()` del stream trae el mismo shape que `.create()`). */
function toCompletionResponse(
  message: Anthropic.Messages.Message,
): ModelCompletionResponse {
  const textParts: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  return {
    content: textParts.join(''),
    modelId: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    stopReason: toModelStopReason(message.stop_reason),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
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

  // Sin anotación de retorno explícita: `MessageCreateParamsBase` no está
  // exportado por el SDK (solo sus subtipos streaming/non-streaming) — el
  // shape estructural inferido acá es válido para `.create()` Y `.stream()`.
  private buildCreateParams(modelId: string, request: ModelCompletionRequest) {
    return {
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
    };
  }

  async complete(
    modelId: string,
    request: ModelCompletionRequest,
  ): Promise<ModelCompletionResponse> {
    const response = await this.client.messages.create(
      this.buildCreateParams(modelId, request),
    );
    return toCompletionResponse(response);
  }

  /**
   * Variante en streaming (Fase de streaming en vivo del chat web — ver
   * plan de la sesión). Reenvía cada delta de texto por `onDelta` a medida
   * que llega, y resuelve con el MISMO shape que `complete()` una vez que
   * el SDK arma el `Message` final (`.finalMessage()`) — así
   * `BudgetGuardedModelRouter`/`FailoverService` no necesitan saber que
   * hubo streaming de por medio. Sin try/catch propio: si `finalMessage()`
   * rechaza (error de red, rate limit, refusal a mitad de stream, etc.),
   * el rechazo se propaga tal cual al caller.
   */
  async completeStream(
    modelId: string,
    request: ModelCompletionRequest,
    onDelta: ModelStreamDeltaListener,
  ): Promise<ModelCompletionResponse> {
    const stream = this.client.messages.stream(
      this.buildCreateParams(modelId, request),
    );
    stream.on('text', (delta, snapshot) => onDelta(delta, snapshot));
    const finalMessage = await stream.finalMessage();
    return toCompletionResponse(finalMessage);
  }
}
