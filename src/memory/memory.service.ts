import { Injectable } from '@nestjs/common';
import { sanitizeForIndexing } from '../security/injection-sanitizer';
import { ConsolidationService } from './consolidation.service';
import { EMBEDDING_MODEL_ID, EmbeddingProvider } from './embedding-provider';
import { MemoryStore } from './store';
import type { MemoryEntry, RecallFilters, RememberInput } from './memory.types';

// Fuente fija para todo lo que sale de consolidate(): son conclusiones
// del propio agente sobre la sesión, no contenido crudo de un canal
// externo (gmail/canvas/telegram_chat) — se distingue explícitamente
// para poder filtrar por `fuente` en recall() más adelante.
const CONSOLIDATION_SOURCE = 'agent_reflection';

/**
 * API pública de la memoria extendida (BLUEPRINT 3.3.1, PROMPTS.md 4.3).
 * Orquesta `EmbeddingProvider` (vectoriza) + `MemoryStore` (persiste) —
 * ninguno de los dos se usa directo fuera de este módulo.
 */
@Injectable()
export class MemoryService {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly store: MemoryStore,
    private readonly consolidationService: ConsolidationService,
  ) {}

  /**
   * Sanitiza `content` antes de persistir (AGENTS.md 5.1 punto 2) salvo
   * que el caller declare explícitamente `isExternal: false` — fail-safe:
   * el default es sanitizar, no al revés.
   */
  async remember(input: RememberInput): Promise<MemoryEntry> {
    const content =
      input.isExternal === false
        ? input.content
        : sanitizeForIndexing(input.content);

    const embedding = await this.embeddingProvider.embed(content);

    return this.store.insert(
      {
        content,
        tipo: input.tipo,
        fuente: input.fuente,
        fecha: new Date().toISOString(),
        modeloEmbedding: EMBEDDING_MODEL_ID,
        ...(input.sessionId !== undefined
          ? { sessionId: input.sessionId }
          : {}),
      },
      embedding,
    );
  }

  async recall(
    query: string,
    k: number,
    filters?: RecallFilters,
  ): Promise<readonly MemoryEntry[]> {
    const queryEmbedding = await this.embeddingProvider.embed(query);
    return this.store.queryKnn(queryEmbedding, k, filters);
  }

  /**
   * Al cierre de una sesión de agente (BLUEPRINT 3.3.1): destila la
   * transcripción vía el TaskProfile `memory_consolidation` y persiste
   * cada entrada candidata. `isExternal: false` — son conclusiones del
   * propio agente, no contenido externo crudo (AGENTS.md 5.1 solo exige
   * sanitizar lo que entra desde afuera).
   */
  async consolidate(
    sessionId: string,
    transcript: string,
  ): Promise<readonly MemoryEntry[]> {
    const distilled = await this.consolidationService.distill(
      sessionId,
      transcript,
    );

    // Secuencial, no Promise.all: cada remember() escribe en la misma
    // conexión sqlite de un solo writer (BLUEPRINT 3.3.1) — paralelizar
    // acá no ganaría nada y complicaría el orden de los ids insertados.
    const entries: MemoryEntry[] = [];
    for (const candidate of distilled) {
      const entry = await this.remember({
        content: candidate.content,
        tipo: candidate.tipo,
        fuente: CONSOLIDATION_SOURCE,
        sessionId,
        isExternal: false,
      });
      entries.push(entry);
    }
    return entries;
  }
}
