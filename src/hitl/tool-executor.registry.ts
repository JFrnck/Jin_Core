import { Injectable } from '@nestjs/common';
import { JinError } from '../common/errors/jin-error';

export type ToolExecutor = (payload: unknown) => Promise<unknown>;

export class ToolExecutorAlreadyRegisteredError extends JinError {
  constructor(toolName: string) {
    super(
      `Ya hay un executor registrado para la tool "${toolName}" — doble registro accidental.`,
      { code: 'HITL_TOOL_EXECUTOR_ALREADY_REGISTERED', httpStatus: 500 },
    );
  }
}

export class NoExecutorRegisteredError extends JinError {
  constructor(toolName: string) {
    super(
      `No hay ningún executor registrado para la tool "${toolName}" — no se puede ejecutar la acción aprobada.`,
      { code: 'HITL_NO_EXECUTOR_REGISTERED', httpStatus: 500 },
    );
  }
}

/**
 * Registro en memoria de "cómo ejecutar de verdad" cada tool `confirm`/
 * `dual-confirm` al aprobarse (prerequisito de Fase 4.2, ver STATUS.md).
 * `src/hitl/` no puede importar Google/Canvas/etc. directamente sin crear
 * un ciclo — en vez de eso, cada módulo de integración registra su propio
 * executor en su `onModuleInit()` contra este registry compartido.
 * Fail-safe explícito (mismo criterio que `UnknownToolError`): nunca se
 * "aprueba en silencio" sin ejecutar — si nadie registró la tool, lanza.
 */
@Injectable()
export class ToolExecutorRegistry {
  private readonly executors = new Map<string, ToolExecutor>();

  register(toolName: string, executor: ToolExecutor): void {
    if (this.executors.has(toolName)) {
      throw new ToolExecutorAlreadyRegisteredError(toolName);
    }
    this.executors.set(toolName, executor);
  }

  async execute(toolName: string, payload: unknown): Promise<unknown> {
    const executor = this.executors.get(toolName);
    if (!executor) {
      throw new NoExecutorRegisteredError(toolName);
    }
    return executor(payload);
  }
}
