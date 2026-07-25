import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../audit/audit.service';
import { classifyToolCall } from '../../../hitl/classifier';
import { DualConfirmService } from '../../../hitl/dual-confirm.service';
import {
  GoogleCalendarClientService,
  type CalendarEventInput,
} from './google-calendar-client.service';

function computeHash(data: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(data ?? {}))
    .digest('hex');
}

@Injectable()
export class GoogleCalendarToolsService {
  constructor(
    private readonly calendarClient: GoogleCalendarClientService,
    private readonly auditService: AuditService,
    private readonly dualConfirmService: DualConfirmService,
  ) {}

  /**
   * Tool: `listCalendarEvents` (hitlLevel: 'auto')
   */
  async listCalendarEvents(options?: {
    timeMin?: Date;
    timeMax?: Date;
    maxResults?: number;
  }) {
    const decision = classifyToolCall('listCalendarEvents', options);
    const inputsHash = computeHash(options);

    const items = await this.calendarClient.listEvents(options);

    await this.auditService.recordToolCall({
      requestId: decision.requestId,
      actor: 'system',
      toolName: decision.toolName,
      inputsHash,
      planSummary: 'Listar eventos de Google Calendar',
      approvalStatus: 'auto',
      externalInputsSummary: `Consultados ${items.length} eventos de Calendar`,
    });

    return items;
  }

  /**
   * Tool: `createCalendarEvent` (hitlLevel: 'notify')
   */
  async createCalendarEvent(eventData: CalendarEventInput) {
    const decision = classifyToolCall('createCalendarEvent', eventData);
    const inputsHash = computeHash(eventData);

    const event = await this.calendarClient.createEvent(eventData);

    await this.auditService.recordToolCall({
      requestId: decision.requestId,
      actor: 'system',
      toolName: decision.toolName,
      inputsHash,
      planSummary: `Crear evento "${eventData.summary}" en Google Calendar`,
      approvalStatus: 'notified',
    });

    return event;
  }

  /**
   * Tool: `updateCalendarEvent` (hitlLevel: 'notify')
   */
  async updateCalendarEvent(input: {
    eventId: string;
    eventData: Partial<CalendarEventInput>;
  }) {
    const decision = classifyToolCall('updateCalendarEvent', input);
    const inputsHash = computeHash(input);

    const event = await this.calendarClient.updateEvent(
      input.eventId,
      input.eventData,
    );

    await this.auditService.recordToolCall({
      requestId: decision.requestId,
      actor: 'system',
      toolName: decision.toolName,
      inputsHash,
      planSummary: `Actualizar evento "${input.eventId}" en Google Calendar`,
      approvalStatus: 'notified',
    });

    return event;
  }

  /**
   * Tool: `deleteCalendarEventPast` (hitlLevel: 'notify')
   */
  async deleteCalendarEventPast(input: { eventId: string }) {
    const decision = classifyToolCall('deleteCalendarEventPast', input);
    const inputsHash = computeHash(input);

    await this.calendarClient.deleteEvent(input.eventId);

    await this.auditService.recordToolCall({
      requestId: decision.requestId,
      actor: 'system',
      toolName: decision.toolName,
      inputsHash,
      planSummary: `Borrar evento pasado "${input.eventId}" de Google Calendar`,
      approvalStatus: 'notified',
    });

    return { deleted: true, eventId: input.eventId };
  }

  /**
   * Tool: `deleteCalendarEventFuture` (hitlLevel: 'confirm')
   * NO ejecuta directamente. Registra la aprobación pendiente en `pendingApprovals`
   * con el payload necesario. La ejecución ocurre al ser aprobada por el owner.
   */
  async deleteCalendarEventFuture(input: { eventId: string }) {
    const decision = classifyToolCall('deleteCalendarEventFuture', input);
    const inputsHash = computeHash(input);

    await this.dualConfirmService.createPendingApproval({
      requestId: decision.requestId,
      toolName: decision.toolName,
      level: decision.level as 'confirm' | 'dual-confirm',
      inputsHash,
      planSummary: `Borrar evento futuro "${input.eventId}" de Google Calendar`,
      payload: { eventId: input.eventId },
    });

    return {
      pendingApproval: true,
      requestId: decision.requestId,
      toolName: decision.toolName,
      level: decision.level,
    };
  }
}
