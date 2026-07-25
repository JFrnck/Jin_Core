import { z } from 'zod';

/**
 * Los 4 tipos de entrada de memoria (BLUEPRINT 3.3.1/6.4). Zod es la
 * fuente de verdad; el tipo se infiere (AGENTS.md 3.4) — nunca un TS
 * `enum` (AGENTS.md 3.2).
 */
export const MEMORY_ENTRY_TYPES = [
  'hecho',
  'preferencia',
  'leccion',
  'episodio',
] as const;
export const MemoryEntryTypeSchema = z.enum(MEMORY_ENTRY_TYPES);
export type MemoryEntryType = z.infer<typeof MemoryEntryTypeSchema>;

export interface MemoryEntry {
  readonly id: number;
  readonly content: string;
  readonly tipo: MemoryEntryType;
  readonly fuente: string;
  readonly fecha: string; // ISO 8601
  readonly modeloEmbedding: string;
  readonly sessionId?: string;
  /** Solo presente en resultados de `recall()` — distancia coseno, menor es más relevante. */
  readonly distance?: number;
}

export interface RememberInput {
  readonly content: string;
  readonly tipo: MemoryEntryType;
  readonly fuente: string;
  readonly sessionId?: string;
  /**
   * Si `content` viene de una fuente externa (correo, Canvas, mensaje
   * entrante) y debe sanitizarse antes de persistir (AGENTS.md 5.1 punto
   * 2, vía `sanitizeForIndexing`). Default `true` — fail-safe: el caller
   * tiene que optar explícitamente por saltarse la sanitización, nunca
   * al revés.
   */
  readonly isExternal?: boolean;
}

export interface RecallFilters {
  readonly tipo?: MemoryEntryType;
  readonly fuente?: string;
  readonly sessionId?: string;
}
