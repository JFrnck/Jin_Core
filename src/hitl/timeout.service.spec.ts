import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { Db } from '../db/db.module';
import type { PendingApprovalRow } from '../db/schema';
import type { DualConfirmService } from './dual-confirm.service';
import {
  HITL_APPROVAL_ABANDONED_EVENT,
  HITL_APPROVAL_ESCALATED_EVENT,
  HITL_APPROVAL_STUCK_EVENT,
  TimeoutService,
} from './timeout.service';

// `getToolDefinition` real no tiene HOY ninguna tool con
// `timeoutBehavior: 'escalate'` (todas son 'discard' o el default) — sin
// mockear esto, las ramas escalate-warning/abandon de `decideTimeoutOutcome`
// serían inalcanzables desde este test con cualquier tool real registrada.
// `vi.hoisted` porque `vi.mock` se hoistea sobre los imports del archivo,
// que es donde `timeout.service.ts` importa `getToolDefinition`.
const { getToolDefinitionMock } = vi.hoisted(() => ({
  getToolDefinitionMock: vi.fn(),
}));
vi.mock('../tools/registry', () => ({
  getToolDefinition: getToolDefinitionMock,
}));

function buildPending(
  overrides: Partial<PendingApprovalRow> = {},
): PendingApprovalRow {
  return {
    requestId: 'req-1',
    toolName: 'someEscalatingTool',
    level: 'confirm',
    inputsHash: 'h1',
    planSummary: null,
    actor: null,
    externalInputsSummary: null,
    payload: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    firstApprovedAt: null,
    firstApprover: null,
    availableAt: null,
    escalatedAt: null,
    executingAt: null,
    executionError: null,
    ...overrides,
  };
}

