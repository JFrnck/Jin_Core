import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleOAuthService } from '../oauth.service';
import {
  GoogleCalendarClientService,
  GoogleCalendarRateLimitError,
} from './google-calendar-client.service';

vi.mock('googleapis', () => {
  const mockEventsList = vi.fn().mockResolvedValue({
    data: { items: [{ id: 'evt-1', summary: 'Reunión de prueba' }] },
  });
  const mockEventsInsert = vi.fn().mockResolvedValue({
    data: { id: 'evt-2', summary: 'Nuevo evento' },
  });
  const mockEventsPatch = vi.fn().mockResolvedValue({
    data: { id: 'evt-1', summary: 'Evento actualizado' },
  });
  const mockEventsDelete = vi.fn().mockResolvedValue({ data: {} });

  return {
    google: {
      calendar: vi.fn().mockReturnValue({
        events: {
          list: mockEventsList,
          insert: mockEventsInsert,
          patch: mockEventsPatch,
          delete: mockEventsDelete,
        },
      }),
    },
  };
});

describe('GoogleCalendarClientService', () => {
  let service: GoogleCalendarClientService;
  let mockOAuthService: Partial<GoogleOAuthService>;

  beforeEach(() => {
    mockOAuthService = {
      getOAuth2Client: vi.fn().mockReturnValue({}),
    };

    service = new GoogleCalendarClientService(
      mockOAuthService as GoogleOAuthService,
    );
  });

  it('debe listar eventos correctamente', async () => {
    const events = await service.listEvents();
    expect(events.length).toBe(1);
    expect(events[0]?.summary).toBe('Reunión de prueba');
  });

  it('debe crear un evento correctamente', async () => {
    const created = await service.createEvent({
      summary: 'Nuevo evento',
      start: new Date(),
      end: new Date(Date.now() + 3600000),
    });
    expect(created.id).toBe('evt-2');
  });

  it('debe actualizar un evento correctamente', async () => {
    const updated = await service.updateEvent('evt-1', {
      summary: 'Evento actualizado',
    });
    expect(updated.summary).toBe('Evento actualizado');
  });

  it('debe borrar un evento correctamente', async () => {
    await expect(service.deleteEvent('evt-1')).resolves.not.toThrow();
  });

  it('debe aplicar rate limiting lanzando GoogleCalendarRateLimitError si se superan 60 peticiones/min', async () => {
    for (let i = 0; i < 60; i++) {
      await service.listEvents();
    }
    await expect(service.listEvents()).rejects.toThrow(
      GoogleCalendarRateLimitError,
    );
  });
});
