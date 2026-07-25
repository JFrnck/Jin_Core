import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleOAuthService } from '../oauth.service';
import {
  GoogleGmailClientService,
  GoogleGmailRateLimitError,
} from './google-gmail-client.service';

vi.mock('googleapis', () => {
  const mockMessagesList = vi.fn().mockResolvedValue({
    data: { messages: [{ id: 'msg-1' }] },
  });
  const mockMessagesGet = vi.fn().mockResolvedValue({
    data: {
      id: 'msg-1',
      threadId: 'th-1',
      snippet: 'Un mensaje de prueba',
      payload: {
        headers: [
          { name: 'From', value: 'sender@example.com' },
          { name: 'Subject', value: 'Asunto de prueba' },
        ],
        body: { data: Buffer.from('Contenido del mensaje').toString('base64') },
      },
    },
  });
  const mockThreadsGet = vi.fn().mockResolvedValue({
    data: {
      messages: [
        {
          id: 'msg-1',
          threadId: 'th-1',
          snippet: 'Un mensaje en el hilo',
          payload: { headers: [{ name: 'Subject', value: 'Hilo' }] },
        },
      ],
    },
  });
  const mockMessagesSend = vi.fn().mockResolvedValue({
    data: { id: 'msg-sent-1', threadId: 'th-1' },
  });

  return {
    google: {
      gmail: vi.fn().mockReturnValue({
        users: {
          messages: {
            list: mockMessagesList,
            get: mockMessagesGet,
            send: mockMessagesSend,
          },
          threads: {
            get: mockThreadsGet,
          },
        },
      }),
    },
  };
});

describe('GoogleGmailClientService', () => {
  let service: GoogleGmailClientService;
  let mockOAuthService: Partial<GoogleOAuthService>;

  beforeEach(() => {
    mockOAuthService = {
      getOAuth2Client: vi.fn().mockReturnValue({}),
    };

    service = new GoogleGmailClientService(
      mockOAuthService as GoogleOAuthService,
    );
  });

  it('debe listar mensajes correctamente', async () => {
    const list = await service.listMessages();
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe('msg-1');
  });

  it('debe obtener un hilo de correo', async () => {
    const thread = await service.getThread('th-1');
    expect(thread.length).toBe(1);
    expect(thread[0]?.threadId).toBe('th-1');
  });

  it('debe enviar un correo', async () => {
    const res = await service.sendEmail(
      'dest@example.com',
      'Hola',
      'Cuerpo del mensaje',
    );
    expect(res.id).toBe('msg-sent-1');
  });

  it('debe rechazar inyección de headers CRLF en destinatario o asunto', async () => {
    await expect(
      service.sendEmail(
        'dest@example.com\r\nBcc: evil@attacker.com',
        'Hola',
        'Cuerpo',
      ),
    ).rejects.toThrow('Destinatario (to) contiene caracteres no permitidos');

    await expect(
      service.sendEmail(
        'dest@example.com',
        'Asunto\nInjected-Header: 123',
        'Cuerpo',
      ),
    ).rejects.toThrow('Asunto (subject) contiene caracteres no permitidos');
  });

  it('debe aplicar rate limiting lanzando GoogleGmailRateLimitError si se superan 60 peticiones/min', async () => {
    for (let i = 0; i < 60; i++) {
      await service.getMessage('msg-1');
    }
    await expect(service.getMessage('msg-1')).rejects.toThrow(
      GoogleGmailRateLimitError,
    );
  });
});
