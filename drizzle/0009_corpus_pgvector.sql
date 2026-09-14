-- Fase 9.3: corpus propio en pgvector (BLUEPRINT §3.3/§3.3.1). A mano,
-- mismo motivo que 0008 (feature_flag_hitl_overrides, Fase 9.5): la
-- cadena de snapshots de drizzle-kit sigue rota desde la 0003 (deuda ya
-- documentada, fuera de alcance de este PR).
--
-- NOTA DE NUMERACIÓN: esta migración se numeró 0009 a propósito, no 0008
-- -- Fase 9.5 (PR #32 de Jin_Core) ya reservó 0008 en paralelo, en una
-- rama distinta. Si 9.5 se mergea primero, esto aplica limpio detrás. Si
-- 9.3 se mergea primero, quien mergee 9.5 después va a necesitar
-- renumerar su 0008 a 0010 (o el número que corresponda) -- señalado
-- explícitamente en STATUS.md para que no se pierda.

-- Defensivo: en testcontainers no corre el init script de K8s
-- (Jin_Infra/k8s/base/postgres/init-configmap.yaml) que ya la crea en
-- el clúster real.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "corpus_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Dedup real a nivel DB, no solo en el código de CorpusService.
CREATE UNIQUE INDEX IF NOT EXISTS "corpus_entries_source_source_id_idx"
	ON "corpus_entries" ("source", "source_id");

CREATE TABLE IF NOT EXISTS "corpus_embeddings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"modelo_embedding" text NOT NULL
);

ALTER TABLE "corpus_embeddings"
	ADD CONSTRAINT "corpus_embeddings_entry_id_corpus_entries_id_fk"
	FOREIGN KEY ("entry_id") REFERENCES "public"."corpus_entries"("id")
	ON DELETE no action ON UPDATE no action;

-- 1 embedding por entrada (no 1:muchos) -- re-indexar el mismo email
-- (mismo source_id) hace upsert también acá, no acumula filas huérfanas
-- que ensuciarían la búsqueda con resultados duplicados.
CREATE UNIQUE INDEX IF NOT EXISTS "corpus_embeddings_entry_id_idx"
	ON "corpus_embeddings" ("entry_id");

-- HNSW (BLUEPRINT §3.3, "índice HNSW sobre embeddings"). IVFFlat queda
-- documentado como fallback si la RAM del clúster aprieta -- sin
-- implementarlo, no hay señal hoy de que haga falta (misma regla que ya
-- aplicó el owner a PgBouncer/Tempo, ver auditoría de cobertura en
-- STATUS.md 2026-08-05).
CREATE INDEX IF NOT EXISTS "corpus_embeddings_embedding_hnsw_idx"
	ON "corpus_embeddings" USING hnsw ("embedding" vector_cosine_ops);
