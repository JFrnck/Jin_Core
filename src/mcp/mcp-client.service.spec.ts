import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  McpUnexpectedResponseError,
  McpUnsupportedServerError,
  UnknownMcpServerError,
} from './errors';
import { McpClientService } from './mcp-client.service';
import type { McpServersConfig } from './mcp.types';

const connectMock = vi.fn();
const listToolsMock = vi.fn();
const callToolMock = vi.fn();
let constructorCalls = 0;

// AGENTS.md 6.3: mockear el SDK externo, mismo criterio que
// embedding-provider.spec.ts con el SDK de OpenAI.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    constructor() {
      constructorCalls += 1;
    }
    connect = connectMock;
    listTools = listToolsMock;
    callTool = callToolMock;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}));

const CONFIG: McpServersConfig = [
  {
    name: 'context7',
    url: 'https://mcp.context7.com/mcp',
    description: 'Documentación oficial de librerías.',
  },
];

function textContent(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

describe('McpClientService.queryDocs', () => {
  beforeEach(() => {
    connectMock.mockReset().mockResolvedValue(undefined);
    listToolsMock.mockReset().mockResolvedValue({
      tools: [{ name: 'resolve-library-id' }, { name: 'get-library-docs' }],
    });
    callToolMock.mockReset();
    constructorCalls = 0;
  });

  it('resuelve el library ID y pide los docs con ese ID (camino feliz)', async () => {
    callToolMock
      .mockResolvedValueOnce(
        textContent(
          '- Title: React\n- Context7-compatible library ID: /facebook/react\n',
        ),
      )
      .mockResolvedValueOnce(textContent('useEffect docs...'));

    const service = new McpClientService(CONFIG);
    const result = await service.queryDocs('react', 'useEffect cleanup');

    expect(result).toBe('useEffect docs...');
    expect(callToolMock).toHaveBeenNthCalledWith(1, {
      name: 'resolve-library-id',
      arguments: { libraryName: 'react' },
    });
    expect(callToolMock).toHaveBeenNthCalledWith(2, {
      name: 'get-library-docs',
      arguments: {
        context7CompatibleLibraryID: '/facebook/react',
        topic: 'useEffect cleanup',
      },
    });
  });

  it('lanza McpUnsupportedServerError si el servidor no expone las tools esperadas', async () => {
    listToolsMock.mockResolvedValue({ tools: [{ name: 'otra-tool' }] });

    const service = new McpClientService(CONFIG);
    await expect(service.queryDocs('react', 'x')).rejects.toThrow(
      McpUnsupportedServerError,
    );
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('lanza McpUnexpectedResponseError si resolve-library-id no devuelve un ID parseable', async () => {
    callToolMock.mockResolvedValueOnce(textContent('no encontré nada.'));

    const service = new McpClientService(CONFIG);
    await expect(service.queryDocs('react', 'x')).rejects.toThrow(
      McpUnexpectedResponseError,
    );
    // Solo se llamó resolve-library-id -- nunca se llegó a pedir docs
    // con un ID inventado.
    expect(callToolMock).toHaveBeenCalledTimes(1);
  });

  it('lanza UnknownMcpServerError si se pide un server que no está en el config, sin conectar', async () => {
    const service = new McpClientService(CONFIG);
    await expect(
      service.queryDocs('react', 'x', 'servidor-inexistente'),
    ).rejects.toThrow(UnknownMcpServerError);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('sin serverName, usa el primero declarado en el config', async () => {
    callToolMock
      .mockResolvedValueOnce(
        textContent('- Context7-compatible library ID: /facebook/react\n'),
      )
      .mockResolvedValueOnce(textContent('docs'));

    const service = new McpClientService(CONFIG);
    await service.queryDocs('react', 'x');

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('cachea la conexión: dos queries seguidas al mismo servidor conectan una sola vez', async () => {
    callToolMock.mockResolvedValue(
      textContent('- Context7-compatible library ID: /facebook/react\n'),
    );

    const service = new McpClientService(CONFIG);
    await service.queryDocs('react', 'a').catch(() => undefined);
    await service.queryDocs('react', 'b').catch(() => undefined);

    expect(constructorCalls).toBe(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('si connect() falla, no queda "envenenado": el siguiente llamado reintenta', async () => {
    connectMock
      .mockRejectedValueOnce(new Error('servidor caído'))
      .mockResolvedValueOnce(undefined);
    callToolMock
      .mockResolvedValueOnce(
        textContent('- Context7-compatible library ID: /facebook/react\n'),
      )
      .mockResolvedValueOnce(textContent('docs'));

    const service = new McpClientService(CONFIG);
    await expect(service.queryDocs('react', 'x')).rejects.toThrow(
      'servidor caído',
    );

    const result = await service.queryDocs('react', 'x');
    expect(result).toBe('docs');
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});
