import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const RepoSchema = z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
const BranchSchema = z.string().trim().min(1).max(100);
const DirSchema = z
  .string()
  .max(200)
  .refine(
    (dir) =>
      dir === '.' || (!dir.startsWith('/') && !dir.split('/').includes('..')),
    'carpeta no válida',
  );

export const CloneBodySchema = z
  .object({
    repo: RepoSchema,
    ref: BranchSchema.optional(),
    dir: DirSchema.optional(),
  })
  .strict();
export class CloneBodyDto extends createZodDto(CloneBodySchema) {}

export const DirQuerySchema = z.object({ dir: DirSchema.optional() });
export class DirQueryDto extends createZodDto(DirQuerySchema) {}

export const CheckoutBodySchema = z
  .object({
    dir: DirSchema.optional(),
    branch: BranchSchema,
    create: z.boolean().optional(),
  })
  .strict();
export class CheckoutBodyDto extends createZodDto(CheckoutBodySchema) {}

export const PullBodySchema = z.object({ dir: DirSchema.optional() }).strict();
export class PullBodyDto extends createZodDto(PullBodySchema) {}

export const PushBodySchema = z
  .object({
    dir: DirSchema.optional(),
    branch: BranchSchema,
    message: z.string().trim().min(1).max(200),
  })
  .strict();
export class PushBodyDto extends createZodDto(PushBodySchema) {}

const RepoInfoSchema = z.object({
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  description: z.string().nullable(),
});
export class RepoListDto extends createZodDto(
  z.object({ repos: z.array(RepoInfoSchema) }),
) {}

export class CloneResultDto extends createZodDto(
  z.object({
    repo: z.string(),
    dir: z.string(),
    branch: z.string(),
    head: z.string(),
  }),
) {}

export class RepoStatusDto extends createZodDto(
  z.object({
    repo: z.string(),
    branch: z.string(),
    head: z.string(),
    clean: z.boolean(),
    changed: z.array(z.object({ path: z.string(), status: z.string() })),
    changedTruncated: z.boolean(),
  }),
) {}

export class BranchesDto extends createZodDto(
  z.object({
    current: z.string(),
    local: z.array(z.string()),
    remote: z.array(z.string()),
  }),
) {}

export class CheckoutResultDto extends createZodDto(
  z.object({ branch: z.string(), head: z.string() }),
) {}

export class PullResultDto extends createZodDto(
  z.object({ branch: z.string(), head: z.string(), updated: z.boolean() }),
) {}

const PushResultSchema = z.object({
  repo: z.string(),
  branch: z.string(),
  commit: z.string(),
  files: z.number(),
  url: z.string(),
});

export const PushOutcomeSchema = z.object({
  /** 'pending-approval': espera tu decisión en Aprobar. 'pushed': un modo de autonomía la dejó correr. */
  status: z.enum(['pending-approval', 'pushed']),
  requestId: z.string(),
  result: PushResultSchema.optional(),
});
export class PushOutcomeDto extends createZodDto(PushOutcomeSchema) {}
