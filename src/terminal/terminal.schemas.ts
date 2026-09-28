import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Mismos topes que Publicar (ADR 0015) y que el Executor. */
export const TERMINAL_MAX_FILES = 50;
export const TERMINAL_MAX_TOTAL_BYTES = 256 * 1024;
export const TERMINAL_MAX_COMMAND_LENGTH = 4096;
export const TERMINAL_MAX_TIMEOUT_SECONDS = 600;
/** Puerto del servidor estático fijo de Jin (`STATIC_SERVER_SOURCE`). */
export const TERMINAL_STATIC_PORT = 8080;

const SafePath = z
  .string()
  .min(1)
  .max(200)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), {
    message: 'ruta insegura (absoluta o con "..")',
  });

export const TerminalFilesSchema = z
  .record(SafePath, z.string())
  .refine((files) => Object.keys(files).length <= TERMINAL_MAX_FILES, {
    message: `máximo ${TERMINAL_MAX_FILES} archivos`,
  })
  .refine(
    (files) =>
      Object.entries(files).reduce(
        (sum, [path, text]) =>
          sum + Buffer.byteLength(path) + Buffer.byteLength(text),
        0,
      ) <= TERMINAL_MAX_TOTAL_BYTES,
    { message: `el proyecto supera ${TERMINAL_MAX_TOTAL_BYTES / 1024} KB` },
  );

export const StartTerminalSchema = z
  .object({
    /** El proyecto del editor con el que arranca la sesión (puede ir vacío). */
    files: TerminalFilesSchema.default({}),
    ttlSeconds: z
      .number()
      .int()
      .min(300)
      .max(4 * 60 * 60),
  })
  .strict();
export type StartTerminalInput = z.infer<typeof StartTerminalSchema>;
export class StartTerminalDto extends createZodDto(StartTerminalSchema) {}

export const ExecTerminalSchema = z
  .object({
    command: z.string().min(1).max(TERMINAL_MAX_COMMAND_LENGTH),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(TERMINAL_MAX_TIMEOUT_SECONDS)
      .optional(),
  })
  .strict();
export type ExecTerminalInput = z.infer<typeof ExecTerminalSchema>;
export class ExecTerminalDto extends createZodDto(ExecTerminalSchema) {}

export const ExposeTerminalSchema = z
  .object({
    /** Directorio del build dentro de la sesión (`dist` en Vite). */
    dir: SafePath.default('dist'),
    slugHint: z.string().min(1).max(40).optional(),
  })
  .strict();
export type ExposeTerminalInput = z.infer<typeof ExposeTerminalSchema>;
export class ExposeTerminalDto extends createZodDto(ExposeTerminalSchema) {}

/** Lo que queda guardado en la aprobación de publicar (y se vuelve a validar al aprobarla). */
export const ExposeApprovedPayloadSchema = ExposeTerminalSchema.extend({
  sessionId: z.string().uuid(),
});

export const ImportTerminalSchema = z
  .object({ files: TerminalFilesSchema })
  .strict();
export class ImportTerminalDto extends createZodDto(ImportTerminalSchema) {}

export const ExportTerminalQuerySchema = z.object({
  dir: z.union([z.literal('.'), SafePath]).default('.'),
});
export class ExportTerminalQueryDto extends createZodDto(
  ExportTerminalQuerySchema,
) {}

export const TerminalSessionSchema = z.object({
  id: z.string(),
  status: z.enum(['starting', 'running', 'expired', 'failed']),
  expiresAt: z.string(),
  /** Aprobación que abrió la sesión: enlaza el pod con su fila del audit. */
  requestId: z.string().nullable(),
  /** Presente si publicaste el build de esta sesión. */
  exposure: z.object({ slug: z.string(), url: z.string() }).nullable(),
});
export class TerminalSessionDto extends createZodDto(TerminalSessionSchema) {}

/** Iniciar y publicar siempre esperan tu aprobación (ningún modo la salta). */
export const TerminalPendingSchema = z.object({
  status: z.literal('pending-approval'),
  requestId: z.string(),
});
export class TerminalPendingDto extends createZodDto(TerminalPendingSchema) {}

export const TerminalExportSchema = z.object({
  files: z.record(z.string(), z.string()),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export class TerminalExportDto extends createZodDto(TerminalExportSchema) {}

export const TerminalImportResultSchema = z.object({ written: z.number() });
export class TerminalImportResultDto extends createZodDto(
  TerminalImportResultSchema,
) {}
