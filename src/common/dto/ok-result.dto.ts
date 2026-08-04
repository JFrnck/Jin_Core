import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Response `{ ok: true }` compartida por varios controllers
// (budget.unpause, hitl.reject, auth.logout) — mismo shape, un solo
// lugar (AGENTS.md 1.1: 3+ repeticiones ya justifican la abstracción).
export const OkResultSchema = z.object({ ok: z.literal(true) });

export class OkResultDto extends createZodDto(OkResultSchema) {}
