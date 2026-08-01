import { JinError } from '../common/errors/jin-error';

/**
 * Se lanza cuando se clasifica una tool que no existe en el registry.
 * Fail-safe explícito (AGENTS.md 1.4): NUNCA se asume `auto` por defecto
 * para una tool desconocida.
 */
export class UnknownToolError extends JinError {
  constructor(toolName: string) {
    super(`Tool no registrada en el HITL registry: "${toolName}"`, {
      code: 'HITL_UNKNOWN_TOOL',
      httpStatus: 400,
    });
  }
}
