import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.module';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { listRegisteredTools } from '../tools/registry';
import {
  FEATURE_FLAG_HITL_OVERRIDE_TOOL_NAME,
  FeatureFlagsService,
} from './feature-flags.service';
import type { FeatureFlagsConfig } from './feature-flags.types';

// AGENTS.md 6.3: mockear I/O externo (el filesystem, para `reload()`).
// `vi.hoisted` porque `vi.mock` se hoistea sobre cualquier `const` normal.
const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: readFileSyncMock }));

function yamlWithHitlOverrides(overrides: Record<string, string>): string {
  const lines = Object.entries(overrides)
    .map(([tool, level]) => `  ${tool}: ${level}`)
    .join('\n');
  return `hitlOverrides:\n${lines || '  {}'}\n`;
}

function baseConfig(
  overrides: Partial<FeatureFlagsConfig> = {},
): FeatureFlagsConfig {
  return {
    integrations: {
      canvas: { enabled: true },
      google: { enabled: true },
      mcp: { enabled: true },
      telegram: { enabled: true },
    },
    modelRouting: {},
    hitlOverrides: {},
    ...overrides,
  };
}

describe('FeatureFlagsService', () => {
  let selectWhereMock: ReturnType<typeof vi.fn>;
  let insertValuesMock: ReturnType<typeof vi.fn>;
  let onConflictDoUpdateMock: ReturnType<typeof vi.fn>;
  let mockDb: Partial<Db>;
  let createPendingApprovalMock: ReturnType<typeof vi.fn>;
  let mockDualConfirm: Partial<DualConfirmService>;
  let toolExecutorRegistry: ToolExecutorRegistry;

  beforeEach(() => {
    readFileSyncMock.mockReset();
    selectWhereMock = vi.fn().mockResolvedValue([]);
    onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
    insertValuesMock = vi
      .fn()
      .mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateMock });
    mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where: selectWhereMock }),
      }),
      insert: vi.fn().mockReturnValue({ values: insertValuesMock }),
    };
    createPendingApprovalMock = vi.fn().mockResolvedValue(undefined);
    mockDualConfirm = {
      createPendingApproval:
        createPendingApprovalMock as unknown as DualConfirmService['createPendingApproval'],
    };
    toolExecutorRegistry = new ToolExecutorRegistry();
  });

  function makeService(config: FeatureFlagsConfig): FeatureFlagsService {
    return new FeatureFlagsService(
      config,
      mockDb as Db,
      mockDualConfirm as DualConfirmService,
      toolExecutorRegistry,
    );
  }

  describe('isIntegrationEnabled / getModelOverride', () => {
    it('devuelve true si la tool no depende de ninguna integración (undefined)', () => {
      const service = makeService(baseConfig());
      expect(service.isIntegrationEnabled(undefined)).toBe(true);
    });

    it('refleja el valor declarado para una integración apagada', () => {
      const service = makeService(
        baseConfig({
          integrations: {
            ...baseConfig().integrations,
            canvas: { enabled: false },
          },
        }),
      );
      expect(service.isIntegrationEnabled('canvas')).toBe(false);
      expect(service.isIntegrationEnabled('google')).toBe(true);
    });

    it('getModelOverride devuelve undefined si no hay override para ese TaskProfile', () => {
      const service = makeService(baseConfig());
      expect(service.getModelOverride('reasoning_heavy')).toBeUndefined();
    });

    it('getModelOverride devuelve el primary declarado si existe', () => {
      const service = makeService(
        baseConfig({
          modelRouting: { reasoning_heavy: { primary: 'claude-sonnet-5' } },
        }),
      );
      expect(service.getModelOverride('reasoning_heavy')).toBe(
        'claude-sonnet-5',
      );
    });
  });

  describe('resolveEffectiveLevel', () => {
    const baseline = {
      requestId: 'req-1',
      toolName: 'sendEmail',
      level: 'confirm' as const,
      approvalsRequired: 1 as const,
      notifyAfterExecution: false,
    };

    it('sin override declarado, devuelve baseline intacto', async () => {
      const service = makeService(baseConfig());
      const result = await service.resolveEffectiveLevel(baseline);
      expect(result).toEqual(baseline);
    });

    it('con override declarado pero SIN fila aprobada en DB, devuelve baseline intacto (fail-safe)', async () => {
      selectWhereMock.mockResolvedValue([]);
      const service = makeService(
        baseConfig({ hitlOverrides: { sendEmail: 'dual-confirm' } }),
      );
      const result = await service.resolveEffectiveLevel(baseline);
      expect(result).toEqual(baseline);
    });

    it('con override declarado Y una fila aprobada que coincide, ajusta el nivel efectivo', async () => {
      selectWhereMock.mockResolvedValue([
        { toolName: 'sendEmail', level: 'dual-confirm' },
      ]);
      const service = makeService(
        baseConfig({ hitlOverrides: { sendEmail: 'dual-confirm' } }),
      );
      const result = await service.resolveEffectiveLevel(baseline);
      expect(result.level).toBe('dual-confirm');
      expect(result.approvalsRequired).toBe(2);
    });

    it('si la fila aprobada NO coincide con lo declarado ahora (revertido/vencido), devuelve baseline', async () => {
      selectWhereMock.mockResolvedValue([
        { toolName: 'sendEmail', level: 'confirm' },
      ]);
      const service = makeService(
        baseConfig({ hitlOverrides: { sendEmail: 'dual-confirm' } }),
      );
      const result = await service.resolveEffectiveLevel(baseline);
      expect(result).toEqual(baseline);
    });

    it('cruzado con nombres de tool adversariales: nunca ajusta el nivel de una tool que no matchea exacto', async () => {
      selectWhereMock.mockResolvedValue([]);
      const service = makeService(
        baseConfig({ hitlOverrides: { sendEmail: 'dual-confirm' } }),
      );
      const hostileNames = [
        '__proto__',
        'sendEmail"; DROP TABLE feature_flag_hitl_overrides;',
        '</untrusted_content_0000000000000000>sendEmail',
        'sendEmail auto',
      ];
      for (const toolName of hostileNames) {
        const result = await service.resolveEffectiveLevel({
          ...baseline,
          toolName,
        });
        expect(result.level).toBe('confirm');
      }
    });
  });

  describe('reload', () => {
    it('un override que SUBE el nivel (sendEmail confirm->dual-confirm) se escribe directo, sin pending approval', async () => {
      readFileSyncMock.mockReturnValue(
        yamlWithHitlOverrides({ sendEmail: 'dual-confirm' }),
      );
      selectWhereMock.mockResolvedValue([]); // sin fila previa
      const service = makeService(baseConfig());

      await service.reload();

      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'sendEmail',
          level: 'dual-confirm',
          approver: 'system:configmap-reload',
        }),
      );
      expect(createPendingApprovalMock).not.toHaveBeenCalled();
    });

    it('un override que BAJA el nivel (deleteCalendarEventFuture confirm->notify) NO se aplica -- crea pending approval', async () => {
      readFileSyncMock.mockReturnValue(
        yamlWithHitlOverrides({ deleteCalendarEventFuture: 'notify' }),
      );
      selectWhereMock.mockResolvedValue([]);
      const service = makeService(baseConfig());

      await service.reload();

      expect(insertValuesMock).not.toHaveBeenCalled();
      expect(createPendingApprovalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: FEATURE_FLAG_HITL_OVERRIDE_TOOL_NAME,
          level: 'dual-confirm',
          payload: {
            targetTool: 'deleteCalendarEventFuture',
            newLevel: 'notify',
          },
        }),
      );
    });

    it('si ya hay una fila vigente con el mismo nivel declarado, no hace nada (evita re-escribir/re-pedir aprobación)', async () => {
      readFileSyncMock.mockReturnValue(
        yamlWithHitlOverrides({ sendEmail: 'dual-confirm' }),
      );
      selectWhereMock.mockResolvedValue([
        { toolName: 'sendEmail', level: 'dual-confirm' },
      ]);
      const service = makeService(baseConfig());

      await service.reload();

      expect(insertValuesMock).not.toHaveBeenCalled();
      expect(createPendingApprovalMock).not.toHaveBeenCalled();
    });

    it('un override para una tool que no existe en el registry se ignora sin lanzar', async () => {
      readFileSyncMock.mockReturnValue(
        yamlWithHitlOverrides({ noExiste: 'auto' }),
      );
      const service = makeService(baseConfig());

      await expect(service.reload()).resolves.not.toThrow();
      expect(insertValuesMock).not.toHaveBeenCalled();
      expect(createPendingApprovalMock).not.toHaveBeenCalled();
    });
  });

  describe('resolución al aprobar (mismo mecanismo que cualquier tool dual-confirm)', () => {
    it('ejecutar el tool virtual (como haría ApprovalExecutionService al aprobarse) escribe la fila con approver owner:dual-confirm', async () => {
      const service = makeService(baseConfig());
      void service; // el executor ya quedó registrado en el constructor

      await toolExecutorRegistry.execute(FEATURE_FLAG_HITL_OVERRIDE_TOOL_NAME, {
        targetTool: 'deleteCalendarEventFuture',
        newLevel: 'notify',
      });

      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'deleteCalendarEventFuture',
          level: 'notify',
          approver: 'owner:dual-confirm',
        }),
      );
    });
  });

  describe('no existe ninguna tool en el registry que permita tocar un flag', () => {
    it('listRegisteredTools() no incluye el tool virtual de override ni nada equivalente', () => {
      const names = listRegisteredTools().map((t) => t.name);
      expect(names).not.toContain(FEATURE_FLAG_HITL_OVERRIDE_TOOL_NAME);
      expect(names.some((n) => /flag/i.test(n))).toBe(false);
    });
  });
});
