import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { z } from 'zod';
import { HitlLevelSchema } from '../hitl/types';
import type { FeatureFlagsConfig } from './feature-flags.types';

// Mismo patrón que models-config.schema.ts/mcp-config.schema.ts (Zod +
// js-yaml). A diferencia de esos dos, este se re-lee en caliente
// (`FeatureFlagsService.reload()`), no solo una vez al boot.
const FeatureFlagsYamlSchema = z.object({
  integrations: z
    .object({
      canvas: z.object({ enabled: z.boolean() }),
      google: z.object({ enabled: z.boolean() }),
      mcp: z.object({ enabled: z.boolean() }),
      telegram: z.object({ enabled: z.boolean() }),
    })
    .default({
      canvas: { enabled: true },
      google: { enabled: true },
      mcp: { enabled: true },
      telegram: { enabled: true },
    }),
  modelRouting: z
    .record(z.string(), z.object({ primary: z.string().optional() }))
    .default({}),
  hitlOverrides: z.record(z.string(), HitlLevelSchema).default({}),
});

export function parseFeatureFlagsConfig(raw: unknown): FeatureFlagsConfig {
  const result = FeatureFlagsYamlSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`config/feature-flags.yaml inválido:\n${issues}`);
  }
  return result.data;
}

export function loadFeatureFlagsConfig(filePath: string): FeatureFlagsConfig {
  const fileContents = readFileSync(filePath, 'utf-8');
  const raw = load(fileContents);
  return parseFeatureFlagsConfig(raw);
}
