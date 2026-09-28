import { JinError } from '../common/errors/jin-error';

/** Estados del Executor que le sirven tal cual al owner (no son un fallo del servidor). */
const PASSTHROUGH_STATUSES = new Set([400, 404, 409, 422, 429]);

/**
 * El Executor rechazó o falló una operación de terminal. Los rechazos que el
 * owner puede entender y corregir ("ya hay una sesión", "corre el build
 * primero") conservan su código y su mensaje; lo demás sale como 502.
 */
export class TerminalUpstreamError extends JinError {
  constructor(upstreamStatus: number, message: string) {
    super(message, {
      code: 'TERMINAL_UPSTREAM_ERROR',
      httpStatus: PASSTHROUGH_STATUSES.has(upstreamStatus)
        ? upstreamStatus
        : 502,
    });
  }

  /** Lee `{ message }` del cuerpo de error del Executor (o cae al texto crudo). */
  static async fromResponse(
    response: Response,
  ): Promise<TerminalUpstreamError> {
    const raw = await response.text().catch(() => '');
    let message = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { message?: unknown };
      if (typeof parsed.message === 'string') message = parsed.message;
    } catch {
      // cuerpo no JSON: se usa el texto
    }
    return new TerminalUpstreamError(
      response.status,
      message || `El Executor respondió ${response.status}.`,
    );
  }
}

export class TerminalUnavailableError extends JinError {
  constructor(cause?: unknown) {
    super('No se pudo contactar al Executor para la terminal.', {
      code: 'TERMINAL_EXECUTOR_UNREACHABLE',
      httpStatus: 502,
      cause,
    });
  }
}
