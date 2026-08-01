import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AuditService } from '../../audit/audit.service';
import { BudgetGuardedModelRouter } from '../../budget/budget-guarded-router.service';
import {
  generateSessionNonce,
  wrapUntrustedContent,
} from '../../security/injection-sanitizer';
import { CanvasClientService } from './canvas-client.service';
import type { ShadowingResult } from './types';

function computeHash(data: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(data ?? {}))
    .digest('hex');
}

@Injectable()
export class ShadowingService {
  private readonly logger = new Logger(ShadowingService.name);

  constructor(
    private readonly canvasClient: CanvasClientService,
    private readonly modelRouter: BudgetGuardedModelRouter,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Cron nocturno (00:00 local) que revisa automáticamente los cambios en Canvas
   * de las últimas 24 horas y genera el informe de Shadowing Académico.
   */
  @Cron('0 0 * * *')
  async handleCron(): Promise<void> {
    this.logger.log(
      'Iniciando tarea programada de Shadowing Académico nocturno...',
    );
    try {
      const result = await this.runShadowing();
      this.logger.log(
        `Shadowing completado con éxito. Procesados ${result.coursesChecked} cursos, ` +
          `${result.recentAnnouncementsCount} anuncios y ${result.upcomingAssignmentsCount} tareas.`,
      );
    } catch (err) {
      this.logger.error(
        'Error durante la ejecución del Shadowing Académico nocturno',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Ejecuta el flujo completo de Shadowing Académico:
   * 1. Consulta cursos activos, tareas próximas y anuncios (últimas 24h).
   * 2. Sanitiza todo el contenido con `wrapUntrustedContent`.
   * 3. Genera un resumen con Gemini 3.1 Pro vía
   *    `BudgetGuardedModelRouter.complete('long_context', ...)` — pasa
   *    por el chequeo de presupuesto/kill switch (Fase 4.1) antes de
   *    llegar al `ModelRouterService` real.
   * 4. Registra la auditoría en `AuditService`.
   */
  async runShadowing(sinceDate?: Date): Promise<ShadowingResult> {
    const requestId = randomUUID();
    const sessionNonce = generateSessionNonce();
    const since = sinceDate ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

    const courses = await this.canvasClient.getActiveCourses();
    const courseIds = courses.map((c) => c.id);

    const [announcements, upcomingAssignments] = await Promise.all([
      this.canvasClient.getCourseAnnouncements(courseIds, since),
      this.canvasClient.getUpcomingAssignments(),
    ]);

    const canvasPayload = {
      since: since.toISOString(),
      coursesCount: courses.length,
      announcements,
      upcomingAssignments,
    };

    const payloadJson = JSON.stringify(canvasPayload);
    const wrappedContent = wrapUntrustedContent(
      payloadJson,
      'canvas_shadowing',
      sessionNonce,
    );

    const systemPrompt =
      'Eres el asistente académico personal de Jin. Analiza la información académica de Canvas LMS recibida ' +
      'dentro de las etiquetas de contenido no confiable. Genera un resumen ejecutivo en formato Markdown con las ' +
      'siguientes secciones:\n' +
      '1. 📌 Anuncios Recientes Relevantes\n' +
      '2. ⏰ Próximas Entregas y Deadlines\n' +
      '3. 💡 Acciones Sugeridas para hoy\n' +
      'Mantén un tono profesional, directo y conciso.';

    const completionResponse = await this.modelRouter.complete('long_context', {
      systemPrompt,
      messages: [
        {
          role: 'user',
          content: `A continuación se presentan las actualizaciones de Canvas LMS:\n\n${wrappedContent}`,
        },
      ],
      maxOutputTokens: 8000,
      temperature: 0.4,
    });

    const externalInputsSummary =
      `Shadowing: ${courses.length} cursos, ${announcements.length} anuncios, ` +
      `${upcomingAssignments.length} entregables próximos.`;

    await this.auditService.recordToolCall({
      requestId,
      actor: 'system_cron',
      toolName: 'canvas_shadowing_cron',
      inputsHash: computeHash({ since: since.toISOString() }),
      planSummary: 'Ejecución de Shadowing Académico nocturno',
      approvalStatus: 'auto',
      externalInputsSummary,
    });

    return {
      sessionNonce,
      coursesChecked: courses.length,
      recentAnnouncementsCount: announcements.length,
      upcomingAssignmentsCount: upcomingAssignments.length,
      summaryMarkdown: completionResponse.content,
      modelId: completionResponse.modelId,
    };
  }
}
