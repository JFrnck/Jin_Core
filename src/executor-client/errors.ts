import { JinError } from '../common/errors/jin-error';

/**
 * Error devuelto por la API REST del Executor (errores HTTP 4xx/5xx, tanto
 * fallos del tier local como del tier de Modal — el Executor ya normaliza
 * ambos en `POST /execute`).
 */
export class ExecutorApiError extends JinError {
  constructor(statusCode: number, message: string) {
    super(`Error en API del Executor (${statusCode}): ${message}`, {
      code: 'EXECUTOR_API_ERROR',
      httpStatus: 502,
    });
  }
}
