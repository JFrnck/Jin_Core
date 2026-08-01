import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryDbError } from './errors';
import { MemoryStore } from './store';

// Contra un archivo real (no mock): sqlite es local/embebido, no
// necesita testcontainer (AGENTS.md 6.3 solo exige mockear APIs
// externas/tiempo/randomness — un archivo temporal no es ninguna de
// las tres).
function randomVector(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin(seed + i));
}

describe('MemoryStore', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jin-memory-test-'));
    dbPath = join(tmpDir, 'nested', 'memory.db');
    store = new MemoryStore(dbPath);
  });

  afterEach(() => {
    store.onModuleDestroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('crea el directorio padre si no existe y abre el archivo', () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  it('lanza MemoryDbError si no puede abrir/crear el archivo (ej. un archivo regular en el path del directorio padre)', () => {
    const blockerFile = join(tmpDir, 'esto-es-un-archivo-no-un-directorio');
    writeFileSync(blockerFile, 'bloqueo');
    const badPath = join(blockerFile, 'memory.db');

    expect(() => new MemoryStore(badPath)).toThrow(MemoryDbError);
  });

  it('insert + queryKnn: round-trip devuelve la entrada más cercana primero', () => {
    store.insert(
      {
        content: 'al owner le gusta el café sin azúcar',
        tipo: 'preferencia',
        fuente: 'telegram_chat',
        fecha: '2026-07-25T00:00:00.000Z',
        modeloEmbedding: 'text-embedding-3-large:1024',
      },
      randomVector(1),
    );
    store.insert(
      {
        content: 'la entrega del proyecto es el 30 de julio',
        tipo: 'hecho',
        fuente: 'gmail',
        fecha: '2026-07-25T00:00:00.000Z',
        modeloEmbedding: 'text-embedding-3-large:1024',
      },
      randomVector(500),
    );

    const results = store.queryKnn(randomVector(1), 5);

    expect(results).toHaveLength(2);
    expect(results[0]?.content).toBe('al owner le gusta el café sin azúcar');
    expect(results[0]?.distance).toBeCloseTo(0, 5);
    expect(results[1]?.distance).toBeGreaterThan(results[0]?.distance ?? 0);
  });

  it('respeta el sessionId cuando se provee, y lo omite del resultado cuando no', () => {
    store.insert(
      {
        content: 'entrada con sesión',
        tipo: 'episodio',
        fuente: 'telegram_chat',
        fecha: '2026-07-25T00:00:00.000Z',
        modeloEmbedding: 'text-embedding-3-large:1024',
        sessionId: 'sess-1',
      },
      randomVector(1),
    );
    store.insert(
      {
        content: 'entrada sin sesión',
        tipo: 'hecho',
        fuente: 'gmail',
        fecha: '2026-07-25T00:00:00.000Z',
        modeloEmbedding: 'text-embedding-3-large:1024',
      },
      randomVector(2),
    );

    const results = store.queryKnn(randomVector(1), 5);
    const withSession = results.find((r) => r.content === 'entrada con sesión');
    const withoutSession = results.find(
      (r) => r.content === 'entrada sin sesión',
    );

    expect(withSession?.sessionId).toBe('sess-1');
    expect(withoutSession?.sessionId).toBeUndefined();
  });

  it('filtra por tipo, fuente y sessionId, y trunca a los k pedidos entre los que matchean', () => {
    for (let i = 0; i < 5; i += 1) {
      store.insert(
        {
          content: `preferencia ${i}`,
          tipo: 'preferencia',
          fuente: 'telegram_chat',
          fecha: '2026-07-25T00:00:00.000Z',
          modeloEmbedding: 'text-embedding-3-large:1024',
        },
        randomVector(i),
      );
    }
    store.insert(
      {
        content: 'hecho aislado',
        tipo: 'hecho',
        fuente: 'gmail',
        fecha: '2026-07-25T00:00:00.000Z',
        modeloEmbedding: 'text-embedding-3-large:1024',
      },
      randomVector(0),
    );

    const results = store.queryKnn(randomVector(0), 2, { tipo: 'preferencia' });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.tipo === 'preferencia')).toBe(true);
  });

  it('queryKnn devuelve [] si la tabla está vacía, sin lanzar', () => {
    const results = store.queryKnn(randomVector(0), 5);
    expect(results).toEqual([]);
  });

  it('filtra por sessionId, excluyendo entradas de otras sesiones', () => {
    store.insert(
      {
        content: 'de la sesión A',
        tipo: 'episodio',
        fuente: 'telegram_chat',
        fecha: '2026-07-25T00:00:00.000Z',
        modeloEmbedding: 'text-embedding-3-large:1024',
        sessionId: 'sess-A',
      },
      randomVector(0),
    );
    store.insert(
      {
        content: 'de la sesión B',
        tipo: 'episodio',
        fuente: 'telegram_chat',
        fecha: '2026-07-25T00:00:00.000Z',
        modeloEmbedding: 'text-embedding-3-large:1024',
        sessionId: 'sess-B',
      },
      randomVector(0),
    );

    const results = store.queryKnn(randomVector(0), 5, { sessionId: 'sess-A' });

    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe('de la sesión A');
  });
});
