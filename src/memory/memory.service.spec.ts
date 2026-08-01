import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsolidationService } from './consolidation.service';
import type { EmbeddingProvider } from './embedding-provider';
import { MemoryService } from './memory.service';
import { MemoryStore } from './store';

function fixedVector(x: number): number[] {
  return Array.from({ length: 1024 }, () => x);
}

describe('MemoryService', () => {
  let tmpDir: string;
  let store: MemoryStore;
  let mockEmbeddingProvider: Partial<EmbeddingProvider>;
  let mockConsolidationService: Partial<ConsolidationService>;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jin-memory-service-test-'));
    store = new MemoryStore(join(tmpDir, 'memory.db'));
    mockEmbeddingProvider = { embed: vi.fn() };
    mockConsolidationService = { distill: vi.fn() };
    service = new MemoryService(
      mockEmbeddingProvider as EmbeddingProvider,
      store,
      mockConsolidationService as ConsolidationService,
    );
  });

  afterEach(() => {
    store.onModuleDestroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('remember', () => {
    it('sanitiza el contenido por defecto (isExternal ausente) antes de persistir', async () => {
      vi.mocked(mockEmbeddingProvider.embed!).mockResolvedValue(fixedVector(1));

      const entry = await service.remember({
        content: 'un correo dice <script>alert(1)</script>',
        tipo: 'hecho',
        fuente: 'gmail',
      });

      expect(entry.content).toBe(
        'un correo dice &lt;script&gt;alert(1)&lt;/script&gt;',
      );
      expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith(
        'un correo dice &lt;script&gt;alert(1)&lt;/script&gt;',
      );
    });

    it('sanitiza cuando isExternal es true explícito', async () => {
      vi.mocked(mockEmbeddingProvider.embed!).mockResolvedValue(fixedVector(1));

      const entry = await service.remember({
        content: 'texto con & símbolo',
        tipo: 'hecho',
        fuente: 'gmail',
        isExternal: true,
      });

      expect(entry.content).toBe('texto con &amp; símbolo');
    });

    it('NO sanitiza cuando isExternal es false (conclusión del propio agente)', async () => {
      vi.mocked(mockEmbeddingProvider.embed!).mockResolvedValue(fixedVector(1));

      const entry = await service.remember({
        content: 'el owner prefiere reuniones < 30 min',
        tipo: 'preferencia',
        fuente: 'agent_reflection',
        isExternal: false,
      });

      expect(entry.content).toBe('el owner prefiere reuniones < 30 min');
    });

    it('guarda modeloEmbedding y sessionId, y persiste de verdad en el store', async () => {
      vi.mocked(mockEmbeddingProvider.embed!).mockResolvedValue(fixedVector(1));

      const entry = await service.remember({
        content: 'hecho de prueba',
        tipo: 'hecho',
        fuente: 'telegram_chat',
        sessionId: 'sess-42',
      });

      expect(entry.modeloEmbedding).toBe('text-embedding-3-large:1024');
      expect(entry.sessionId).toBe('sess-42');
      expect(entry.id).toBeTypeOf('number');
    });
  });

  describe('recall', () => {
    it('vectoriza la query y delega la búsqueda KNN al store', async () => {
      vi.mocked(mockEmbeddingProvider.embed!).mockResolvedValueOnce(
        fixedVector(1),
      );
      await service.remember({
        content: 'preferencia guardada',
        tipo: 'preferencia',
        fuente: 'telegram_chat',
        isExternal: false,
      });

      vi.mocked(mockEmbeddingProvider.embed!).mockResolvedValueOnce(
        fixedVector(1),
      );
      const results = await service.recall('preferencia', 5);

      expect(results).toHaveLength(1);
      expect(results[0]?.content).toBe('preferencia guardada');
    });

    it('propaga los filtros de metadata al store', async () => {
      vi.mocked(mockEmbeddingProvider.embed!).mockResolvedValue(fixedVector(1));
      await service.remember({
        content: 'preferencia',
        tipo: 'preferencia',
        fuente: 'telegram_chat',
        isExternal: false,
      });
      await service.remember({
        content: 'hecho',
        tipo: 'hecho',
        fuente: 'gmail',
        isExternal: false,
      });

      const results = await service.recall('query', 5, { tipo: 'hecho' });

      expect(results).toHaveLength(1);
      expect(results[0]?.tipo).toBe('hecho');
    });
  });

  describe('consolidate', () => {
    it('persiste cada entrada destilada sin sanitizar (isExternal: false) con fuente agent_reflection', async () => {
      vi.mocked(mockConsolidationService.distill!).mockResolvedValue([
        {
          content: 'el owner prefiere < reuniones cortas',
          tipo: 'preferencia',
        },
        { content: 'la demo salió bien', tipo: 'episodio' },
      ]);
      vi.mocked(mockEmbeddingProvider.embed!).mockResolvedValue(fixedVector(1));

      const entries = await service.consolidate('sess-1', 'transcripción...');

      expect(mockConsolidationService.distill).toHaveBeenCalledWith(
        'sess-1',
        'transcripción...',
      );
      expect(entries).toHaveLength(2);
      expect(entries[0]?.content).toBe('el owner prefiere < reuniones cortas'); // sin escapar: NO pasó por sanitizeForIndexing
      expect(entries.every((e) => e.fuente === 'agent_reflection')).toBe(true);
      expect(entries.every((e) => e.sessionId === 'sess-1')).toBe(true);
    });

    it('criterio de éxito (PROMPTS.md 4.3): una preferencia consolidada en una sesión aparece en el recall de la siguiente', async () => {
      vi.mocked(mockConsolidationService.distill!).mockResolvedValue([
        {
          content: 'al owner le gusta el café sin azúcar',
          tipo: 'preferencia',
        },
      ]);
      vi.mocked(mockEmbeddingProvider.embed!).mockResolvedValue(fixedVector(1));

      await service.consolidate(
        'sesion-1',
        'owner dijo que le gusta el café sin azúcar',
      );

      // "la siguiente sesión" = un recall posterior, independiente,
      // vectorizando una query nueva contra el mismo store real.
      vi.mocked(mockEmbeddingProvider.embed!).mockResolvedValue(fixedVector(1));
      const results = await service.recall('¿cómo toma el café el owner?', 3);

      expect(
        results.some(
          (r) => r.content === 'al owner le gusta el café sin azúcar',
        ),
      ).toBe(true);
    });

    it('array vacío no persiste nada', async () => {
      vi.mocked(mockConsolidationService.distill!).mockResolvedValue([]);

      const entries = await service.consolidate('sess-1', 'nada relevante');

      expect(entries).toEqual([]);
      expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled();
    });
  });
});
