import { JinError } from '../common/errors/jin-error';

/** Estados del Executor que le sirven tal cual al owner (no son un fallo del servidor). */
const PASSTHROUGH_STATUSES = new Set([400, 404, 409, 422, 429]);

/**
 * El Executor rechazó o falló una operación de terminal. Los rechazos que el
 * owner puede entender y corregir ("ya hay una sesión", "corre el build
 * primero") conservan su código y su mensaje; lo demás sale como 502.
 */
export class TerminalUpstreamError extends JinError {
  /**
   * `upstreamCode`: el código del Executor. Solo los del explorador de archivos
   * (`TERMINAL_FS_*`, ej. `TERMINAL_FS_CONFLICT`) se dejan pasar tal cual: la
   * app los necesita para distinguir un conflicto de un error. El resto sigue
   * siendo el genérico.
   */
  constructor(upstreamStatus: number, message: string, upstreamCode?: string) {
    super(message, {
      code: upstreamCode?.startsWith('TERMINAL_FS_')
        ? upstreamCode
        : 'TERMINAL_UPSTREAM_ERROR',
      httpStatus: PASSTHROUGH_STATUSES.has(upstreamStatus)
        ? upstreamStatus
        : upstreamStatus === 413 && upstreamCode?.startsWith('TERMINAL_FS_')
          ? 413
          : 502,
    });
  }

  /** Lee `{ message }` del cuerpo de error del Executor (o cae al texto crudo). */
  static async fromResponse(
    response: Response,
  ): Promise<TerminalUpstreamError> {
    const raw = await response.text().catch(() => '');
    let message = raw.slice(0, 300);
    let code: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { message?: unknown; code?: unknown };
      if (typeof parsed.message === 'string') message = parsed.message;
      if (typeof parsed.code === 'string') code = parsed.code;
    } catch {
      // cuerpo no JSON: se usa el texto
    }
    return new TerminalUpstreamError(
      response.status,
      message || `El Executor respondió ${response.status}.`,
      code,
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
