export interface IndexEmailInput {
  readonly messageId: string;
  readonly subject?: string;
  readonly from?: string;
  readonly date?: string;
  readonly body: string;
}

export interface CorpusEntry {
  readonly id: string;
  readonly source: string;
  readonly sourceId: string;
  readonly content: string;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: string; // ISO 8601
}

export interface CorpusSearchResult extends CorpusEntry {
  /** Distancia coseno (pgvector `<=>`) -- menor es más relevante, mismo criterio que MemoryEntry.distance. */
  readonly distance: number;
}
