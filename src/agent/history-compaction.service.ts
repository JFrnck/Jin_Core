import { Injectable, Logger } from '@nestjs/common';
import { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import { MemoryService } from '../memory/memory.service';
import type { ModelMessage } from '../model-provider/model-provider.types';
import { buildGenericUntrustedContentInstruction } from '../security/injection-sanitizer';
import type { HistoryCompactionPlan } from './history-compaction.logic';
import { renderMessagesAsTranscript } from './history-compaction.logic';

const HISTORY_COMPACTION_MAX_OUTPUT_TOKENS = 1000;
const HISTORY_COMPACTION_TEMPERATURE = 0.2;

const SUMMARY_SYSTEM_PROMPT =
  'Sos el módulo de compresión de historial de chat de Jin. Se te da un ' +
  'tramo de conversación entre el owner y el agente que ya no entra ' +
  'completo en el contexto del turno actual. Resumilo en un párrafo ' +
  'breve y denso: qué pidió el owner, qué hizo el agente, qué se decidió ' +
  'o quedó pendiente. No inventes nada que no esté en el tramo. Respondé ' +
  'solo con el resumen en prosa, sin encabezados ni markdown.\n\n' +
  buildGenericUntrustedContentInstruction();

const SUMMARY_PREFIX = '[Resumen automático de turnos previos]\n';

/**
 * Orquesta la compresión de un tramo viejo de `input.history`
 * (docs/RECOMENDACIONES.md #2 + requisito del owner 2026-08-04: podar Y
 * comprimir). La decisión de QUÉ comprimir es de `history-compaction.logic.ts`
 * (puro); acá solo vive lo que toca red/LLM/memoria.
 */
@Injectable()
export class HistoryCompactionService {
  private readonly logger = new Logger(HistoryCompactionService.name);

  constructor(
    private readonly budgetGuardedRouter: BudgetGuardedModelRouter,
    private readonly memoryService: MemoryService,
  ) {}

  /**
   * Nunca lanza: una falla acá no debe convertir un turno de chat
   * exitoso en un 500 — degrada devolviendo `undefined` (el caller sigue
   * con el historial sin comprimir ese turno, se reintenta el próximo).
   */
  async compact(
    sessionId: string,
    plan: HistoryCompactionPlan,
  ): Promise<ModelMessage | undefined> {
    const transcript = renderMessagesAsTranscript(plan.toCompact);

    let summaryText: string;
    try {
      const response = await this.budgetGuardedRouter.complete(
        'history_compaction',
        {
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: transcript }],
          maxOutputTokens: HISTORY_COMPACTION_MAX_OUTPUT_TOKENS,
          temperature: HISTORY_COMPACTION_TEMPERATURE,
          // Sin `tools`: garantía estructural de que la compresión no
          // puede invocar ninguna tool real, incluso si este prompt
          // fuera hijackeado por contenido citado en el transcript.
        },
        undefined,
        sessionId,
      );
      summaryText = response.content;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Compresión de historial falló (sessionId ${sessionId}): ${message}`,
      );
      return undefined;
    }

    // Fire-and-forget deliberado en cuanto a no bloquear la respuesta del
    // turno por esto, pero sí esperado (await) para loguear la falla:
    // `consolidate()` indexa el tramo CRUDO (no el resumen — destilar un
    // resumen de un resumen pierde detalle) en src/memory/, primer
    // consumidor real desde Fase 4.3 (handoff antes sin dueño).
    try {
      await this.memoryService.consolidate(sessionId, transcript);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Consolidación a memoria del tramo comprimido falló (sessionId ${sessionId}): ${message}`,
      );
    }

    return { role: 'user', content: SUMMARY_PREFIX + summaryText };
  }
}
