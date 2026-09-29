// Token en su propio archivo (a diferencia de DB_POOL/DB_CONNECTION,
// que viven dentro de db.module.ts) porque acá sí hay un import
// circular real si vive en model-provider.module.ts: el módulo importa
// ModelRouterService (consumidor del token) y router.service.ts
// importaría el token de vuelta desde el módulo. Separado, ninguno de
// los dos archivos se importa entre sí.
export const MODELS_CONFIG = Symbol('MODELS_CONFIG');
export const CHAT_OPTIONS = Symbol('CHAT_OPTIONS');
