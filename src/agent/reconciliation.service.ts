import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import { ReconciliationParseError } from './errors';
import type {
  ReconciliationOutput,
  Ticket,
  TicketComment,
} from './orchestrator.types';

const SYSTEM_PROMPT =
  'Sos el módulo de reconciliación del orquestador multi-agente de Jin. ' +
  'Recibís el board completo de un run: todos los tickets (con su ' +
  'resultado) y su hilo de comentarios. Tu trabajo es doble: (1) redactar ' +
  'UNA respuesta final coherente para el owner, integrando los resultados ' +
  'de todos los tickets; (2) detectar contradicciones reales entre lo que ' +
  'reportaron distintos sub-agentes (no falsos positivos por redacción ' +
  'distinta de lo mismo) y clasificar cada una: "low" si es una ' +
  'discrepancia de bajo riesgo que vos mismo podés resolver con criterio ' +
  '(ej. cuál de dos resúmenes casi iguales usar), "material" si afecta ' +
  'algo de nivel confirm o los sub-agentes proponen acciones ' +
  'incompatibles — eso SIEMPRE se escala al owner, nunca lo decidas vos. ' +
  'Si no hay contradicciones, "conflicts" es un array vacío.\n\n' +
  'Respondé EXCLUSIVAMENTE con un JSON ' +
  '{"finalResponse": string, "conflicts": [{"ticketIds": string[], "summary": string, "riskLevel": "low" | "material", "proposedResolution": string}]}, ' +
  'sin texto adicional, sin markdown, sin bloque de código.';

const ReconciliationConflictSchema = z.object({
  ticketIds: z.array(z.string()),
  summary: z.string().min(1),
  riskLevel: z.enum(['low', 'material']),
  proposedResolution: z.string().min(1),
});
const ReconciliationOutputSchema = z.object({
  finalResponse: z.string().min(1),
  conflicts: z.array(ReconciliationConflictSchema),
});

function buildUserPrompt(
  tickets: readonly Ticket[],
  commentsByTicket: ReadonlyMap<string, readonly TicketComment[]>,
): string {
  const board = tickets
    .map((t) => {
      const comments = commentsByTicket.get(t.id) ?? [];
      const commentsText = comments
        .map((c) => `  [${c.authorType}/${c.kind}] ${c.body}`)
        .join('\n');
      return (
        `Ticket ${t.id} (status: ${t.status}): ${t.description}\n` +
        `  Resultado: ${t.result ?? '(sin resultado todavía)'}\n` +
        (commentsText ? `${commentsText}\n` : '')
      );
    })
    .join('\n');
  return `Board del run:\n\n${board}`;
}

/**
 * Pasada final de reconciliación de un run multi-agente (Fase 5.4, ADR
 * 0005 punto 5). TaskProfile `reasoning_heavy`, mismo patrón LLM+Zod que
 * `TicketDecompositionService`/`ConsolidationService`.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly budgetGuardedRouter: BudgetGuardedModelRouter) {}

  async reconcile(
    runId: string,
    tickets: readonly Ticket[],
    commentsByTicket: ReadonlyMap<string, readonly TicketComment[]>,
  ): Promise<ReconciliationOutput> {
    const response = await this.budgetGuardedRouter.complete(
      'reasoning_heavy',
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: buildUserPrompt(tickets, commentsByTicket) },
        ],
        maxOutputTokens: 3000,
        temperature: 0.2,
      },
      undefined,
      runId,
    );

    return this.parseResponse(response.content);
  }

  private parseResponse(rawContent: string): ReconciliationOutput {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawContent);
    } catch {
      throw new ReconciliationParseError(rawContent);
    }

    const result = ReconciliationOutputSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new ReconciliationParseError(rawContent);
    }
    return result.data;
  }
}
