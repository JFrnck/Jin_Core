import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadFeatureFlagsConfig,
  parseFeatureFlagsConfig,
} from './feature-flags-config.schema';

describe('parseFeatureFlagsConfig', () => {
  it('parsea un config vacío usando todos los defaults', () => {
    const result = parseFeatureFlagsConfig({});
    expect(result).toEqual({
      integrations: {
        canvas: { enabled: true },
        google: { enabled: true },
        mcp: { enabled: true },
        telegram: { enabled: true },
      },
      modelRouting: {},
      hitlOverrides: {},
    });
  });

  it('parsea un config con las 3 secciones declaradas', () => {
    const result = parseFeatureFlagsConfig({
      integrations: {
        canvas: { enabled: false },
        google: { enabled: true },
        mcp: { enabled: true },
        telegram: { enabled: true },
      },
      modelRouting: { reasoning_heavy: { primary: 'claude-sonnet-5' } },
      hitlOverrides: { sendEmail: 'dual-confirm' },
    });
    expect(result.integrations.canvas.enabled).toBe(false);
    expect(result.modelRouting.reasoning_heavy?.primary).toBe(
      'claude-sonnet-5',
    );
    expect(result.hitlOverrides.sendEmail).toBe('dual-confirm');
  });

  it('lanza (fail-fast) si integrations.canvas.enabled no es booleano', () => {
    expect(() =>
      parseFeatureFlagsConfig({
        integrations: { canvas: { enabled: 'sí' } },
      }),
    ).toThrow('config/feature-flags.yaml inválido');
  });

  it('lanza si hitlOverrides declara un nivel que no es un HitlLevel válido', () => {
    expect(() =>
      parseFeatureFlagsConfig({ hitlOverrides: { sendEmail: 'siempre' } }),
    ).toThrow('config/feature-flags.yaml inválido');
  });
});

describe('loadFeatureFlagsConfig', () => {
  it('carga y parsea el config/feature-flags.yaml real del repo', () => {
    const configPath = join(process.cwd(), 'config', 'feature-flags.yaml');
    const result = loadFeatureFlagsConfig(configPath);

    expect(result.integrations.canvas.enabled).toBe(true);
    expect(result.hitlOverrides).toEqual({});
  });
});
