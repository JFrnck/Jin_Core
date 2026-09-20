import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { z } from 'zod';

// Mismo patrón que feature-flags-config.schema.ts (Zod + js-yaml, fail-fast
// con mensaje claro). Los valores son operativos, no secretos.
const ModeLimitsSchema = z
  .object({
    default_hours: z.number().int().positive(),
    max_hours: z.number().int().positive(),
  })
  .refine((v) => v.default_hours <= v.max_hours, {
    message: 'default_hours no puede superar max_hours',
  });

const AutonomyYamlSchema = z.object({
  semi_auto: ModeLimitsSchema.default({ default_hours: 24, max_hours: 72 }),
  auto: ModeLimitsSchema.default({ default_hours: 4, max_hours: 24 }),
  // Freno de emergencia: si un modo relajado autoejecuta más de N acciones
  // en una hora (runaway / prompt injection en bucle), vuelve solo a HITL
  // completo y avisa por Telegram.
  circuit_breaker: z
    .object({ max_relaxed_actions_per_hour: z.number().int().positive() })
    .default({ max_relaxed_actions_per_hour: 20 }),
});

export interface AutonomyConfig {
  readonly semiAuto: {
    readonly defaultHours: number;
    readonly maxHours: number;
  };
  readonly auto: { readonly defaultHours: number; readonly maxHours: number };
  readonly maxRelaxedActionsPerHour: number;
}

export function parseAutonomyConfig(raw: unknown): AutonomyConfig {
  const result = AutonomyYamlSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`config/autonomy.yaml inválido:\n${issues}`);
  }
  const c = result.data;
  return {
    semiAuto: {
      defaultHours: c.semi_auto.default_hours,
      maxHours: c.semi_auto.max_hours,
    },
    auto: { defaultHours: c.auto.default_hours, maxHours: c.auto.max_hours },
    maxRelaxedActionsPerHour: c.circuit_breaker.max_relaxed_actions_per_hour,
  };
}

export function loadAutonomyConfig(filePath: string): AutonomyConfig {
  return parseAutonomyConfig(load(readFileSync(filePath, 'utf-8')));
}
