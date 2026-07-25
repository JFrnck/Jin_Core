import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../audit/audit.service';
import type { GoogleCalendarToolsService } from '../google/calendar/google-calendar-tools.service';
import type { CanvasClientService } from './canvas-client.service';
import { CanvasToolsService } from './canvas-tools.service';

describe('CanvasToolsService', () => {
  let service: CanvasToolsService;
  let mockCanvasClient: Partial<CanvasClientService>;
  let mockAuditService: Partial<AuditService>;
  let mockGoogleCalendarTools: Partial<GoogleCalendarToolsService>;

  beforeEach(() => {
    mockCanvasClient = {
      getUpcomingAssignments: vi
        .fn()
        .mockResolvedValue([
          { id: 1, name: 'Tarea de Álgebra', course_id: 10 },
        ]),
      getCourseAnnouncements: vi.fn().mockResolvedValue([
        {
          id: 2,
          title: 'Aviso importante',
          message: 'Examen mañana',
          posted_at: '2026-07-23',
        },
      ]),
    };

    mockAuditService = {
      recordToolCall: vi.fn().mockResolvedValue(undefined),
    };

    mockGoogleCalendarTools = {
      createCalendarEvent: vi.fn().mockResolvedValue({
        id: 'cal-event-1',
        summary: 'Estudiar Cálculo',
      }),
    };

    service = new CanvasToolsService(
      mockCanvasClient as CanvasClientService,
      mockAuditService as AuditService,
      mockGoogleCalendarTools as GoogleCalendarToolsService,
    );
  });

  it('executeListAssignments debe obtener tareas, envolver el contenido en untrusted_content y auditar', async () => {
    const result = await service.executeListAssignments({
      courseId: 10,
      sessionNonce: '0123456789abcdef',
      requestId: 'test-req-123',
    });

    expect(result.rawAssignments).toHaveLength(1);
    expect(result.wrappedContent).toContain(
      '<untrusted_content_0123456789abcdef source="canvas_list_assignments">',
    );
    expect(result.wrappedContent).toContain('Tarea de Álgebra');
    expect(mockAuditService.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'test-req-123',
        toolName: 'canvasListAssignments',
        approvalStatus: 'auto',
        externalInputsSummary: 'Consultadas 1 tareas de Canvas',
      }),
    );
  });

  it('executeGetCourseContent debe obtener anuncios, envolver el contenido en untrusted_content y auditar', async () => {
    const result = await service.executeGetCourseContent({
      courseIds: [10],
      sessionNonce: '0123456789abcdef',
      requestId: 'test-req-456',
    });

    expect(result.announcements).toHaveLength(1);
    expect(result.wrappedContent).toContain(
      '<untrusted_content_0123456789abcdef source="canvas_get_course_content">',
    );
    expect(result.wrappedContent).toContain('Examen mañana');
    expect(mockAuditService.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'test-req-456',
        toolName: 'canvasGetCourseContent',
        approvalStatus: 'auto',
        externalInputsSummary: 'Consultados 1 anuncios de Canvas de 1 curso(s)',
      }),
    );
  });

  it('executeScheduleStudyBlock debe delegar la creación del evento a GoogleCalendarToolsService', async () => {
    const result = await service.executeScheduleStudyBlock({
      title: 'Estudiar Cálculo',
      startTime: '2026-07-24T10:00:00Z',
      endTime: '2026-07-24T12:00:00Z',
    });

    expect(mockGoogleCalendarTools.createCalendarEvent).toHaveBeenCalledWith({
      summary: 'Estudiar Cálculo',
      start: new Date('2026-07-24T10:00:00Z'),
      end: new Date('2026-07-24T12:00:00Z'),
      description:
        'Bloque de estudio sugerido por Shadowing Académico (Canvas)',
    });
    expect(result).toEqual({
      id: 'cal-event-1',
      summary: 'Estudiar Cálculo',
    });
  });
});
