import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Primer validador de body de la primera API REST real del repo
 * (Fase 6.1) — hasta ahora el único controller con `@Body()` (el webhook
 * de Telegram) confía en el tipo de `grammy` sin validar en runtime,
 * porque el secret header ya autentica el origen. Los endpoints nuevos
 * reciben input de un cliente arbitrario (Web/CLI) y deben validarlo
 * (AGENTS.md 5.1: "Zod para toda validación de input externo").
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Body inválido.',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
