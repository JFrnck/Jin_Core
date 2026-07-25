import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../../audit/audit.service';
import type { BudgetGuardedModelRouter } from '../../../budget/budget-guarded-router.service';
import type { DualConfirmService } from '../../../hitl/dual-confirm.service';
import type { GoogleGmailClientService } from './google-gmail-client.service';
import { GoogleGmailToolsService } from './google-gmail-tools.service';

describe('GoogleGmailToolsService', () => {
  let service: GoogleGmailToolsService;
  let mockClient: Partial<GoogleGmailClientService>;
  let mockAuditService: Partial<AuditService>;
  let mockDualConfirmService: Partial<DualConfirmService>;
  let mockModelRouter: Partial<BudgetGuardedModelRouter>;

  beforeEach(() => {
    mockClient = {
      listMessages: vi.fn().mockResolvedValue([
        {
          id: 'm1',
          threadId: 't1',
          snippet: 'Correo importante de prueba',
          body: 'Hola, este es un cuerpo de correo',
        },
      ]),
      getThread: vi.fn().mockResolvedValue([
        {
          id: 'm1',
          threadId: 't1',
          snippet: 'Mensaje en el hilo',
          body: 'Texto del hilo',
        },
      ]),
      sendEmail: vi.fn().mockResolvedValue({ id: 'sent-1', threadId: 't1' }),
    };

    mockAuditService = {
      recordToolCall: vi.fn().mockResolvedValue(undefined),
    };

    mockDualConfirmService = {
      createPendingApproval: vi.fn().mockResolvedValue(undefined),
    };

    mockModelRouter = {
      complete: vi.fn().mockResolvedValue({
        content: '### Resumen de Correos\n- Correo importante de prueba',
        modelId: 'claude-sonnet-5',
        inputTokens: 20,
        outputTokens: 30,
      }),
    };

    service = new GoogleGmailToolsService(
      mockClient as GoogleGmailClientService,
      mockAuditService as AuditService,
      mockDualConfirmService as DualConfirmService,
      mockModelRouter as BudgetGuardedModelRouter,
    );
  });

  it('readEmails debe envolver el contenido entrante con wrapUntrustedContent y auditar como auto', async () => {
    const result = await service.readEmails();
    expect(result.emails.length).toBe(1);
    expect(result.emails[0]?.snippet).toContain('untrusted_content_');
    expect(result.emails[0]?.body).toContain('untrusted_content_');

    expect(mockAuditService.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'readEmails',
        approvalStatus: 'auto',
      }),
    );
  });

  it('sendEmail debe clasificar como confirm y diferir la ejecución en pendingApprovals', async () => {
    const result = await service.sendEmail({
      to: 'peer@example.com',
      subject: 'Prueba',
      body: 'Cuerpo',
    });

    expect(result.pendingApproval).toBe(true);
    expect(result.level).toBe('confirm');

    expect(mockClient.sendEmail).not.toHaveBeenCalled();
    expect(mockDualConfirmService.createPendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'sendEmail',
        level: 'confirm',
        payload: {
          to: 'peer@example.com',
          subject: 'Prueba',
          body: 'Cuerpo',
        },
      }),
    );
  });

  it('sendEmail debe rechazar intentos de inyección CRLF en destinatario o asunto', async () => {
    await expect(
      service.sendEmail({
        to: 'peer@example.com\r\nBcc: evil@domain.com',
        subject: 'Normal',
        body: 'Cuerpo',
      }),
    ).rejects.toThrow('Destinatario (to) contiene caracteres no permitidos');

    await expect(
      service.sendEmail({
        to: 'peer@example.com',
        subject: 'Header\nInjection',
        body: 'Cuerpo',
      }),
    ).rejects.toThrow('Asunto (subject) contiene caracteres no permitidos');
  });

  it('summarizeEmails debe leer correos y llamar a BudgetGuardedModelRouter', async () => {
    const summary = await service.summarizeEmails();
    expect(summary).toContain('Resumen de Correos');
    expect(mockModelRouter.complete).toHaveBeenCalledWith(
      'chat_conversational',
      expect.objectContaining({
        maxOutputTokens: 2000,
        temperature: 0.5,
      }),
    );
  });
});
