import { Inject, Injectable } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_SERVERS_CONFIG } from './mcp.tokens';
import type { McpServersConfig } from './mcp.types';
import {
  McpUnexpectedResponseError,
  McpUnsupportedServerError,
  UnknownMcpServerError,
} from './errors';

// Nombres de tool documentados públicamente por Context7 para su MCP
// server (resolve-library-id + get-library-docs). NO verificado contra
// el servidor real en este entorno (sin acceso de red) -- si Context7
// cambia su contrato, McpUnsupportedServerError lo va a decir explícito
// en vez de fallar en silencio (AGENTS.md 1.4).
const RESOLVE_LIBRARY_TOOL = 'resolve-library-id';
const GET_DOCS_TOOL = 'get-library-docs';

// Best-effort contra el formato de texto documentado de
// resolve-library-id ("- Context7-compatible library ID: /org/project").
// Si Context7 cambia el formato, esto no encuentra match y
// McpUnexpectedResponseError lo hace explícito -- no hay fallback
// silencioso a un ID adivinado.
const LIBRARY_ID_LINE_RE = /Context7-compatible library ID:\s*(\S+)/i;

// `client.callTool()` puede devolver, además de la forma con `content`
// (la normal para una tool síncrona), la forma de ejecución basada en
// tareas (`toolResult` sin `content`, ver client/index.d.ts) que este
// cliente no usa (no llama a `tasks.callToolStream()`). `unknown` +
// validación en runtime en vez de tipar contra el union completo del
// SDK (AGENTS.md 3.4).
function extractTextContent(result: unknown): string {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('content' in result) ||
    !Array.isArray(result.content)
  ) {
    return '';
  }
  return result.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text',
    )
    .map((block) => block.text)
    .join('\n');
}

/**
 * Cliente MCP para documentación externa (BLUEPRINT §6.4, Fase 7.3, ADR
 * 0008). Solo conoce las 2 operaciones concretas de Context7 -- NUNCA
 * proxea un `toolName` arbitrario elegido por el LLM hacia el servidor
 * remoto (eso sería "capability injection": un servidor MCP comprometido
 * podría exponer una tool mutante bajo un nombre inocente). El texto que
 * SÍ devuelve `queryDocs` es contenido externo no confiable como
 * cualquier otro -- quien lo llama (el executor de `queryExternalDocs`
 * en `Jin_Core/src/mcp/mcp.module.ts`) lo retorna como string plano, y
 * el pipeline existente de `AgentService.handleRealToolCall`
 * (`wrapUntrustedContent`) lo envuelve antes de que llegue al modelo --
 * sin código nuevo en `agent.service.ts`.
 */
@Injectable()
export class McpClientService {
  private readonly clients = new Map<string, Promise<Client>>();

  constructor(
    @Inject(MCP_SERVERS_CONFIG) private readonly servers: McpServersConfig,
  ) {}

  /**
   * Busca documentación de `library` sobre `topic` en el servidor
   * `serverName` (default: el primero declarado en
   * `config/mcp-servers.yaml`).
   */
  async queryDocs(
    library: string,
    topic: string,
    serverName?: string,
  ): Promise<string> {
    const server = this.resolveServerConfig(serverName);
    const client = await this.getOrConnect(server.name, server.url);

    const { tools } = await client.listTools();
    const toolNames = new Set(tools.map((t) => t.name));
    if (!toolNames.has(RESOLVE_LIBRARY_TOOL) || !toolNames.has(GET_DOCS_TOOL)) {
      throw new McpUnsupportedServerError(
        server.name,
        tools.map((t) => t.name),
      );
    }

    const resolveResult = await client.callTool({
      name: RESOLVE_LIBRARY_TOOL,
      arguments: { libraryName: library },
    });
    const resolveText = extractTextContent(resolveResult);
    const match = LIBRARY_ID_LINE_RE.exec(resolveText);
    if (!match?.[1]) {
      throw new McpUnexpectedResponseError(server.name, RESOLVE_LIBRARY_TOOL);
    }
    const libraryId = match[1];

    const docsResult = await client.callTool({
      name: GET_DOCS_TOOL,
      arguments: { context7CompatibleLibraryID: libraryId, topic },
    });
    return extractTextContent(docsResult);
  }

  private resolveServerConfig(
    serverName: string | undefined,
  ): McpServersConfig[number] {
    if (serverName === undefined) {
      const [first] = this.servers;
      if (!first) throw new UnknownMcpServerError('(ninguno configurado)');
      return first;
    }
    const found = this.servers.find((s) => s.name === serverName);
    if (!found) throw new UnknownMcpServerError(serverName);
    return found;
  }

  /**
   * Conecta de forma perezosa y cachea la conexión -- nunca al boot de
   * la app (AGENTS.md 1.4: un servidor MCP caído no debe tumbar el
   * arranque de jin-core). Si la conexión falla, se descarta del cache
   * -- una caída transitoria no debe dejar el servidor "muerto" para el
   * resto del proceso; el próximo llamado reintenta.
   */
  private getOrConnect(serverName: string, url: string): Promise<Client> {
    const cached = this.clients.get(serverName);
    if (cached) return cached;

    const connectPromise = (async () => {
      const client = new Client({ name: 'jin-core', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(url));
      // @ts-expect-error -- incompatibilidad de tipos del propio SDK bajo
      // exactOptionalPropertyTypes: su `Transport.sessionId` se declara
      // `sessionId?: string`, pero StreamableHTTPClientTransport lo
      // implementa como getter `string | undefined` -- ninguna de las
      // dos formas es "nuestro" código, es friction de terceros.
      await client.connect(transport);
      return client;
    })();

    connectPromise.catch(() => this.clients.delete(serverName));
    this.clients.set(serverName, connectPromise);
    return connectPromise;
  }
}
