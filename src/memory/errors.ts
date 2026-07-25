import { YormunError } from '../common/errors/yormun-error';

export class MemoryDbError extends YormunError {
  constructor(message: string, cause?: unknown) {
    super(`Error en la base de datos de memoria: ${message}`, {
      code: 'MEMORY_DB_ERROR',
      httpStatus: 500,
      cause,
    });
  }
}

export class EmbeddingProviderError extends YormunError {
  constructor(message: string, cause?: unknown) {
    super(`Error generando embedding: ${message}`, {
      code: 'MEMORY_EMBEDDING_PROVIDER_ERROR',
      httpStatus: 502,
      cause,
    });
  }
}

export class ConsolidationParseError extends YormunError {
  constructor(rawResponse: string) {
    super(
      `La respuesta del LLM de consolidación no es un JSON válido de entradas de memoria: ${rawResponse.slice(0, 200)}`,
      { code: 'MEMORY_CONSOLIDATION_PARSE_ERROR', httpStatus: 502 },
    );
  }
}
