import { z } from 'zod';
import {
  ENV_NAME_PATTERN,
  MAX_ENV_VARS,
} from '../executor-client/demo-env.logic';
import {
  DEMO_DB_ENGINES,
  findSecretFiles,
} from '../executor-client/preview-template.logic';

/** Mismos topes que Publicar (50 archivos / 256 KB / ruta de 200). */
export const SNAPSHOT_MAX_FILES = 50;
export const SNAPSHOT_MAX_TOTAL_BYTES = 256 * 1024;
export const SNAPSHOT_MAX_PATH_LENGTH = 200;
/** Tope de respaldos guardados: evita que un bucle de la app llene la base. */
export const SNAPSHOT_MAX_COUNT = 100;

const isSafePath = (path: string): boolean =>
  path.length > 0 &&
  path.length <= SNAPSHOT_MAX_PATH_LENGTH &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !/[\r\n]/.test(path) &&
  !path.split('/').some((part) => part === '' || part === '.' || part === '..');

/** Cómo se publicaba el proyecto. Solo NOMBRES de variables, nunca valores. */
export const SnapshotConfigSchema = z
  .object({
    template: z.enum(['static', 'node']),
    database: z.enum(DEMO_DB_ENGINES as [string, ...string[]]).nullish(),
    mailEgress: z.boolean(),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(24 * 60 * 60),
    envNames: z.array(z.string().regex(ENV_NAME_PATTERN)).max(MAX_ENV_VARS),
  })
  .strict();

export const CreateSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    note: z.string().trim().max(500).optional(),
    files: z.record(z.string(), z.string()),
    config: SnapshotConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const paths = Object.keys(value.files);
    if (paths.length === 0 || paths.length > SNAPSHOT_MAX_FILES) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: `El respaldo necesita entre 1 y ${SNAPSHOT_MAX_FILES} archivos.`,
      });
    }
    const invalid = paths.filter((path) => !isSafePath(path));
    if (invalid.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: `Rutas no válidas: ${invalid.slice(0, 5).join(', ')}.`,
      });
    }
    if (snapshotBytes(value.files) > SNAPSHOT_MAX_TOTAL_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: `El proyecto supera ${SNAPSHOT_MAX_TOTAL_BYTES / 1024} KB.`,
      });
    }
    const secrets = findSecretFiles(value.files);
    if (secrets.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['files'],
        message: `Estos archivos parecen secretos y no se respaldan: ${secrets.join(', ')}. Las claves van como variables de entorno.`,
      });
    }
  });

export type CreateSnapshotInput = z.infer<typeof CreateSnapshotSchema>;

export function snapshotBytes(files: Readonly<Record<string, string>>): number {
  let total = 0;
  for (const text of Object.values(files))
    total += Buffer.byteLength(text, 'utf8');
  return total;
}
