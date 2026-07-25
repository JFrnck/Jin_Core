// Token en su propio archivo (mismo motivo que budget.tokens.ts /
// model-provider.tokens.ts): agent.module.ts importa AgentService
// (consumidor del token), y agent.service.ts necesitaría importar de
// vuelta el módulo si el token viviera ahí.
export const AGENT_CONFIG = Symbol('AGENT_CONFIG');