describe('TimeoutService.sweep', () => {
  let mockDb: {
    select: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let mockAuditService: Partial<AuditService>;
  let mockDualConfirm: {
    claimForExecution: ReturnType<typeof vi.fn>;
    releaseClaim: ReturnType<typeof vi.fn>;
  };
  let mockEmit: ReturnType<typeof vi.fn>;
  let service: TimeoutService;
  let pendingRows: PendingApprovalRow[];

  beforeEach(() => {
    getToolDefinitionMock.mockReset();
    pendingRows = [];
    mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(pendingRows),
      }),
      update: vi.fn().mockReturnValue({
        set: vi
          .fn()
          .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
    mockAuditService = { recordTimeout: vi.fn().mockResolvedValue(undefined) };
    mockEmit = vi.fn();
    // Por defecto el reclamo se obtiene (nadie más está ejecutando la fila).
    mockDualConfirm = {
      claimForExecution: vi.fn().mockResolvedValue(buildPending()),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
    };

    service = new TimeoutService(
      mockDb as unknown as Db,
      mockAuditService as AuditService,
      { emit: mockEmit } as never,
      mockDualConfirm as unknown as DualConfirmService,
    );
  });

  // Issue #36: el barrido nunca compite con una ejecución en curso.
  it('una aprobación EJECUTÁNDOSE (reciente) no se descarta ni se audita, aunque haya vencido', async () => {
    getToolDefinitionMock.mockReturnValue(undefined);
    const now = new Date('2026-08-05T00:00:00.000Z');
    pendingRows.push(
      buildPending({
        createdAt: new Date('2000-01-01T00:00:00.000Z'),
        executingAt: new Date(now.getTime() - 5_000),
      }),
    );

    await service.sweep(now);

    expect(mockDualConfirm.claimForExecution).not.toHaveBeenCalled();
    expect(mockAuditService.recordTimeout).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('un reclamo TRABADO (>15 min) emite HITL_APPROVAL_STUCK_EVENT y no se reintenta ni se descarta', async () => {
    getToolDefinitionMock.mockReturnValue(undefined);
    const now = new Date('2026-08-05T00:00:00.000Z');
    pendingRows.push(
      buildPending({
        requestId: 'req-stuck',
        toolName: 'sendEmail',
        createdAt: new Date('2000-01-01T00:00:00.000Z'),
        executingAt: new Date(now.getTime() - 20 * 60_000),
      }),
    );

    await service.sweep(now);

    expect(mockEmit).toHaveBeenCalledWith(HITL_APPROVAL_STUCK_EVENT, {
      requestId: 'req-stuck',
      toolName: 'sendEmail',
    });
    expect(mockAuditService.recordTimeout).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('si otra solicitud reclamó la fila justo antes (claim perdido): no audita ni borra', async () => {
    getToolDefinitionMock.mockReturnValue(undefined);
    mockDualConfirm.claimForExecution.mockResolvedValue(undefined);
    pendingRows.push(
      buildPending({ createdAt: new Date('2000-01-01T00:00:00.000Z') }),
    );

    await service.sweep(new Date('2026-08-01T00:00:00.000Z'));

    expect(mockAuditService.recordTimeout).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('si el audit del timeout falla: libera el reclamo (el próximo barrido reintenta) y propaga el error', async () => {
    getToolDefinitionMock.mockReturnValue(undefined);
    (
      mockAuditService.recordTimeout as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('audit caído'));
    pendingRows.push(
      buildPending({
        requestId: 'req-audit-fail',
        createdAt: new Date('2000-01-01T00:00:00.000Z'),
      }),
    );

    await expect(
      service.sweep(new Date('2026-08-01T00:00:00.000Z')),
    ).rejects.toThrow('audit caído');

    expect(mockDualConfirm.releaseClaim).toHaveBeenCalledWith('req-audit-fail');
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('discard (default, sin tool con timeoutBehavior escalate): no emite ningún evento', async () => {
    getToolDefinitionMock.mockReturnValue(undefined);
    pendingRows.push(
      buildPending({ createdAt: new Date('2000-01-01T00:00:00.000Z') }),
    );

    await service.sweep(new Date('2026-08-01T00:00:00.000Z'));

    expect(mockAuditService.recordTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'timeout' }),
    );
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('escalate-warning (12h): emite HITL_APPROVAL_ESCALATED_EVENT con requestId/toolName', async () => {
    getToolDefinitionMock.mockReturnValue({
      name: 'someEscalatingTool',
      timeoutBehavior: 'escalate',
    });
    const now = new Date('2026-08-01T13:00:00.000Z');
    pendingRows.push(
      buildPending({
        requestId: 'req-escalate',
        toolName: 'someEscalatingTool',
        createdAt: new Date('2026-08-01T00:00:00.000Z'), // 13h antes de `now`, >12h
        escalatedAt: null,
      }),
    );

    await service.sweep(now);

    expect(mockEmit).toHaveBeenCalledWith(HITL_APPROVAL_ESCALATED_EVENT, {
      requestId: 'req-escalate',
      toolName: 'someEscalatingTool',
    });
  });

  it('ya escalada: no vuelve a emitir el evento de escalado en el próximo barrido', async () => {
    getToolDefinitionMock.mockReturnValue({
      name: 'someEscalatingTool',
      timeoutBehavior: 'escalate',
    });
    pendingRows.push(
      buildPending({
        createdAt: new Date('2026-08-01T00:00:01.000Z'),
        escalatedAt: new Date('2026-08-01T12:00:00.000Z'),
      }),
    );

    await service.sweep(new Date('2026-08-01T13:00:00.000Z'));

    expect(mockEmit).not.toHaveBeenCalledWith(
      HITL_APPROVAL_ESCALATED_EVENT,
      expect.anything(),
    );
  });

  it('abandon (24h): emite HITL_APPROVAL_ABANDONED_EVENT y audita, sin importar si ya había escalado', async () => {
    getToolDefinitionMock.mockReturnValue({
      name: 'someEscalatingTool',
      timeoutBehavior: 'escalate',
    });
    pendingRows.push(
      buildPending({
        requestId: 'req-abandon',
        toolName: 'someEscalatingTool',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        escalatedAt: new Date('2026-08-01T12:00:00.000Z'),
      }),
    );

    await service.sweep(new Date('2026-08-02T00:00:01.000Z')); // >24h

    expect(mockAuditService.recordTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-abandon',
        status: 'abandoned',
      }),
    );
    expect(mockEmit).toHaveBeenCalledWith(HITL_APPROVAL_ABANDONED_EVENT, {
      requestId: 'req-abandon',
      toolName: 'someEscalatingTool',
    });
  });

  it('none (dentro del TTL): no audita ni emite nada', async () => {
    getToolDefinitionMock.mockReturnValue({
      name: 'someEscalatingTool',
      timeoutBehavior: 'escalate',
    });
    pendingRows.push(
      buildPending({ createdAt: new Date('2026-08-01T11:00:00.000Z') }),
    );

    await service.sweep(new Date('2026-08-01T12:00:00.000Z')); // 1h, bajo cualquier umbral

    expect(mockAuditService.recordTimeout).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
