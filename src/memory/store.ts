import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { MemoryDbError } from './errors';
import { MEMORY_DB_PATH } from './memory.tokens';
import type {
  MemoryEntry,
  MemoryEntryType,
  RecallFilters,
} from './memory.types';

type Db = InstanceType<typeof Database>;

// Debe matchear EMBEDDING_DIMENSIONS de embedding-provider.ts — no hay un
// solo lugar que las una porque `store.ts` no necesita saber nada de
// OpenAI, y `embedding-provider.ts` no necesita saber nada de SQL. La
// dimensión real de cada entrada queda igual auditable vía la columna
// `modelo_embedding` (BLUEPRINT 3.3.1).
const EMBEDDING_DIMENSIONS = 1024;

export interface InsertEntryInput {
  readonly content: string;
  readonly tipo: MemoryEntryType;
  readonly fuente: string;
  readonly fecha: string;
  readonly modeloEmbedding: string;
  readonly sessionId?: string;
}

interface MemoryEntryRow {
  readonly id: number;
  readonly content: string;
  readonly tipo: MemoryEntryType;
  readonly fuente: string;
  readonly fecha: string;
  readonly modeloEmbedding: string;
  readonly sessionId: string | null;
}

/**
 * better-sqlite3 vincula un `number` JS como REAL en ciertas posiciones
 * de parámetro contra tablas virtuales vec0 (verificado empíricamente:
 * "Only integers are allowed for primary key values" con un rowid
 * `number`, pero funciona con `BigInt`) — vec0 exige el tipo SQLITE_INTEGER
 * exacto para el rowid, y solo `BigInt` lo garantiza vía better-sqlite3.
 */
function toRowId(id: number): bigint {
  return BigInt(id);
}

function toVectorBuffer(vector: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function toMemoryEntry(row: MemoryEntryRow, distance?: number): MemoryEntry {
  return {
    id: row.id,
    content: row.content,
    tipo: row.tipo,
    fuente: row.fuente,
    fecha: row.fecha,
    modeloEmbedding: row.modeloEmbedding,
    ...(row.sessionId !== null ? { sessionId: row.sessionId } : {}),
    ...(distance !== undefined ? { distance } : {}),
  };
}

/**
 * Acceso de bajo nivel a `memory.db` (BLUEPRINT 3.3.1): better-sqlite3 +
 * extensión sqlite-vec, WAL mode, un solo writer. Único lugar del repo
 * que importa better-sqlite3/sqlite-vec (PROMPTS.md 4.3).
 */
@Injectable()
export class MemoryStore implements OnModuleDestroy {
  private readonly db: Db;

  constructor(@Inject(MEMORY_DB_PATH) dbPath: string) {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
      sqliteVec.load(this.db);
      this.db.pragma('journal_mode = WAL');
      this.initSchema();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new MemoryDbError(`no se pudo abrir "${dbPath}": ${msg}`, err);
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
        embedding FLOAT[${EMBEDDING_DIMENSIONS}] distance_metric=cosine
      );
      CREATE TABLE IF NOT EXISTS memory_entries (
        id INTEGER PRIMARY KEY,
        content TEXT NOT NULL,
        tipo TEXT NOT NULL,
        fuente TEXT NOT NULL,
        fecha TEXT NOT NULL,
        modelo_embedding TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_memory_entries_tipo ON memory_entries(tipo);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_fuente ON memory_entries(fuente);
    `);
  }

  insert(entry: InsertEntryInput, embedding: readonly number[]): MemoryEntry {
    const insertMeta = this.db.prepare<
      [string, string, string, string, string, string | null]
    >(
      `INSERT INTO memory_entries
        (content, tipo, fuente, fecha, modelo_embedding, session_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertVec = this.db.prepare<[bigint, Buffer]>(
      'INSERT INTO memory_vectors (rowid, embedding) VALUES (?, ?)',
    );

    const runTransaction = this.db.transaction((): number => {
      const result = insertMeta.run(
        entry.content,
        entry.tipo,
        entry.fuente,
        entry.fecha,
        entry.modeloEmbedding,
        entry.sessionId ?? null,
      );
      const id = Number(result.lastInsertRowid);
      insertVec.run(toRowId(id), toVectorBuffer(embedding));
      return id;
    });

    const id = runTransaction();
    return toMemoryEntry({
      id,
      content: entry.content,
      tipo: entry.tipo,
      fuente: entry.fuente,
      fecha: entry.fecha,
      modeloEmbedding: entry.modeloEmbedding,
      sessionId: entry.sessionId ?? null,
    });
  }

  /**
   * KNN brute-force real (BLUEPRINT 3.3.1: "no depender de los índices
   * ANN de sqlite-vec, siguen en alpha"): rankea TODAS las filas (`k` =
   * conteo total de `memory_vectors`, sin índice ANN), recién ahí filtra
   * por metadata y trunca a los `k` pedidos por el caller. Filtrar antes
   * del ranking completo rompería la semántica de "los k más relevantes
   * ENTRE los que matchean el filtro". Barato para un store ≤100k
   * vectores (BLUEPRINT 3.3.1).
   */
  queryKnn(
    queryEmbedding: readonly number[],
    k: number,
    filters?: RecallFilters,
  ): readonly MemoryEntry[] {
    const { c: totalRows } = this.db
      .prepare<[], { c: number }>('SELECT COUNT(*) as c FROM memory_vectors')
      .get() ?? { c: 0 };
    if (totalRows === 0) return [];

    const rows = this.db
      .prepare<
        [Buffer, number],
        MemoryEntryRow & { distance: number; sessionId: string | null }
      >(
        `SELECT
           e.id as id,
           e.content as content,
           e.tipo as tipo,
           e.fuente as fuente,
           e.fecha as fecha,
           e.modelo_embedding as modeloEmbedding,
           e.session_id as sessionId,
           v.distance as distance
         FROM memory_vectors v
         JOIN memory_entries e ON e.id = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`,
      )
      .all(toVectorBuffer(queryEmbedding), totalRows);

    const filtered = rows.filter((row) => {
      if (filters?.tipo && row.tipo !== filters.tipo) return false;
      if (filters?.fuente && row.fuente !== filters.fuente) return false;
      if (filters?.sessionId && row.sessionId !== filters.sessionId)
        return false;
      return true;
    });

    return filtered.slice(0, k).map((row) => toMemoryEntry(row, row.distance));
  }

  onModuleDestroy(): void {
    this.db.close();
  }
}
