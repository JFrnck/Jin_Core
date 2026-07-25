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
    // Registrar el ejecutor de la herramienta `sendEmail` para ser invocado
    // automáticamente cuando la aprobación HITL se resuelva (PR #8)
    this.toolExecutorRegistry.register('sendEmail', async (payload) => {
      const { to, subject, body, threadId } = payload as {
        to: string;
        subject: string;
        body: string;
        threadId?: string;
      };
      return this.gmailClientService.sendEmail(to, subject, body, threadId);
    });

    // Registrar el ejecutor de la herramienta `deleteCalendarEventFuture`
    this.toolExecutorRegistry.register(
      'deleteCalendarEventFuture',
      async (payload) => {
        const { eventId } = payload as { eventId: string };
        return this.calendarClientService.deleteEvent(eventId);
      },
    );
  }
}
