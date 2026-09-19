import { JinError } from '../common/errors/jin-error';

/** `config/mcp-servers.yaml` no declara el servidor pedido (fail-fast, AGENTS.md 1.4). */
export class UnknownMcpServerError extends JinError {
  constructor(serverName: string) {
    super(`Servidor MCP "${serverName}" no está en config/mcp-servers.yaml.`, {
      code: 'MCP_UNKNOWN_SERVER',
      httpStatus: 400,
    });
  }
}

/**
 * El servidor no expone las tools que `McpClientService` espera
 * (`resolve-library-id` + `get-library-docs`, spec pública de Context7).
 * Fail-fast en vez de adivinar: mejor un error claro que un resultado
 * silenciosamente vacío o mal armado.
 */
export class McpUnsupportedServerError extends JinError {
  constructor(serverName: string, availableTools: readonly string[]) {
    super(
      `El servidor MCP "${serverName}" no expone las tools esperadas ` +
        `(resolve-library-id/get-library-docs). Tools disponibles: ` +
        `[${availableTools.join(', ')}].`,
      { code: 'MCP_UNSUPPORTED_SERVER', httpStatus: 502 },
    );
  }
}

/** `resolve-library-id` no devolvió ningún ID parseable (formato de respuesta inesperado). */
export class McpUnexpectedResponseError extends JinError {
  constructor(serverName: string, toolName: string) {
    super(
      `El servidor MCP "${serverName}" devolvió una respuesta inesperada para "${toolName}" -- no se pudo extraer un resultado usable.`,
      { code: 'MCP_UNEXPECTED_RESPONSE', httpStatus: 502 },
    );
  }
}
