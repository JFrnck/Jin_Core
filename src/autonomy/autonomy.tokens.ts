// Token en su propio archivo (mismo motivo que FEATURE_FLAGS_CONFIG): evita
// un import circular entre autonomy.module.ts y autonomy.service.ts.
export const AUTONOMY_CONFIG = Symbol('AUTONOMY_CONFIG');
