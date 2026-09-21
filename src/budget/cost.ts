import type { ModelPrices } from '../model-provider/model-provider.types';

// Heurística estándar (≈4 caracteres por token en inglés/español) para
// estimar el input ANTES de llamar al modelo real — no hay forma exacta
// de saber el conteo de tokens sin un tokenizer por vendor, y el guard
// necesita un número ANTES de gastar la llamada real (BLUEPRINT 9.6:
// "verifica presupuesto antes"). Se documenta como aproximación, nunca
// se usa para facturación real (eso viene de `ModelCompletionResponse`,
// tokens reales devueltos por el provider).
const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Un snapshot con fecha (`claude-haiku-4-5-20251001`) es el mismo modelo que su
 * alias (`claude-haiku-4-5`) y tiene el mismo precio. La API devuelve en
 * `response.model` el id CON fecha aunque se lo pida por alias, así que buscar
 * solo por igualdad exacta hacía fallar el cálculo de costo de una llamada que
 * SÍ se ejecutó y se cobró (visto en el primer uso real, 2026-09-21: el chat
 * cayó al fallback Haiku y explotó con "No hay precio configurado").
 *
 * Se acepta únicamente el alias seguido de `-` y un sufijo de fecha numérico
 * (`-YYYYMMDD`), nunca un prefijo suelto: `claude-opus-4` no debe heredar el
 * precio de `claude-opus-4-8`.
 */
function resolvePrice(prices: ModelPrices, modelId: string) {
  const exact = prices[modelId];
  if (exact) return exact;

  const dated = /^(.+)-\d{8}$/.exec(modelId);
  const alias = dated?.[1];
  return alias === undefined ? undefined : prices[alias];
}

/**
 * Costo real en USD de una llamada ya resuelta, usando los tokens
 * reales de `ModelCompletionResponse` (no la estimación de arriba).
 * Un modelId sin precio en `config/models.yaml` → `model_prices` es un
 * error de configuración real (MODEL_ROUTING.md 6.1: "todo modelo pasa
 * por el ModelProvider" — incluye su precio), no un 0 silencioso.
 */
export function computeCostUsd(
  prices: ModelPrices,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = resolvePrice(prices, modelId);
  if (!price) {
    throw new Error(
      `No hay precio configurado para el modelo "${modelId}" en config/models.yaml (model_prices).`,
    );
  }

  const inputCost = (inputTokens / 1_000_000) * price.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * price.outputPerMillion;
  return inputCost + outputCost;
}
