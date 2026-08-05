import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { z } from 'zod';
import type {
  ModelPrice,
  ModelPrices,
  ModelProfileConfig,
  ModelsConfig,
} from './model-provider.types';

// Espejo de la forma snake_case del YAML (docs/MODEL_ROUTING.md §2.1) —
// se traduce a camelCase (ModelProfileConfig) recién al final de
// parseModelsConfig, para que el resto del código nunca vea snake_case.
const ModelProfileYamlSchema = z.object({
  description: z.string().min(1),
  primary: z.string().min(1),
  fallback: z.string().min(1),
  max_tokens_input: z.number().int().positive(),
  max_tokens_output: z.number().int().positive(),
  temperature: z.number().min(0).max(2),
});

// Los 9 profiles son fijos y requeridos (no un mapa abierto): un typo en
// el nombre de un profile en el YAML debe fallar la validación de
// startup, no crear silenciosamente un profile con nombre distinto al
// que el código espera.
const ModelsYamlSchema = z.object({
  profiles: z.object({
    reasoning_heavy: ModelProfileYamlSchema,
    coding_default: ModelProfileYamlSchema,
    long_context: ModelProfileYamlSchema,
    extraction_fast: ModelProfileYamlSchema,
    chat_conversational: ModelProfileYamlSchema,
    code_execution_planner: ModelProfileYamlSchema,
    memory_consolidation: ModelProfileYamlSchema,
    history_compaction: ModelProfileYamlSchema,
    vision_analysis: ModelProfileYamlSchema,
  }),
});

function toModelProfileConfig(
  raw: z.infer<typeof ModelProfileYamlSchema>,
): ModelProfileConfig {
  return {
    description: raw.description,
    primary: raw.primary,
    fallback: raw.fallback,
    maxTokensInput: raw.max_tokens_input,
    maxTokensOutput: raw.max_tokens_output,
    temperature: raw.temperature,
  };
}

/**
 * Fail-fast (AGENTS.md 8.4): un `config/models.yaml` malformado lanza
 * con un mensaje claro en vez de dejar que un `undefined` se propague
 * silenciosamente hasta la primera llamada a un modelo.
 */
export function parseModelsConfig(raw: unknown): ModelsConfig {
  const result = ModelsYamlSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`config/models.yaml inválido:\n${issues}`);
  }

  const { profiles } = result.data;
  return {
    reasoning_heavy: toModelProfileConfig(profiles.reasoning_heavy),
    coding_default: toModelProfileConfig(profiles.coding_default),
    long_context: toModelProfileConfig(profiles.long_context),
    extraction_fast: toModelProfileConfig(profiles.extraction_fast),
    chat_conversational: toModelProfileConfig(profiles.chat_conversational),
    code_execution_planner: toModelProfileConfig(
      profiles.code_execution_planner,
    ),
    memory_consolidation: toModelProfileConfig(profiles.memory_consolidation),
    history_compaction: toModelProfileConfig(profiles.history_compaction),
    vision_analysis: toModelProfileConfig(profiles.vision_analysis),
  };
}

export function loadModelsConfig(filePath: string): ModelsConfig {
  const fileContents = readFileSync(filePath, 'utf-8');
  const raw = load(fileContents);
  return parseModelsConfig(raw);
}

// `model_prices` es un mapa abierto (no 8 claves fijas como `profiles`):
// el conjunto de modelos con precio crece/decrece con el tiempo
// (MODEL_ROUTING.md §6.4) sin que el código tenga que cambiar.
const ModelPriceYamlSchema = z.object({
  input_per_million: z.number().min(0),
  output_per_million: z.number().min(0),
});

const ModelPricesYamlSchema = z.object({
  model_prices: z.record(z.string(), ModelPriceYamlSchema),
});

function toModelPrice(raw: z.infer<typeof ModelPriceYamlSchema>): ModelPrice {
  return {
    inputPerMillion: raw.input_per_million,
    outputPerMillion: raw.output_per_million,
  };
}

/**
 * Fail-fast (AGENTS.md 8.4), mismo criterio que `parseModelsConfig`.
 * Parser separado (no fusionado con `ModelsYamlSchema`) porque
 * `profiles` y `model_prices` tienen ciclos de vida y consumidores
 * distintos (model-provider vs. src/budget) aunque compartan archivo.
 */
export function parseModelPrices(raw: unknown): ModelPrices {
  const result = ModelPricesYamlSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`config/models.yaml (model_prices) inválido:\n${issues}`);
  }

  return Object.fromEntries(
    Object.entries(result.data.model_prices).map(([modelId, price]) => [
      modelId,
      toModelPrice(price),
    ]),
  );
}

export function loadModelPrices(filePath: string): ModelPrices {
  const fileContents = readFileSync(filePath, 'utf-8');
  const raw = load(fileContents);
  return parseModelPrices(raw);
}
