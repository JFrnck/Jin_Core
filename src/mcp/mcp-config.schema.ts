import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { z } from 'zod';
import type { McpServersConfig } from './mcp.types';

// Mismo patrón que src/model-provider/models-config.schema.ts:
// `servers` es un array abierto (no un set fijo de nombres, a
// diferencia de los 9 TaskProfiles) porque el conjunto de servidores
// MCP permitidos crece/decrece sin que el código tenga que cambiar —
// solo este YAML.
const McpServerYamlSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  description: z.string().min(1),
});

const McpServersYamlSchema = z.object({
  servers: z.array(McpServerYamlSchema).min(1),
});

export function parseMcpServersConfig(raw: unknown): McpServersConfig {
  const result = McpServersYamlSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`config/mcp-servers.yaml inválido:\n${issues}`);
  }
  return result.data.servers;
}

export function loadMcpServersConfig(filePath: string): McpServersConfig {
  const fileContents = readFileSync(filePath, 'utf-8');
  const raw = load(fileContents);
  return parseMcpServersConfig(raw);
}
