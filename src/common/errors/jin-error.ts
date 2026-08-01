export interface JinErrorOptions {
  /** Código estable para logs/métricas, ej. "HITL_UNKNOWN_TOOL". */
  code: string;
  httpStatus?: number;
  cause?: unknown;
}

/**
 * Base de toda excepción de dominio (AGENTS.md 8.1). Nunca se lanza
 * directamente — cada módulo define sus propias subclases con `code` fijo.
 */
export class JinError extends Error {
  readonly code: string;
  // No usa `?:` — con exactOptionalPropertyTypes, "opcional" significa
  // "puede estar ausente", no "puede ser undefined explícito". Como
  // siempre se asigna (aunque sea con undefined), el tipo es una unión.
  readonly httpStatus: number | undefined;

  constructor(message: string, options: JinErrorOptions) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.code = options.code;
    this.httpStatus = options.httpStatus;
  }
}
