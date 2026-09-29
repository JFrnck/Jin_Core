/**
 * Modelos de Anthropic que ya NO aceptan parámetros de muestreo
 * (`temperature` / `top_p` / `top_k`): la API responde 400 con
 * "`temperature` is deprecated for this model". Es la generación nueva:
 * Fable 5/5.1, Mythos 5/5.1, Opus 5/5.5, Opus 4.8, Opus 4.7, Sonnet 5/5.5.
 * Opus 4.6, Sonnet 4.6 y Haiku 4.5 todavía los aceptan.
 *
 * Visto en el primer uso real (2026-09-21): el perfil `chat_conversational` va a
 * `claude-sonnet-5`, el provider mandaba `temperature: 0.7` siempre, y el chat
 * caía al fallback en cada mensaje. `reasoning_heavy`, `code_execution_planner`
 * y `vision_analysis` (primary `claude-opus-4-8`) fallaban igual.
 *
 * Se decide por PREFIJO del id, no por igualdad, porque la API puede devolver el
 * id con sufijo de fecha (`claude-sonnet-5-20260601`). Por eso 'claude-opus-5' y
 * 'claude-sonnet-5' alcanzan también a los -5.5 sin entrada propia.
 */
const NO_SAMPLING_PREFIXES: readonly string[] = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
];

/**
 * Dentro de la generación sin muestreo, Opus 5.5 y Sonnet 5.5 (2026-09-28)
 * tienen el pensamiento SIEMPRE prendido: `{type:'disabled'}` que hasta
 * Sonnet 5 / Opus 4.7/4.8 apaga el pensamiento, en estos dos la API lo
 * rechaza con 400. Verificado contra la documentación de la plataforma antes
 * de agregarlos al catálogo (`config/models.yaml` → `chat_options`).
 */
const ALWAYS_ON_THINKING_PREFIXES: readonly string[] = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
];

export function anthropicModelAcceptsSampling(modelId: string): boolean {
  return !NO_SAMPLING_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

function hasThinkingAlwaysOn(modelId: string): boolean {
  return ALWAYS_ON_THINKING_PREFIXES.some((prefix) =>
    modelId.startsWith(prefix),
  );
}

/**
 * Fragmento de `messages.create()` para el "esfuerzo" (2026-09-28,
 * preferencia de modelo del owner) — vendor-agnóstico en el tipo
 * (`ModelEffort`), específico acá en cómo se traduce.
 *
 * `undefined` (el caller no pidió un esfuerzo): no se manda nada, el
 * modelo se comporta con su default de siempre.
 *
 * La misma generación que no acepta `temperature` (`NO_SAMPLING_PREFIXES`)
 * es la que tiene "adaptive thinking": `{type:'disabled'}` apaga el
 * pensamiento (aceptado en Sonnet 5 y Opus 4.7/4.8); `{type:'adaptive'}` +
 * `output_config.effort` lo prende con la profundidad pedida. Opus 5.5 y
 * Sonnet 5.5 (`ALWAYS_ON_THINKING_PREFIXES`) rechazan `disabled` siempre —
 * ahí un esfuerzo `low` se manda igual como adaptive con `effort: 'low'`.
 *
 * La generación anterior (Haiku 4.5) no tiene adaptive thinking: usa
 * `budget_tokens` clásico, que tiene que ser < `max_tokens` (mínimo 1024,
 * BLUEPRINT del SDK) — se dimensiona contra el `maxOutputTokens` real de la
 * request para no violar esa cota, y si no entra con margen, se omite en
 * vez de mandar un valor inválido.
 */
type AnthropicEffort = 'low' | 'medium' | 'high';

export function anthropicThinkingParams(
  modelId: string,
  effort: AnthropicEffort | undefined,
  maxOutputTokens: number,
):
  | { thinking: { type: 'disabled' } }
  | {
      thinking: { type: 'adaptive' };
      output_config: { effort: AnthropicEffort };
    }
  | { thinking: { type: 'enabled'; budget_tokens: number } }
  | Record<string, never> {
  if (effort === undefined) return {};

  if (!anthropicModelAcceptsSampling(modelId)) {
    if (effort === 'low' && !hasThinkingAlwaysOn(modelId)) {
      return { thinking: { type: 'disabled' } };
    }
    return { thinking: { type: 'adaptive' }, output_config: { effort } };
  }

  // Haiku 4.5 y anteriores: sin adaptive thinking.
  if (effort === 'low') return {};
  const desiredBudget = effort === 'high' ? 8192 : 2048;
  const budgetTokens = Math.min(desiredBudget, maxOutputTokens - 512);
  if (budgetTokens < 1024) return {};
  return { thinking: { type: 'enabled', budget_tokens: budgetTokens } };
}
