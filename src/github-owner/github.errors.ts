import { JinError } from '../common/errors/jin-error';

/** Estados del Executor que le sirven tal cual al owner (apagado, repo no permitido, conflicto, datos inválidos…). */
const PASSTHROUGH_STATUSES = new Set([400, 403, 404, 409, 422, 429, 503]);

/** El Executor rechazó o falló una operación de GitHub: conserva su mensaje (ya viene sin tokens). */
export class GithubUpstreamError extends JinError {
  constructor(upstreamStatus: number, message: string) {
    super(message, {
      code: 'GITHUB_UPSTREAM_ERROR',
      httpStatus: PASSTHROUGH_STATUSES.has(upstreamStatus)
        ? upstreamStatus
        : 502,
    });
  }

  static async fromResponse(response: Response): Promise<GithubUpstreamError> {
    const raw = await response.text().catch(() => '');
    let message = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { message?: unknown };
      if (typeof parsed.message === 'string') message = parsed.message;
    } catch {
      // cuerpo no JSON: se usa el texto
    }
    return new GithubUpstreamError(
      response.status,
      message || `El Executor respondió ${response.status}.`,
    );
  }
}

export class GithubUnavailableError extends JinError {
  constructor(cause?: unknown) {
    super('No se pudo contactar al Executor para GitHub.', {
      code: 'GITHUB_EXECUTOR_UNREACHABLE',
      httpStatus: 502,
      cause,
    });
  }
}
