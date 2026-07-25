import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../../audit/audit.service';
import type { DualConfirmService } from '../../../hitl/dual-confirm.service';
import type { GoogleCalendarClientService } from './google-calendar-client.service';
import { GoogleCalendarToolsService } from './google-calendar-tools.service';

describe('GoogleCalendarToolsService', () => {
  let service: GoogleCalendarToolsService;
  let mockClient: Partial<GoogleCalendarClientService>;
  let mockAuditService: Partial<AuditService>;
  let mockDualConfirmService: Partial<DualConfirmService>;

  beforeEach(() => {
    mockClient = {
      listEvents: vi
        .fn()
        .mockResolvedValue([{ id: 'e1', summary: 'Evento 1' }]),
      createEvent: vi
        .fn()
        .mockResolvedValue({ id: 'e2', summary: 'Evento Creado' }),
      updateEvent: vi
        .fn()
        .mockResolvedValue({ id: 'e1', summary: 'Evento Modificado' }),
      deleteEvent: vi.fn().mockResolvedValue(undefined),
    };

    mockAuditService = {
      recordToolCall: vi.fn().mockResolvedValue(undefined),
    };

    mockDualConfirmService = {
      createPendingApproval: vi.fn().mockResolvedValue(undefined),
    };

    service = new GoogleCalendarToolsService(
      mockClient as GoogleCalendarClientService,
      mockAuditService as AuditService,
      mockDualConfirmService as DualConfirmService,
    );
  });

  it('listCalendarEvents debe clasificar como auto y auditar', async () => {
    const result = await service.listCalendarEvents();
    expect(result.length).toBe(1);
    expect(mockAuditService.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'listCalendarEvents',
        approvalStatus: 'auto',
      }),
    );
  });

  it('createCalendarEvent debe clasificar como notify, ejecutar y auditar', async () => {
    const result = await service.createCalendarEvent({
      summary: 'Reunión',
      start: new Date(),
      end: new Date(),
    });
    expect(result.id).toBe('e2');
    expect(mockAuditService.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'createCalendarEvent',
        approvalStatus: 'notified',
      }),
    );
  });

  it('deleteCalendarEventPast debe clasificar como notify, ejecutar y auditar', async () => {
    const result = await service.deleteCalendarEventPast({ eventId: 'e-past' });
    expect(result.deleted).toBe(true);
    expect(mockClient.deleteEvent).toHaveBeenCalledWith('e-past');
    expect(mockAuditService.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'deleteCalendarEventPast',
        approvalStatus: 'notified',
      }),
    );
  });

  it('deleteCalendarEventFuture debe clasificar como confirm y diferir en pendingApprovals', async () => {
    const result = await service.deleteCalendarEventFuture({
      eventId: 'e-future',
    });
    expect(result.pendingApproval).toBe(true);
    expect(result.level).toBe('confirm');
    expect(mockClient.deleteEvent).not.toHaveBeenCalled();
    expect(mockDualConfirmService.createPendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'deleteCalendarEventFuture',
        level: 'confirm',
        payload: { eventId: 'e-future' },
      }),
    );
  });
});
