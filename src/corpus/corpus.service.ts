import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Gauge } from 'prom-client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { corpusEmbeddings, corpusEntries } from '../db/schema';
import {
  EMBEDDING_MODEL_ID,
  EmbeddingProvider,
} from '../memory/embedding-provider';
import { RAG_HIT_RATIO } from '../metrics/metrics.module';
import { sanitizeForIndexing } from '../security/injection-sanitizer';
import type {
  CorpusEntry,
  CorpusSearchResult,
  IndexEmailInput,
} from './corpus.types';

const GMAIL_SOURCE = 'gmail';
const DEFAULT_SEARCH_LIMIT = 5;

function toCorpusEntry(row: {
  id: string;
  source: string;
  sourceId: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
}): CorpusEntry {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.sourceId,
    content: row.content,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Corpus propio en pgvector (Fase 9.3, BLUEPRINT §3.3/§3.3.1/§6.4) --
 * distinto de `src/memory/` (memoria del agente, sqlite-vec): dos
 * almacenes, dos ciclos de vida, la frontera de §3.3.1 no se negocia.
 * Reusa `EmbeddingProvider` (exportado por `MemoryModule`) -- ningún
 * segundo proveedor de embeddings.
 */
@Injectable()
export class CorpusService {
  // Contadores en memoria del proceso -- se resetean en cada restart,
  // mismo criterio que budgetRemainingGauge (instantánea, no un
  // acumulado histórico persistido).
  private searchHits = 0;
  private searchTotal = 0;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: Db,
    private readonly embeddingProvider: EmbeddingProvider,
    @InjectMetric(RAG_HIT_RATIO)
    private readonly ragHitRatioGauge: Gauge<string>,
  ) {}

  /**
   * Indexa un correo (BLUEPRINT §9.1: "indexar docs" es `auto` en la
   * tabla de niveles HITL). `sanitizeForIndexing()` corre ANTES de
   * embeber -- `body` es contenido externo crudo (AGENTS.md 5.1 punto
   * 2), igual que cualquier correo que ya pasa por `wrapUntrustedContent`
   * al volver como tool_result.
   *
   * Dedup real por `(source, sourceId)` -- reindexar el mismo
   * `messageId` actualiza la entrada existente en vez de duplicarla
   * (constraint UNIQUE en la migración, no solo un chequeo en este
   * método).
   */
  async indexEmail(input: IndexEmailInput): Promise<CorpusEntry> {
    const content = sanitizeForIndexing(input.body);
    const embedding = await this.embeddingProvider.embed(content);
    const metadata: Record<string, unknown> = {
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
    };

    const [entry] = await this.db
      .insert(corpusEntries)
      .values({
        id: randomUUID(),
        source: GMAIL_SOURCE,
        sourceId: input.messageId,
        content,
        metadata,
      })
      .onConflictDoUpdate({
        target: [corpusEntries.source, corpusEntries.sourceId],
        set: { content, metadata },
      })
      .returning();
    if (!entry) {
      throw new Error(
        'El insert/upsert de corpus_entries no devolvió ninguna fila.',
      );
    }

    // 1 embedding por entrada -- ver comentario de la migración. Usa
    // entry.id (la fila real tras el upsert), NUNCA el uuid generado
    // arriba: si hubo conflicto, ese uuid nunca se persistió.
    await this.db
      .insert(corpusEmbeddings)
      .values({
        id: randomUUID(),
        entryId: entry.id,
        embedding: embedding as number[],
        modeloEmbedding: EMBEDDING_MODEL_ID,
      })
      .onConflictDoUpdate({
        target: corpusEmbeddings.entryId,
        set: {
          embedding: embedding as number[],
          modeloEmbedding: EMBEDDING_MODEL_ID,
        },
      });

    return toCorpusEntry(entry);
  }

  /**
   * Búsqueda por similitud con el JOIN relacional real que justifica
   * pgvector sobre Qdrant (BLUEPRINT §3.3: "un JOIN entre tasks y
   * task_embeddings es SQL nativo"). El vector de la query se pasa como
   * parámetro (mismo formato de texto que `mapToDriverValue` del tipo
   * `vector` de drizzle-orm ya usa internamente) -- nunca interpolado
   * crudo en el SQL.
   */
  async search(
    query: string,
    limit: number = DEFAULT_SEARCH_LIMIT,
  ): Promise<readonly CorpusSearchResult[]> {
    const queryEmbedding = await this.embeddingProvider.embed(query);
    const distance = sql<number>`${corpusEmbeddings.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector`;

    const rows = await this.db
      .select({
        id: corpusEntries.id,
        source: corpusEntries.source,
        sourceId: corpusEntries.sourceId,
        content: corpusEntries.content,
        metadata: corpusEntries.metadata,
        createdAt: corpusEntries.createdAt,
        distance,
      })
      .from(corpusEmbeddings)
      .innerJoin(corpusEntries, eq(corpusEmbeddings.entryId, corpusEntries.id))
      .orderBy(distance)
      .limit(limit);

    this.recordSearchOutcome(rows.length > 0);

    return rows.map((row) => ({
      ...toCorpusEntry(row),
      distance: row.distance,
    }));
  }

  private recordSearchOutcome(isHit: boolean): void {
    this.searchTotal += 1;
    if (isHit) this.searchHits += 1;
    this.ragHitRatioGauge.set(this.searchHits / this.searchTotal);
  }
}
