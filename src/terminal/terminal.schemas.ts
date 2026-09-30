import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Id de proyecto que manda la app (2026-09-28, ADR 0016 ampliada): nombra el
 * pod Y el PVC del proyecto en el Executor. Se valida ESTRICTO acá también
 * (defensa en profundidad — el Executor lo vuelve a validar antes de tocar
 * cualquier nombre de recurso de Kubernetes). Un UUID cualquiera alcanza; se
 * normaliza a minúsculas, igual que del lado del Executor.
 */
export const WorkspaceIdSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    'id de proyecto inválido',
  )
  .transform((id) => id.toLowerCase());

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
    /** Solo se escriben la primera vez que se crea el disco del proyecto (se ignora al reanudar uno existente). */
    files: TerminalFilesSchema.default({}),
    ttlSeconds: z
      .number()
      .int()
      .min(300)
      .max(4 * 60 * 60),
    /**
     * Claude Code dentro del pod (ADR 0017): abre la salida a los servidores de
     * Anthropic y deja guardar el token de suscripción. Ausente = no. Nunca lo
     * decide el modelo (la aprobación es del owner, nivel fijo `confirm`).
     */
    claudeCode: z.boolean().optional(),
  })
  .strict();
export type StartTerminalInput = z.infer<typeof StartTerminalSchema>;
export class StartTerminalDto extends createZodDto(StartTerminalSchema) {}

/** Lo que queda guardado en la aprobación de abrir/reanudar (y se vuelve a validar al aprobarla). */
export const StartTerminalApprovedPayloadSchema = StartTerminalSchema.extend({
  workspaceId: WorkspaceIdSchema,
});

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
  workspaceId: WorkspaceIdSchema,
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

/**
 * Un workspace = un proyecto (2026-09-28, ADR 0016 ampliada): su disco
 * (`createdAt`) sobrevive a que el pod se destruya y se vuelva a crear.
 * `status: 'stopped'` es el reposo normal, no un error — `expiresAt`,
 * `requestId`, `exposure` y `lastActivityAt` son del pod ACTUAL, si lo hay.
 */
export const TerminalWorkspaceSchema = z.object({
  id: z.string(),
  status: z.enum(['stopped', 'starting', 'running', 'expired', 'failed']),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  /** Aprobación que abrió el pod actual: enlaza el pod con su fila del audit. */
  requestId: z.string().nullable(),
  /** Presente si publicaste el build de esta sesión del pod. */
  exposure: z.object({ slug: z.string(), url: z.string() }).nullable(),
  /** Último comando/servicio/petición al pod actual; null si no hay pod. */
  lastActivityAt: z.string().nullable(),
  /** El pod actual se abrió con Claude Code (ADR 0017). */
  claudeCode: z.boolean(),
});
export class TerminalWorkspaceDto extends createZodDto(
  TerminalWorkspaceSchema,
) {}

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

export const StartServiceSchema = z
  .object({
    /** Comando que levanta el servidor (`npm run dev -- --host 0.0.0.0 --port 5173`). */
    command: z.string().min(1).max(TERMINAL_MAX_COMMAND_LENGTH),
    /** Puerto donde escucha (de usuario: 1024–65535). */
    port: z.number().int().min(1024).max(65535),
  })
  .strict();
export class StartServiceDto extends createZodDto(StartServiceSchema) {}

export const TerminalServiceInfoSchema = z.object({
  port: z.number(),
  command: z.string(),
  startedAt: z.string(),
  running: z.boolean(),
  listening: z.boolean(),
});
export class TerminalServiceInfoDto extends createZodDto(
  TerminalServiceInfoSchema,
) {}

export const TerminalServiceStartSchema = z.object({
  status: z.enum(['listening', 'already-running', 'timeout', 'exited']),
  port: z.number(),
  /** Solo si el proceso terminó al arrancar. */
  code: z.number().optional(),
  /** Últimas líneas de su salida. */
  log: z.string(),
});
export class TerminalServiceStartDto extends createZodDto(
  TerminalServiceStartSchema,
) {}

export const TerminalServiceLogsSchema = z.object({ log: z.string() });
export class TerminalServiceLogsDto extends createZodDto(
  TerminalServiceLogsSchema,
) {}

// ── Explorador de archivos del pod (2026-09-29) ──────────────────────────
// Un archivo de texto a la vez sobre el disco real del proyecto. El Executor
// vuelve a validar todo (y `FS_SCRIPT` dentro del pod, una tercera vez).

export const TERMINAL_FS_MAX_FILE_BYTES = 512 * 1024;

const FsFilePath = z
  .string()
  .min(1)
  .max(400)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').includes('..'),
    { message: 'ruta insegura (absoluta o con "..")' },
  );
const FsDirPath = z.union([z.literal('.'), FsFilePath]);

export const FsListQuerySchema = z.object({ path: FsDirPath.default('.') });
export class FsListQueryDto extends createZodDto(FsListQuerySchema) {}

export const FsReadQuerySchema = z.object({ path: FsFilePath });
export class FsReadQueryDto extends createZodDto(FsReadQuerySchema) {}

export const FsWriteSchema = z
  .object({
    path: FsFilePath,
    content: z
      .string()
      .refine((text) => Buffer.byteLength(text) <= TERMINAL_FS_MAX_FILE_BYTES, {
        message: `el archivo supera ${TERMINAL_FS_MAX_FILE_BYTES / 1024} KB`,
      }),
    /** Hash que la app leyó: si el archivo cambió desde entonces el Executor responde 409. */
    expectedSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /** Sobrescribir sin comprobar el hash (el "sobrescribir" de la alerta de conflicto). */
    force: z.boolean().default(false),
  })
  .strict();
export type FsWriteInput = z.infer<typeof FsWriteSchema>;
export class FsWriteDto extends createZodDto(FsWriteSchema) {}

export const FsMkdirSchema = z.object({ path: FsFilePath }).strict();
export class FsMkdirDto extends createZodDto(FsMkdirSchema) {}

export const FsDeleteQuerySchema = z.object({ path: FsFilePath });
export class FsDeleteQueryDto extends createZodDto(FsDeleteQuerySchema) {}

export const TerminalFsListSchema = z.object({
  entries: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['file', 'dir', 'link', 'other']),
      size: z.number(),
      mtimeMs: z.number(),
    }),
  ),
  truncated: z.boolean(),
});
export class TerminalFsListDto extends createZodDto(TerminalFsListSchema) {}

export const TerminalFsFileSchema = z.object({
  content: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  sha256: z.string(),
});
export class TerminalFsFileDto extends createZodDto(TerminalFsFileSchema) {}

export const TerminalFsWrittenSchema = z.object({
  sha256: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
});
export class TerminalFsWrittenDto extends createZodDto(
  TerminalFsWrittenSchema,
) {}
