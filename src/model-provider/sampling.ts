/**
 * Modelos de Anthropic que ya NO aceptan parámetros de muestreo
 * (`temperature` / `top_p` / `top_k`): la API responde 400 con
 * "`temperature` is deprecated for this model". Es la generación nueva:
 * Fable 5/5.1, Mythos 5/5.1, Opus 5, Opus 4.8, Opus 4.7 y Sonnet 5. Opus 4.6,
 * Sonnet 4.6 y Haiku 4.5 todavía los aceptan.
 *
 * Visto en el primer uso real (2026-09-21): el perfil `chat_conversational` va a
 * `claude-sonnet-5`, el provider mandaba `temperature: 0.7` siempre, y el chat
 * caía al fallback en cada mensaje. `reasoning_heavy`, `code_execution_planner`
 * y `vision_analysis` (primary `claude-opus-4-8`) fallaban igual.
 *
 * Se decide por PREFIJO del id, no por igualdad, porque la API puede devolver el
 * id con sufijo de fecha (`claude-sonnet-5-20260601`).
 */
const NO_SAMPLING_PREFIXES: readonly string[] = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
];

export function anthropicModelAcceptsSampling(modelId: string): boolean {
  return !NO_SAMPLING_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}
