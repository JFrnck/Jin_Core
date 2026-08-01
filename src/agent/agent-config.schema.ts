import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { z } from 'zod';

export interface AgentConfig {
  readonly maxIterationsPerTurn: number;
  readonly maxConsecutiveToolFailures: number;
  readonly maxConcurrentSubAgents: number;
}

// Espejo snake_case de config/agent.yaml — mismo patrón que
// src/budget/budget-config.schema.ts.
const AgentYamlSchema = z.object({
  max_iterations_per_turn: z.number().int().positive(),
  max_consecutive_tool_failures: z.number().int().positive(),
  max_concurrent_sub_agents: z.number().int().positive(),
});

/**
 * Fail-fast (AGENTS.md 8.4): un `config/agent.yaml` malformado lanza al
 * arrancar, antes de que el loop dependa de un límite indefinido.
 */
export function parseAgentConfig(raw: unknown): AgentConfig {
  const result = AgentYamlSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`config/agent.yaml inválido:\n${issues}`);
  }

  const data = result.data;
  return {
    maxIterationsPerTurn: data.max_iterations_per_turn,
    maxConsecutiveToolFailures: data.max_consecutive_tool_failures,
    maxConcurrentSubAgents: data.max_concurrent_sub_agents,
  };
}

export function loadAgentConfig(filePath: string): AgentConfig {
  const fileContents = readFileSync(filePath, 'utf-8');
  const raw = load(fileContents);
  return parseAgentConfig(raw);
}
