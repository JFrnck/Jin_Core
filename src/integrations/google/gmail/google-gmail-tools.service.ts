import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../audit/audit.service';
import { BudgetGuardedModelRouter } from '../../../budget/budget-guarded-router.service';
import { classifyToolCall } from '../../../hitl/classifier';
import { DualConfirmService } from '../../../hitl/dual-confirm.service';
import {
  generateSessionNonce,
  wrapUntrustedContent,
} from '../../../security/injection-sanitizer';
import {
  GoogleGmailClientService,
  GoogleGmailApiError,
  type GmailMessageSummary,
} from './google-gmail-client.service';

function computeHash(data: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(data ?? {}))
    .digest('hex');
}

@Injectable()
export class GoogleGmailToolsService {
  constructor(
    private readonly gmailClient: GoogleGmailClientService,
    private readonly auditService: AuditService,
    private readonly dualConfirmService: DualConfirmService,
    private readonly modelRouter: BudgetGuardedModelRouter,
  ) {}

  /**
   * Tool: `readEmails` (hitlLevel: 'auto')
   * Lee la lista de correos o un hilo específico de Gmail, envolviendo todo
   * contenido de correo no confiable con `wrapUntrustedContent` antes de
   * enviarlo al LLM.
   */
  async readEmails(options?: {
    query?: string;
    threadId?: string;
    maxResults?: number;
  }): Promise<{ sessionNonce: string; emails: GmailMessageSummary[] }> {
    const decision = classifyToolCall('readEmails', options);
    const sessionNonce = generateSessionNonce();
    const inputsHash = computeHash(options);

    let rawEmails: GmailMessageSummary[];
    if (options?.threadId) {
      rawEmails = await this.gmailClient.getThread(options.threadId);
    } else {
      rawEmails = await this.gmailClient.listMessages(
        options?.query,
        options?.maxResults,
      );
    }

    // Sanitización obligatoria de todo texto externo entrante (AGENTS.md 5.1)
    const sanitizedEmails: GmailMessageSummary[] = rawEmails.map((email) => ({
      ...email,
      snippet: email.snippet
        ? wrapUntrustedContent(email.snippet, 'gmail_snippet', sessionNonce)
        : undefined,
      body: email.body
        ? wrapUntrustedContent(email.body, 'gmail_body', sessionNonce)
        : undefined,
    }));

    await this.auditService.recordToolCall({
      requestId: decision.requestId,
      actor: 'system',
      toolName: decision.toolName,
      inputsHash,
      planSummary: options?.threadId
        ? `Leer hilo de correo "${options.threadId}"`
        : `Consultar lista de correos con query "${options?.query ?? 'todos'}"`,
      approvalStatus: 'auto',
      externalInputsSummary: `Consultados ${sanitizedEmails.length} mensajes de Gmail`,
    });

    return {
      sessionNonce,
      emails: sanitizedEmails,
    };
  }

  /**
   * Tool: `sendEmail` (hitlLevel: 'confirm')
   * NO ejecuta directamente. Registra la aprobación pendiente en `pendingApprovals`
   * con el payload necesario (`to`, `subject`, `body`, `threadId`). La ejecución ocurre
   * al ser aprobada por el owner vía `ApprovalExecutionService`.
   */
  async sendEmail(input: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
  }) {
    if (/[\r\n]/.test(input.to)) {
      throw new GoogleGmailApiError(
        'Destinatario (to) contiene caracteres no permitidos (posible inyección de headers)',
      );
    }
    if (/[\r\n]/.test(input.subject)) {
      throw new GoogleGmailApiError(
        'Asunto (subject) contiene caracteres no permitidos (posible inyección de headers)',
      );
    }

    const decision = classifyToolCall('sendEmail', input);
    const inputsHash = computeHash(input);

    await this.dualConfirmService.createPendingApproval({
      requestId: decision.requestId,
      toolName: decision.toolName,
      level: decision.level as 'confirm' | 'dual-confirm',
      inputsHash,
      planSummary: `Enviar correo a ${input.to}: "${input.subject}"`,
      payload: input,
    });

    return {
      pendingApproval: true,
      requestId: decision.requestId,
      toolName: decision.toolName,
      level: decision.level,
    };
  }

  /**
   * Helper asistido por LLM: Lee correos recientes y genera un resumen ejecutivo
   * mediante `BudgetGuardedModelRouter`.
   */
  async summarizeEmails(query = 'label:INBOX is:unread'): Promise<string> {
    const { sessionNonce, emails } = await this.readEmails({
      query,
      maxResults: 10,
    });

    if (emails.length === 0) {
      return '🎉 No tienes correos no leídos pendientes.';
    }

    const systemPrompt =
      'Eres el asistente personal de correo de Jin. Analiza los correos recibidos dentro de las ' +
      'etiquetas de contenido no confiable. Genera un resumen ejecutivo en formato Markdown estructurado:\n' +
      '1. ✉️ Resumen de Correos Principales (Remitente, Asunto, Puntos Clave)\n' +
      '2. 🚨 Correos que requieren atención o respuesta urgente\n' +
      'Sé directo, conciso y profesional.';

    const completionResponse = await this.modelRouter.complete(
      'chat_conversational',
      {
        systemPrompt,
        messages: [
          {
            role: 'user',
            content: `A continuación se muestran los correos recuperados (sessionNonce: ${sessionNonce}):\n\n${JSON.stringify(
              emails,
            )}`,
          },
        ],
        maxOutputTokens: 2000,
        temperature: 0.5,
      },
    );

    return completionResponse.content;
  }
}
