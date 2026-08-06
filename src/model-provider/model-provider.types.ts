/**
 * Los 9 TaskProfiles definidos en `docs/MODEL_ROUTING.md` §2.1 /
 * `config/models.yaml`. Unión literal (no enum) para que un typo en un
 * profile inexistente sea un error de compilación, no de runtime.
 */
export type TaskProfile =
  | 'reasoning_heavy'
  | 'coding_default'
  | 'long_context'
  | 'extraction_fast'
  | 'chat_conversational'
  | 'code_execution_planner'
  | 'memory_consolidation'
  | 'history_compaction'
  | 'vision_analysis';

export interface ModelProfileConfig {
  readonly description: string;
  readonly primary: string;
  readonly fallback: string;
  readonly maxTokensInput: number;
  readonly maxTokensOutput: number;
  readonly temperature: number;
}

export type ModelsConfig = Readonly<Record<TaskProfile, ModelProfileConfig>>;

/**
 * Precio por 1M tokens (`config/models.yaml` → `model_prices`), usado
 * por `src/budget/cost.ts` para calcular el gasto real de cada llamada.
 * Vive acá (no en src/budget/) porque es el mismo archivo YAML que
 * `ModelsConfig` — un solo parser para todo `models.yaml`.
 */
export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

// Keyed por modelId (string libre, no union) — a diferencia de los 8
// TaskProfiles, el conjunto de modelos con precio no está fijo en el
// tipo: `MODEL_ROUTING.md` §6.4 asume que se agregan/deprecan con el
// tiempo sin tocar código.
export type ModelPrices = Readonly<Record<string, ModelPrice>>;

/**
 * Hints del selector (`docs/MODEL_ROUTING.md` §2.2). Todos opcionales:
 * un caller que no sepa nada de contexto/latencia/presupuesto puede
 * llamar `selectModel(profiles, taskProfile)` sin el tercer argumento.
 */
export interface SelectModelHints {
  readonly estimatedInputTokens?: number;
  readonly latencyRequirement?: 'low' | 'normal';
  /** Ratio 0-1 de presupuesto diario restante (1 = nada consumido). */
  readonly budgetRemaining?: number;
}

export interface SelectedModel {
  readonly modelId: string;
  readonly tier: 'primary' | 'fallback';
}

/**
 * Declaración de una tool para tool-use nativo del vendor (Fase 5.1,
 * `src/agent/`). `inputSchema` es JSON Schema — mismo shape que
 * `src/tools/registry.ts` declara por tool, y que cada provider traduce
 * a su propio formato (`input_schema` de Anthropic, `functionDeclarations`
 * de Gemini).
 */
export interface ModelToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** Invocación de tool que el modelo decide hacer — vendor-agnóstico. */
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Bloques de contenido de un mensaje cuando la conversación incluye
 * tool-use (Fase 5.1). Un `ModelMessage.content` de texto plano (el caso
 * de todo caller anterior a esta fase: Telegram, Canvas, Gmail, memoria)
 * sigue siendo un `string` — este union solo aplica cuando el turno
 * necesita representar tool_use/tool_result explícitos.
 */
export type ModelMessageContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly toolCall: ModelToolCall }
  | {
      readonly type: 'tool_result';
      readonly toolCallId: string;
      readonly output: unknown;
      readonly isError?: boolean;
    };

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly ModelMessageContentBlock[];
}

/**
 * Forma de request/response NO especificada en los docs (verificado
 * contra `docs/MODEL_ROUTING.md` — solo describen el selector, no la
 * llamada de completion en sí). Es una decisión de diseño propia,
 * documentada en el plan de esta sesión, no en un ADR — no es una
 * decisión de seguridad, es un contrato interno entre `router.service.ts`
 * y los providers.
 */
export interface ModelCompletionRequest {
  readonly systemPrompt?: string;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens: number;
  readonly temperature: number;
  /** Presente solo si el caller quiere tool-use nativo (Fase 5.1). */
  readonly tools?: readonly ModelToolDeclaration[];
}

/**
 * Por qué el modelo dejó de generar. `'tool_use'` es el único caso donde
 * `toolCalls` viene poblado — el agent loop (`src/agent/`) es el único
 * consumidor de este campo hoy.
 */
export type ModelStopReason = 'end_turn' | 'tool_use' | 'max_tokens';

export interface ModelCompletionResponse {
  readonly content: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly stopReason: ModelStopReason;
}

export interface ModelProviderClient {
  readonly vendor: 'anthropic' | 'google';
  complete(
    modelId: string,
    request: ModelCompletionRequest,
  ): Promise<ModelCompletionResponse>;
}
