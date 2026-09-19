// Mismo motivo que MODELS_CONFIG/MCP_SERVERS_CONFIG: token en su propio
// archivo para evitar un import circular entre feature-flags.module.ts
// y feature-flags.service.ts.
export const FEATURE_FLAGS_CONFIG = Symbol('FEATURE_FLAGS_CONFIG');
