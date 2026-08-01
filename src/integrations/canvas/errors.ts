import { JinError } from '../../common/errors/jin-error';

/**
 * Error devuelto por la API REST de Canvas LMS (errores HTTP 4xx/5xx).
 */
export class CanvasApiError extends JinError {
  constructor(statusCode: number, message: string) {
    super(`Error en API de Canvas (${statusCode}): ${message}`, {
      code: 'CANVAS_API_ERROR',
      httpStatus: 502,
    });
  }
}

/**
 * Superado el límite estricto de tasa de Canvas (30 req/min).
 */
export class CanvasRateLimitError extends JinError {
  constructor() {
    super('Límite de peticiones a Canvas LMS superado (máximo 30 req/min)', {
      code: 'CANVAS_RATE_LIMIT_EXCEEDED',
      httpStatus: 429,
    });
  }
}
