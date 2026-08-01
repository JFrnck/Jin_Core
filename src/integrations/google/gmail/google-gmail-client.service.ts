import { Injectable, Logger } from '@nestjs/common';
import { google, type gmail_v1 } from 'googleapis';
import { JinError } from '../../../common/errors/jin-error';
import { GoogleOAuthService } from '../oauth.service';

export class GoogleGmailRateLimitError extends JinError {
  constructor() {
    super(
      'Límite de tasa (rate limit) de Gmail alcanzado (máximo 60 peticiones/minuto).',
      { code: 'GOOGLE_GMAIL_RATE_LIMIT_EXCEEDED', httpStatus: 429 },
    );
  }
}

export class GoogleGmailApiError extends JinError {
  constructor(message: string, cause?: unknown) {
    super(`Error en Gmail API: ${message}`, {
      code: 'GOOGLE_GMAIL_API_ERROR',
      httpStatus: 502,
      cause,
    });
  }
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  snippet?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  date?: string | undefined;
  body?: string | undefined;
}

function assertNoHeaderInjection(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new GoogleGmailApiError(
      `${field} contiene caracteres no permitidos (posible inyección de headers)`,
    );
  }
}

@Injectable()
export class GoogleGmailClientService {
  private readonly logger = new Logger(GoogleGmailClientService.name);
  private readonly maxRequestsPerMinute = 60;
  private readonly windowMs = 60 * 1000;
  private readonly requestTimestamps: number[] = [];

  constructor(private readonly oauthService: GoogleOAuthService) {}

  private checkRateLimit(): void {
    const now = Date.now();
    while (
      this.requestTimestamps.length > 0 &&
      this.requestTimestamps[0] !== undefined &&
      this.requestTimestamps[0] <= now - this.windowMs
    ) {
      this.requestTimestamps.shift();
    }

    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      throw new GoogleGmailRateLimitError();
    }

    this.requestTimestamps.push(now);
  }

  private getGmailApi(): gmail_v1.Gmail {
    const auth = this.oauthService.getOAuth2Client();
    return google.gmail({ version: 'v1', auth });
  }

  public async listMessages(
    query?: string,
    maxResults = 20,
  ): Promise<GmailMessageSummary[]> {
    this.checkRateLimit();
    try {
      const gmail = this.getGmailApi();
      const listParams: gmail_v1.Params$Resource$Users$Messages$List = {
        userId: 'me',
        maxResults,
      };
      if (query) {
        listParams.q = query;
      }

      const listRes = await gmail.users.messages.list(listParams);
      const messageList = listRes.data.messages ?? [];
      const summaries: GmailMessageSummary[] = [];

      for (const msgRef of messageList) {
        if (!msgRef.id) continue;
        const msg = await this.getMessage(msgRef.id);
        summaries.push(msg);
      }

      return summaries;
    } catch (err: unknown) {
      if (err instanceof JinError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to list Gmail messages: ${msg}`);
      throw new GoogleGmailApiError(msg, err);
    }
  }

  public async getMessage(messageId: string): Promise<GmailMessageSummary> {
    this.checkRateLimit();
    try {
      const gmail = this.getGmailApi();
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      const headers = res.data.payload?.headers ?? [];
      const getHeader = (name: string): string | undefined => {
        const h = headers.find(
          (header) => header.name?.toLowerCase() === name.toLowerCase(),
        );
        return h?.value ?? undefined;
      };

      const bodyData =
        res.data.payload?.body?.data ??
        res.data.payload?.parts?.find((p) => p.mimeType === 'text/plain')?.body
          ?.data ??
        '';

      const bodyText = bodyData
        ? Buffer.from(bodyData, 'base64').toString('utf-8')
        : '';

      return {
        id: res.data.id ?? messageId,
        threadId: res.data.threadId ?? '',
        snippet: res.data.snippet ?? undefined,
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        body: bodyText,
      };
    } catch (err: unknown) {
      if (err instanceof JinError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to get Gmail message ${messageId}: ${msg}`);
      throw new GoogleGmailApiError(msg, err);
    }
  }

  public async getThread(threadId: string): Promise<GmailMessageSummary[]> {
    this.checkRateLimit();
    try {
      const gmail = this.getGmailApi();
      const res = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
      });

      const messages = res.data.messages ?? [];
      return messages.map((m) => {
        const headers = m.payload?.headers ?? [];
        const getHeader = (name: string): string | undefined => {
          const h = headers.find(
            (header) => header.name?.toLowerCase() === name.toLowerCase(),
          );
          return h?.value ?? undefined;
        };

        const bodyData =
          m.payload?.body?.data ??
          m.payload?.parts?.find((p) => p.mimeType === 'text/plain')?.body
            ?.data ??
          '';

        const bodyText = bodyData
          ? Buffer.from(bodyData, 'base64').toString('utf-8')
          : '';

        return {
          id: m.id ?? '',
          threadId: m.threadId ?? threadId,
          snippet: m.snippet ?? undefined,
          from: getHeader('From'),
          to: getHeader('To'),
          subject: getHeader('Subject'),
          date: getHeader('Date'),
          body: bodyText,
        };
      });
    } catch (err: unknown) {
      if (err instanceof JinError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to get Gmail thread ${threadId}: ${msg}`);
      throw new GoogleGmailApiError(msg, err);
    }
  }

  public async sendEmail(
    to: string,
    subject: string,
    body: string,
    threadId?: string,
  ): Promise<{ id: string; threadId: string }> {
    assertNoHeaderInjection(to, 'Destinatario (to)');
    assertNoHeaderInjection(subject, 'Asunto (subject)');

    this.checkRateLimit();
    try {
      const gmail = this.getGmailApi();

      const rawLines = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
        '',
        body,
      ];

      const rawEmail = rawLines.join('\r\n');
      const encodedMessage = Buffer.from(rawEmail)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const requestBody: gmail_v1.Schema$Message = {
        raw: encodedMessage,
      };
      if (threadId) {
        requestBody.threadId = threadId;
      }

      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody,
      });

      this.logger.log(
        `Correo enviado exitosamente a recipient (ID: ${res.data.id})`,
      );

      return {
        id: res.data.id ?? '',
        threadId: res.data.threadId ?? '',
      };
    } catch (err: unknown) {
      if (err instanceof JinError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send Gmail message: ${msg}`);
      throw new GoogleGmailApiError(msg, err);
    }
  }
}
