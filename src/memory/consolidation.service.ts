import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import { ConsolidationParseError } from './errors';
import { MemoryEntryTypeSchema } from './memory.types';

const SYSTEM_PROMPT =
  'Sos el módulo de consolidación de memoria de Jin. Analizás la ' +
  'transcripción de una sesión de agente recién cerrada y destilás SOLO lo ' +
  'que vale la pena recordar a largo plazo: hechos concretos sobre el ' +
  'owner o su contexto ("tipo": "hecho"), preferencias explícitas o ' +
  'implícitas ("tipo": "preferencia"), lecciones aprendidas de un error o ' +
  'ajuste ("tipo": "leccion"), o un resumen episódico breve de lo que pasó ' +
  'en la sesión ("tipo": "episodio"). NO guardes todo — solo lo curado y ' +
  'reutilizable en sesiones futuras. Si no hay nada que valga la pena, ' +
  'devolvé un array vacío.\n\n' +
  'Respondé EXCLUSIVAMENTE con un array JSON de objetos ' +
  '{"content": string, "tipo": "hecho" | "preferencia" | "leccion" | "episodio"}, ' +
  'sin texto adicional, sin markdown, sin bloque de código.';

const DistilledEntrySchema = z.object({
  content: z.string().min(1),
  tipo: MemoryEntryTypeSchema,
});
const DistilledEntriesSchema = z.array(DistilledEntrySchema);
export type DistilledEntry = z.infer<typeof DistilledEntrySchema>;

/**
 * Arma el prompt de destilación (TaskProfile `memory_consolidation`,
 * BLUEPRINT 3.3.1/PROMPTS.md 4.3) y parsea la respuesta del LLM a una
 * lista de entradas candidatas. No persiste nada — `MemoryService.
 * consolidate()` es quien llama `remember()` por cada entrada.
 */
@Injectable()
export class ConsolidationService {
  constructor(private readonly budgetGuardedRouter: BudgetGuardedModelRouter) {}

  async distill(
    sessionId: string,
    transcript: string,
  ): Promise<readonly DistilledEntry[]> {
    const response = await this.budgetGuardedRouter.complete(
      'memory_consolidation',
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: transcript }],
        maxOutputTokens: 2000,
        temperature: 0.2,
      },
      undefined,
      sessionId,
    );

    return this.parseResponse(response.content);
  }

  private parseResponse(rawContent: string): readonly DistilledEntry[] {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawContent);
    } catch {
      throw new ConsolidationParseError(rawContent);
    }

    const result = DistilledEntriesSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new ConsolidationParseError(rawContent);
    }
    return result.data;
  }
}
