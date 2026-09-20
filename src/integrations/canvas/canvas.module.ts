import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BudgetModule } from '../../budget/budget.module';
import { HitlModule } from '../../hitl/hitl.module';
import { ToolExecutorRegistry } from '../../hitl/tool-executor.registry';
import { GoogleCalendarClientService } from '../google/calendar/google-calendar-client.service';
import { GoogleModule } from '../google/google.module';
import { CanvasClientService } from './canvas-client.service';
import { CanvasToolsService } from './canvas-tools.service';
import { MorningAlertService } from './morning-alert.service';
import { ShadowingService } from './shadowing.service';

@Module({
  imports: [AuditModule, BudgetModule, HitlModule, GoogleModule],
  providers: [
    CanvasClientService,
    CanvasToolsService,
    ShadowingService,
    MorningAlertService,
  ],
  exports: [CanvasClientService, CanvasToolsService, ShadowingService],
})
export class CanvasModule implements OnModuleInit {
  constructor(
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly canvasClientService: CanvasClientService,
    private readonly calendarClientService: GoogleCalendarClientService,
  ) {}

  onModuleInit(): void {
    // Registrar ejecutor para `canvasListAssignments`
    this.toolExecutorRegistry.register(
      'canvasListAssignments',
      async (payload) => {
        const { courseId } = (payload ?? {}) as { courseId?: number };
        return this.canvasClientService.getUpcomingAssignments(courseId);
      },
    );

    // Registrar ejecutor para `canvasGetCourseContent`
    this.toolExecutorRegistry.register(
      'canvasGetCourseContent',
      async (payload) => {
        const { courseIds, sinceDate } = (payload ?? {}) as {
          courseIds: readonly number[];
          sinceDate?: string;
        };
        const since = sinceDate
          ? new Date(sinceDate)
          : new Date(Date.now() - 24 * 60 * 60 * 1000);
        return this.canvasClientService.getCourseAnnouncements(
          courseIds ?? [],
          since,
        );
      },
    );

    // Registrar ejecutor para `canvasScheduleStudyBlock`
    this.toolExecutorRegistry.register(
      'canvasScheduleStudyBlock',
      async (payload) => {
        const { title, startTime, endTime } = payload as {
          title: string;
          startTime: string;
          endTime: string;
        };
        return this.calendarClientService.createEvent({
          summary: title,
          start: new Date(startTime),
          end: new Date(endTime),
          description:
            'Bloque de estudio sugerido por Shadowing Académico (Canvas)',
        });
      },
    );
  }
}
