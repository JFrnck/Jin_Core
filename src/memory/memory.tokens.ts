// Token en su propio archivo (mismo motivo que model-provider.tokens.ts):
// memory.module.ts importa MemoryStore (consumidor del token), y
// store.ts necesitaría importar de vuelta el módulo si el token viviera
// ahí — separado, ninguno de los dos archivos se importa entre sí.
export const MEMORY_DB_PATH = Symbol('MEMORY_DB_PATH');
