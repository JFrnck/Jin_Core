import { Injectable, Logger } from '@nestjs/common';
import { google, type calendar_v3 } from 'googleapis';
import { YormunError } from '../../../common/errors/yormun-error';
import { GoogleOAuthService } from '../oauth.service';

export class GoogleCalendarRateLimitError extends YormunError {
  constructor() {
    super(
      'Límite de tasa (rate limit) de Google Calendar alcanzado (máximo 60 peticiones/minuto).',
      { code: 'GOOGLE_CALENDAR_RATE_LIMIT_EXCEEDED', httpStatus: 429 },
    );
  }
}

export class GoogleCalendarApiError extends YormunError {
  constructor(message: string, cause?: unknown) {
    super(`Error en Google Calendar API: ${message}`, {
      code: 'GOOGLE_CALENDAR_API_ERROR',
      httpStatus: 502,
      cause,
    });
  }
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
}

@Injectable()
export class GoogleCalendarClientService {
  private readonly logger = new Logger(GoogleCalendarClientService.name);
  private readonly maxRequestsPerMinute = 60;
  private readonly windowMs = 60 * 1000;
  private readonly requestTimestamps: number[] = [];

  constructor(private readonly oauthService: GoogleOAuthService) {}

  private checkRateLimit(): void {
    const now = Date.now();
    // Limpiar marcas fuera de la ventana deslizante de 1 minuto
    while (
      this.requestTimestamps.length > 0 &&
      this.requestTimestamps[0] !== undefined &&
      this.requestTimestamps[0] <= now - this.windowMs
    ) {
      this.requestTimestamps.shift();
    }

    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      throw new GoogleCalendarRateLimitError();
    }

    this.requestTimestamps.push(now);
  }

  private getCalendarApi(): calendar_v3.Calendar {
    const auth = this.oauthService.getOAuth2Client();
    return google.calendar({ version: 'v3', auth });
  }

  public async listEvents(options?: {
    timeMin?: Date;
    timeMax?: Date;
    maxResults?: number;
  }): Promise<calendar_v3.Schema$Event[]> {
    this.checkRateLimit();
    try {
      const calendar = this.getCalendarApi();
      const listParams: calendar_v3.Params$Resource$Events$List = {
        calendarId: 'primary',
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: options?.maxResults ?? 50,
      };

      if (options?.timeMin) {
        listParams.timeMin = options.timeMin.toISOString();
      }
      if (options?.timeMax) {
        listParams.timeMax = options.timeMax.toISOString();
      }

      const res = await calendar.events.list(listParams);
      return res.data.items ?? [];
    } catch (err: unknown) {
      if (err instanceof YormunError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to list calendar events: ${msg}`);
      throw new GoogleCalendarApiError(msg, err);
    }
  }

  public async createEvent(
    eventData: CalendarEventInput,
  ): Promise<calendar_v3.Schema$Event> {
    this.checkRateLimit();
    try {
      const calendar = this.getCalendarApi();
      const requestBody: calendar_v3.Schema$Event = {
        summary: eventData.summary,
        start: { dateTime: eventData.start.toISOString() },
        end: { dateTime: eventData.end.toISOString() },
      };

      if (eventData.description) {
        requestBody.description = eventData.description;
      }
      if (eventData.location) {
        requestBody.location = eventData.location;
      }

      const res = await calendar.events.insert({
        calendarId: 'primary',
        requestBody,
      });

      return res.data;
    } catch (err: unknown) {
      if (err instanceof YormunError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to create calendar event: ${msg}`);
      throw new GoogleCalendarApiError(msg, err);
    }
  }

  public async updateEvent(
    eventId: string,
    eventData: Partial<CalendarEventInput>,
  ): Promise<calendar_v3.Schema$Event> {
    this.checkRateLimit();
    try {
      const calendar = this.getCalendarApi();

      const requestBody: calendar_v3.Schema$Event = {};
      if (eventData.summary !== undefined)
        requestBody.summary = eventData.summary;
      if (eventData.description !== undefined)
        requestBody.description = eventData.description;
      if (eventData.location !== undefined)
        requestBody.location = eventData.location;
      if (eventData.start !== undefined)
        requestBody.start = { dateTime: eventData.start.toISOString() };
      if (eventData.end !== undefined)
        requestBody.end = { dateTime: eventData.end.toISOString() };

      const res = await calendar.events.patch({
        calendarId: 'primary',
        eventId,
        requestBody,
      });

      return res.data;
    } catch (err: unknown) {
      if (err instanceof YormunError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to update calendar event ${eventId}: ${msg}`);
      throw new GoogleCalendarApiError(msg, err);
    }
  }

  public async deleteEvent(eventId: string): Promise<void> {
    this.checkRateLimit();
    try {
      const calendar = this.getCalendarApi();
      await calendar.events.delete({
        calendarId: 'primary',
        eventId,
      });
    } catch (err: unknown) {
      if (err instanceof YormunError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to delete calendar event ${eventId}: ${msg}`);
      throw new GoogleCalendarApiError(msg, err);
    }
  }
}
