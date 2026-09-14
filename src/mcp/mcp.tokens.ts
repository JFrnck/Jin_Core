// Mismo motivo que MODELS_CONFIG (model-provider.tokens.ts): token en
// su propio archivo para evitar un import circular entre mcp.module.ts
// y mcp-client.service.ts.
export const MCP_SERVERS_CONFIG = Symbol('MCP_SERVERS_CONFIG');
