import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BudgetModule } from '../../budget/budget.module';
import { HitlModule } from '../../hitl/hitl.module';
import { ToolExecutorRegistry } from '../../hitl/tool-executor.registry';
import { GoogleCalendarClientService } from './calendar/google-calendar-client.service';
import { GoogleCalendarToolsService } from './calendar/google-calendar-tools.service';
import { GoogleGmailClientService } from './gmail/google-gmail-client.service';
import { GoogleGmailToolsService } from './gmail/google-gmail-tools.service';
import { GoogleOAuthService } from './oauth.service';

@Module({
  imports: [AuditModule, BudgetModule, HitlModule],
  providers: [
    GoogleOAuthService,
    GoogleCalendarClientService,
    GoogleCalendarToolsService,
    GoogleGmailClientService,
    GoogleGmailToolsService,
  ],
  exports: [
    GoogleOAuthService,
    GoogleCalendarClientService,
    GoogleCalendarToolsService,
    GoogleGmailClientService,
    GoogleGmailToolsService,
  ],
})
export class GoogleModule implements OnModuleInit {
  constructor(
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly gmailClientService: GoogleGmailClientService,
    private readonly calendarClientService: GoogleCalendarClientService,
  ) {}

  onModuleInit(): void {
    // Registrar ejecutor para `sendEmail`
    this.toolExecutorRegistry.register('sendEmail', async (payload) => {
      const { to, subject, body, threadId } = payload as {
        to: string;
        subject: string;
        body: string;
        threadId?: string;
      };
      return this.gmailClientService.sendEmail(to, subject, body, threadId);
    });

    // Registrar ejecutor para `readEmails`
    this.toolExecutorRegistry.register('readEmails', async (payload) => {
      const { query, threadId, maxResults } = (payload ?? {}) as {
        query?: string;
        threadId?: string;
        maxResults?: number;
      };
      if (threadId) {
        return this.gmailClientService.getThread(threadId);
      }
      return this.gmailClientService.listMessages(query, maxResults);
    });

    // Registrar ejecutor para `listCalendarEvents`
    this.toolExecutorRegistry.register(
      'listCalendarEvents',
      async (payload) => {
        const { timeMin, timeMax, maxResults } = (payload ?? {}) as {
          timeMin?: string;
          timeMax?: string;
          maxResults?: number;
        };
        const opts: { timeMin?: Date; timeMax?: Date; maxResults?: number } =
          {};
        if (timeMin) opts.timeMin = new Date(timeMin);
        if (timeMax) opts.timeMax = new Date(timeMax);
        if (maxResults !== undefined) opts.maxResults = maxResults;
        return this.calendarClientService.listEvents(opts);
      },
    );

    // Registrar ejecutor para `createCalendarEvent`
    this.toolExecutorRegistry.register(
      'createCalendarEvent',
      async (payload) => {
        const { summary, description, location, start, end } = payload as {
          summary: string;
          description?: string;
          location?: string;
          start: string;
          end: string;
        };
        const eventData: {
          summary: string;
          description?: string;
          location?: string;
          start: Date;
          end: Date;
        } = {
          summary,
          start: new Date(start),
          end: new Date(end),
        };
        if (description) eventData.description = description;
        if (location) eventData.location = location;
        return this.calendarClientService.createEvent(eventData);
      },
    );

    // Registrar ejecutor para `updateCalendarEvent`
    this.toolExecutorRegistry.register(
      'updateCalendarEvent',
      async (payload) => {
        const { eventId, eventData } = payload as {
          eventId: string;
          eventData: {
            summary?: string;
            description?: string;
            location?: string;
            start?: string;
            end?: string;
          };
        };
        const updateData: {
          summary?: string;
          description?: string;
          location?: string;
          start?: Date;
          end?: Date;
        } = {};
        if (eventData.summary !== undefined)
          updateData.summary = eventData.summary;
        if (eventData.description !== undefined)
          updateData.description = eventData.description;
        if (eventData.location !== undefined)
          updateData.location = eventData.location;
        if (eventData.start) updateData.start = new Date(eventData.start);
        if (eventData.end) updateData.end = new Date(eventData.end);
        return this.calendarClientService.updateEvent(eventId, updateData);
      },
    );

    // Registrar ejecutor para `deleteCalendarEventPast`
    this.toolExecutorRegistry.register(
      'deleteCalendarEventPast',
      async (payload) => {
        const { eventId } = payload as { eventId: string };
        return this.calendarClientService.deleteEvent(eventId);
      },
    );

    // Registrar ejecutor para `deleteCalendarEventFuture`
    this.toolExecutorRegistry.register(
      'deleteCalendarEventFuture',
      async (payload) => {
        const { eventId } = payload as { eventId: string };
        return this.calendarClientService.deleteEvent(eventId);
      },
    );
  }
}
