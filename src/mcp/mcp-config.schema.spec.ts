import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadMcpServersConfig,
  parseMcpServersConfig,
} from './mcp-config.schema';

function validRawConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    servers: [
      {
        name: 'context7',
        url: 'https://mcp.context7.com/mcp',
        description: 'Documentación oficial de librerías.',
        ...overrides,
      },
    ],
  };
}

describe('parseMcpServersConfig', () => {
  it('parsea un config válido', () => {
    const result = parseMcpServersConfig(validRawConfig());
    expect(result).toEqual([
      {
        name: 'context7',
        url: 'https://mcp.context7.com/mcp',
        description: 'Documentación oficial de librerías.',
      },
    ]);
  });

  it('lanza (fail-fast) si "servers" está vacío', () => {
    expect(() => parseMcpServersConfig({ servers: [] })).toThrow(
      'config/mcp-servers.yaml inválido',
    );
  });

  it('lanza si falta "servers"', () => {
    expect(() => parseMcpServersConfig({})).toThrow(
      'config/mcp-servers.yaml inválido',
    );
  });

  it('lanza si "url" no es una URL válida', () => {
    expect(() =>
      parseMcpServersConfig(validRawConfig({ url: 'no-es-una-url' })),
    ).toThrow('config/mcp-servers.yaml inválido');
  });

  it('lanza si falta "description"', () => {
    const raw = validRawConfig();
    delete (raw as { servers: [{ description?: string }] }).servers[0]
      .description;
    expect(() => parseMcpServersConfig(raw)).toThrow(
      'config/mcp-servers.yaml inválido',
    );
  });
});

describe('loadMcpServersConfig', () => {
  it('carga y parsea el config/mcp-servers.yaml real del repo', () => {
    const configPath = join(process.cwd(), 'config', 'mcp-servers.yaml');
    const result = loadMcpServersConfig(configPath);

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]?.name).toBe('context7');
  });
});
