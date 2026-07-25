import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import {
  generateSessionNonce,
  wrapUntrustedContent,
} from '../../security/injection-sanitizer';
import { GoogleCalendarToolsService } from '../google/calendar/google-calendar-tools.service';
import { CanvasClientService } from './canvas-client.service';
import type { CanvasAnnouncement, CanvasAssignment } from './types';

export interface ListAssignmentsInput {
  readonly courseId?: number;
  readonly sessionNonce?: string;
  readonly requestId?: string;
}

export interface GetCourseContentInput {
  readonly courseIds: readonly number[];
  readonly sinceDate?: string;
  readonly sessionNonce?: string;
  readonly requestId?: string;
}

export interface ScheduleStudyBlockInput {
  readonly title: string;
  readonly startTime: string;
  readonly endTime: string;
}

function computeHash(data: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(data ?? {}))
    .digest('hex');
}

@Injectable()
export class CanvasToolsService {
  constructor(
    private readonly canvasClient: CanvasClientService,
    private readonly auditService: AuditService,
    private readonly googleCalendarTools: GoogleCalendarToolsService,
  ) {}

  /**
   * Handler para `canvasListAssignments` (`hitlLevel: 'auto'`).
   * Consulta tareas próximas de Canvas, sanitiza el contenido con
   * `wrapUntrustedContent` y registra en `AuditService`.
   */
  async executeListAssignments(input: ListAssignmentsInput): Promise<{
    readonly rawAssignments: readonly CanvasAssignment[];
    readonly wrappedContent: string;
  }> {
    const requestId = input.requestId ?? randomUUID();
    const nonce = input.sessionNonce ?? generateSessionNonce();

    const assignments = await this.canvasClient.getUpcomingAssignments(
      input.courseId,
    );

    const rawJson = JSON.stringify(assignments);
    const wrappedContent = wrapUntrustedContent(
      rawJson,
      'canvas_list_assignments',
      nonce,
    );

    const summary = `Consultadas ${assignments.length} tareas de Canvas`;

    await this.auditService.recordToolCall({
      requestId,
      actor: 'agent',
      toolName: 'canvasListAssignments',
      inputsHash: computeHash(input),
      planSummary: 'Listar tareas de Canvas LMS',
      approvalStatus: 'auto',
      externalInputsSummary: summary,
    });

    return {
      rawAssignments: assignments,
      wrappedContent,
    };
  }

  /**
   * Handler para `canvasGetCourseContent` (`hitlLevel: 'auto'`).
   * Consulta anuncios/materiales de los cursos seleccionados, sanitiza el
   * contenido con `wrapUntrustedContent` y registra en `AuditService`.
   */
  async executeGetCourseContent(input: GetCourseContentInput): Promise<{
    readonly announcements: readonly CanvasAnnouncement[];
    readonly wrappedContent: string;
  }> {
    const requestId = input.requestId ?? randomUUID();
    const nonce = input.sessionNonce ?? generateSessionNonce();
    const since = input.sinceDate
      ? new Date(input.sinceDate)
      : new Date(Date.now() - 24 * 60 * 60 * 1000);

    const announcements = await this.canvasClient.getCourseAnnouncements(
      input.courseIds,
      since,
    );

    const rawJson = JSON.stringify(announcements);
    const wrappedContent = wrapUntrustedContent(
      rawJson,
      'canvas_get_course_content',
      nonce,
    );

    const summary = `Consultados ${announcements.length} anuncios de Canvas de ${input.courseIds.length} curso(s)`;

    await this.auditService.recordToolCall({
      requestId,
      actor: 'agent',
      toolName: 'canvasGetCourseContent',
      inputsHash: computeHash(input),
      planSummary: 'Leer contenido de cursos en Canvas LMS',
      approvalStatus: 'auto',
      externalInputsSummary: summary,
    });

    return {
      announcements,
      wrappedContent,
    };
  }

  /**
   * Handler para `canvasScheduleStudyBlock` (`hitlLevel: 'notify'`).
   * Desbloqueado en la Fase 4.2: Crea un evento de bloque de estudio en
   * Google Calendar delegando a GoogleCalendarToolsService.
   */
  async executeScheduleStudyBlock(input: ScheduleStudyBlockInput) {
    return this.googleCalendarTools.createCalendarEvent({
      summary: input.title,
      start: new Date(input.startTime),
      end: new Date(input.endTime),
      description:
        'Bloque de estudio sugerido por Shadowing Académico (Canvas)',
    });
  }
}
