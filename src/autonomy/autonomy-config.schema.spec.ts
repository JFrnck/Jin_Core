import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadAutonomyConfig,
  parseAutonomyConfig,
} from './autonomy-config.schema';

describe('autonomy-config.schema', () => {
  it('config/autonomy.yaml de la imagen es válido y usa los límites decididos por el owner', () => {
    const cfg = loadAutonomyConfig(
      join(process.cwd(), 'config', 'autonomy.yaml'),
    );
    expect(cfg.auto).toEqual({ defaultHours: 4, maxHours: 24 });
    expect(cfg.semiAuto).toEqual({ defaultHours: 24, maxHours: 72 });
    expect(cfg.maxRelaxedActionsPerHour).toBe(20);
  });

  it('un yaml vacío cae a los defaults SEGUROS, no a "sin límites"', () => {
    const cfg = parseAutonomyConfig(null);
    expect(cfg.auto.maxHours).toBe(24);
    expect(cfg.semiAuto.maxHours).toBe(72);
    expect(cfg.maxRelaxedActionsPerHour).toBe(20);
  });

  it('rechaza un default mayor que el máximo', () => {
    expect(() =>
      parseAutonomyConfig({ auto: { default_hours: 30, max_hours: 24 } }),
    ).toThrow(/default_hours/);
  });

  it('rechaza valores no positivos (no existe "sin caducidad")', () => {
    expect(() =>
      parseAutonomyConfig({ auto: { default_hours: 0, max_hours: 24 } }),
    ).toThrow();
    expect(() =>
      parseAutonomyConfig({
        circuit_breaker: { max_relaxed_actions_per_hour: 0 },
      }),
    ).toThrow();
  });

  it('el archivo yaml existe y no menciona ningún modo por defecto distinto de supervised', () => {
    const raw = readFileSync(
      join(process.cwd(), 'config', 'autonomy.yaml'),
      'utf-8',
    );
    expect(raw).toMatch(/supervised/);
  });
});
