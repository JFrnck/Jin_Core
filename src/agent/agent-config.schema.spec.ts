import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentConfig, parseAgentConfig } from './agent-config.schema';

function validRawConfig(overrides: Record<string, unknown> = {}) {
  return {
    max_iterations_per_turn: 15,
    max_consecutive_tool_failures: 3,
    max_concurrent_sub_agents: 3,
    max_history_tokens: 30_000,
    preserve_last_turns: 6,
    ...overrides,
  };
}

describe('parseAgentConfig', () => {
  it('traduce snake_case del YAML a camelCase de AgentConfig', () => {
    const config = parseAgentConfig(validRawConfig());
    expect(config).toEqual({
      maxIterationsPerTurn: 15,
      maxConsecutiveToolFailures: 3,
      maxConcurrentSubAgents: 3,
      maxHistoryTokens: 30_000,
      preserveLastTurns: 6,
    });
  });

  it('lanza si falta un campo requerido', () => {
    const raw = validRawConfig() as Record<string, unknown>;
    delete raw.max_iterations_per_turn;

    expect(() => parseAgentConfig(raw)).toThrow(/config\/agent\.yaml inválido/);
  });

  it('lanza si un campo numérico es negativo, cero o no entero', () => {
    expect(() =>
      parseAgentConfig(validRawConfig({ max_iterations_per_turn: 0 })),
    ).toThrow();
    expect(() =>
      parseAgentConfig(validRawConfig({ max_consecutive_tool_failures: -1 })),
    ).toThrow();
    expect(() =>
      parseAgentConfig(validRawConfig({ max_iterations_per_turn: 1.5 })),
    ).toThrow();
    expect(() =>
      parseAgentConfig(validRawConfig({ max_concurrent_sub_agents: 0 })),
    ).toThrow();
    expect(() =>
      parseAgentConfig(validRawConfig({ max_history_tokens: 0 })),
    ).toThrow();
  });

  it('lanza si preserve_last_turns es 0: es el piso que garantiza que el turno actual nunca se comprime a sí mismo', () => {
    expect(() =>
      parseAgentConfig(validRawConfig({ preserve_last_turns: 0 })),
    ).toThrow();
    expect(() =>
      parseAgentConfig(validRawConfig({ preserve_last_turns: -1 })),
    ).toThrow();
  });

  it('lanza si el input no tiene la forma esperada en absoluto', () => {
    expect(() => parseAgentConfig({})).toThrow();
    expect(() => parseAgentConfig(null)).toThrow();
  });
});

describe('loadAgentConfig', () => {
  it('carga y valida el config/agent.yaml real del repo sin lanzar', () => {
    const realPath = join(process.cwd(), 'config', 'agent.yaml');
    const config = loadAgentConfig(realPath);

    expect(config.maxIterationsPerTurn).toBe(15);
    expect(config.maxConsecutiveToolFailures).toBe(3);
    expect(config.maxConcurrentSubAgents).toBe(3);
    expect(config.maxHistoryTokens).toBe(30_000);
    expect(config.preserveLastTurns).toBe(6);
  });
});
