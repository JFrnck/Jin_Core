import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import type { ToolDefinition } from '../tools/registry';
import { TicketDecompositionParseError } from './errors';
import type { DecomposedTicketDraft } from './orchestrator.types';

const SYSTEM_PROMPT =
  'Sos el módulo de descomposición de tareas del orquestador multi-agente ' +
  'de Jin. Recibís un objetivo del owner y el catálogo de tools ' +
  'disponibles, y lo descomponés en 1 o más tickets independientes, ' +
  'delegables a sub-agentes que corren en paralelo cuando no dependen ' +
  'entre sí. Cada ticket debe ser lo más chico y autocontenido posible ' +
  '(no repartas trabajo artificialmente si un solo ticket alcanza). Para ' +
  'cada ticket, elegí SOLO las tools del catálogo que necesita — nunca ' +
  'más de las necesarias (principio de mínimo privilegio). Marcá ' +
  'dependencias solo cuando un ticket de verdad necesita el resultado de ' +
  'otro para arrancar.\n\n' +
  'Respondé EXCLUSIVAMENTE con un array JSON de objetos ' +
  '{"description": string, "allowedTools": string[], "dependsOnIndexes": number[]}, ' +
  'donde "dependsOnIndexes" son índices 0-based dentro de ese mismo array, ' +
  'sin texto adicional, sin markdown, sin bloque de código.';

const DecomposedTicketSchema = z.object({
  description: z.string().min(1),
  allowedTools: z.array(z.string()),
  dependsOnIndexes: z.array(z.number().int().nonnegative()),
});
const DecomposedTicketsSchema = z.array(DecomposedTicketSchema).min(1);

function buildUserPrompt(
  objective: string,
  catalog: readonly ToolDefinition[],
): string {
  const catalogText = catalog
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');
  return `Objetivo del owner:\n${objective}\n\nCatálogo de tools disponibles:\n${catalogText}`;
}

/**
 * Descompone un objetivo en tickets delegables (Fase 5.4, ADR 0005).
 * TaskProfile `reasoning_heavy` (Opus 4.8 por defecto) — es razonamiento
 * complejo, no chat. Mismo patrón de LLM+parseo Zod que
 * `src/memory/consolidation.service.ts`.
 */
@Injectable()
export class TicketDecompositionService {
  private readonly logger = new Logger(TicketDecompositionService.name);

  constructor(private readonly budgetGuardedRouter: BudgetGuardedModelRouter) {}

  async decompose(
    runId: string,
    objective: string,
    toolCatalog: readonly ToolDefinition[],
  ): Promise<readonly DecomposedTicketDraft[]> {
    const response = await this.budgetGuardedRouter.complete(
      'reasoning_heavy',
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: buildUserPrompt(objective, toolCatalog) },
        ],
        maxOutputTokens: 3000,
        temperature: 0.2,
      },
      undefined,
      runId,
    );

    const drafts = this.parseResponse(response.content);
    return drafts.map((draft) => this.sanitizeAllowedTools(draft, toolCatalog));
  }

  private parseResponse(rawContent: string): DecomposedTicketDraft[] {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawContent);
    } catch {
      throw new TicketDecompositionParseError(rawContent);
    }

    const result = DecomposedTicketsSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new TicketDecompositionParseError(rawContent);
    }
    return result.data;
  }

  /**
   * Asimetría deliberada (ADR 0005 punto 9): un nombre de tool alucinado
   * por el modelo se DESCARTA con warning, nunca se agrega — sub-proveer
   * es seguro, sobre-proveer (una tool inexistente igual no ejecutaría
   * nada, pero validar acá es la defensa en profundidad barata) no.
   */
  private sanitizeAllowedTools(
    draft: DecomposedTicketDraft,
    catalog: readonly ToolDefinition[],
  ): DecomposedTicketDraft {
    const validNames = new Set(catalog.map((t) => t.name));
    const sanitized = draft.allowedTools.filter((name) => {
      const isValid = validNames.has(name);
      if (!isValid) {
        this.logger.warn(
          `Descomposición pidió una tool inexistente "${name}" para el ticket "${draft.description}" — descartada.`,
        );
      }
      return isValid;
    });
    return { ...draft, allowedTools: sanitized };
  }
}
