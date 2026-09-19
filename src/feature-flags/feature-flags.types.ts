import type { HitlLevel } from '../hitl/types';

export type IntegrationName = 'canvas' | 'google' | 'mcp' | 'telegram';

export interface FeatureFlagsConfig {
  readonly integrations: Readonly<
    Record<IntegrationName, { enabled: boolean }>
  >;
  /** Override opcional del modelo `primary` por TaskProfile (BLUEPRINT 12.3). */
  readonly modelRouting: Readonly<
    Record<string, { primary?: string | undefined }>
  >;
  /** Override de `hitlLevel` declarado por el owner -- ver feature-flags.service.ts para el gate de aprobación. */
  readonly hitlOverrides: Readonly<Record<string, HitlLevel>>;
}
