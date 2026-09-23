import type { EventEmitter2 } from '@nestjs/event-emitter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayMessageRow } from '../db/schema';
import { RelayQuotaExceededError } from './errors';
import type { RelayBotService } from './relay-bot.service';
import { RELAY_MESSAGE_CREATED_EVENT, RelayService } from './relay.service';
import type { RelayStore } from './relay.store';

function row(overrides: Partial<RelayMessageRow> = {}): RelayMessageRow {
  return {
    id: 'q-1',
    direction: 'out',
    body: 'hola',
    options: null,
    answerTo: null,
    telegramMessageId: null,
    createdAt: new Date('2026-09-21T12:00:00Z'),
    consumedAt: null,
    ...overrides,
  };
}

describe('RelayService', () => {
  let store: {
    insertOutbound: ReturnType<typeof vi.fn>;
    attachTelegramMessageId: ReturnType<typeof vi.fn>;
    consumePending: ReturnType<typeof vi.fn>;
    findAnswer: ReturnType<typeof vi.fn>;
    outQuotaExceeded: ReturnType<typeof vi.fn>;
    insertInbound: ReturnType<typeof vi.fn>;
    listRecent: ReturnType<typeof vi.fn>;
  };
  let bot: { deliver: ReturnType<typeof vi.fn>; enabled: boolean };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let service: RelayService;

  beforeEach(() => {
    store = {
      insertOutbound: vi.fn().mockResolvedValue(row()),
      attachTelegramMessageId: vi.fn().mockResolvedValue(undefined),
      consumePending: vi.fn().mockResolvedValue([]),
      findAnswer: vi.fn().mockResolvedValue(undefined),
      outQuotaExceeded: vi.fn().mockResolvedValue(false),
      insertInbound: vi.fn().mockResolvedValue(row({ id: 'in-1', direction: 'in' })),
      listRecent: vi.fn().mockResolvedValue([]),
    };
    bot = { deliver: vi.fn().mockResolvedValue(555), enabled: true };
    eventEmitter = { emit: vi.fn() };
    service = new RelayService(
      store as unknown as RelayStore,
      bot as unknown as RelayBotService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  it('manda un mensaje simple y guarda el message_id de Telegram', async () => {
    const result = await service.send({ body: 'terminé el deploy' });

    expect(result).toEqual({ id: 'q-1' });
    expect(bot.deliver).toHaveBeenCalledWith({
      body: 'terminé el deploy',
      questionId: 'q-1',
    });
    expect(store.attachTelegramMessageId).toHaveBeenCalledWith('q-1', 555);
  });

  it('una pregunta pasa sus opciones al bot para que dibuje los botones', async () => {
    await service.send({ body: '¿repino?', options: ['Sí', 'Espera'] });

    expect(bot.deliver).toHaveBeenCalledWith({
      body: '¿repino?',
      questionId: 'q-1',
      options: ['Sí', 'Espera'],
    });
  });

  it('registra el mensaje ANTES de entregarlo: si Telegram falla, queda rastro', async () => {
    bot.deliver.mockRejectedValueOnce(new Error('telegram caído'));

    await expect(service.send({ body: 'algo' })).rejects.toThrow(
      'telegram caído',
    );
    expect(store.insertOutbound).toHaveBeenCalledTimes(1);
  });

  it('pasado el tope por hora NO manda nada y lanza 429', async () => {
    store.outQuotaExceeded.mockResolvedValue(true);

    await expect(service.send({ body: 'spam' })).rejects.toBeInstanceOf(
      RelayQuotaExceededError,
    );
    // Lo que importa: ni se registró ni se entregó.
    expect(store.insertOutbound).not.toHaveBeenCalled();
    expect(bot.deliver).not.toHaveBeenCalled();
  });

  it('el inbox devuelve los mensajes del owner en orden y expone answerTo', async () => {
    store.consumePending.mockResolvedValue([
      row({
        id: 'b',
        direction: 'in',
        body: 'segundo',
        createdAt: new Date('2026-09-21T12:00:02Z'),
      }),
      row({
        id: 'a',
        direction: 'in',
        body: 'Sí',
        answerTo: 'q-9',
        createdAt: new Date('2026-09-21T12:00:01Z'),
      }),
    ]);

    const messages = await service.inbox();

    expect(messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(messages[0]?.answerTo).toBe('q-9');
    // Un mensaje suelto no inventa una correlación que no existe.
    expect(messages[1]).not.toHaveProperty('answerTo');
  });

  it('answer() informa si la pregunta sigue sin respuesta', async () => {
    expect(await service.answer('q-1')).toEqual({ answered: false });
  });

  it('answer() devuelve la opción elegida cuando ya respondió', async () => {
    store.findAnswer.mockResolvedValue(
      row({ direction: 'in', body: 'Sí, repina', answerTo: 'q-1' }),
    );

    expect(await service.answer('q-1')).toEqual({
      answered: true,
      body: 'Sí, repina',
      answeredAt: '2026-09-21T12:00:00.000Z',
    });
  });

  it('send() emite RELAY_MESSAGE_CREATED_EVENT con direction "out"', async () => {
    await service.send({ body: 'hola' });

    expect(eventEmitter.emit).toHaveBeenCalledWith(RELAY_MESSAGE_CREATED_EVENT, {
      id: 'q-1',
      direction: 'out',
    });
  });

  it('reply() guarda la respuesta del owner y emite el evento con direction "in"', async () => {
    const result = await service.reply({ body: 'dale, segui', answerTo: 'q-1' });

    expect(result).toEqual({ id: 'in-1' });
    expect(store.insertInbound).toHaveBeenCalledWith({
      body: 'dale, segui',
      answerTo: 'q-1',
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith(RELAY_MESSAGE_CREATED_EVENT, {
      id: 'in-1',
      direction: 'in',
    });
  });

  it('reply() sin cuota: un Claude en bucle no bloquea al owner mandando su propio mensaje', async () => {
    store.outQuotaExceeded.mockResolvedValue(true);

    await service.reply({ body: 'sin límite' });

    expect(store.insertInbound).toHaveBeenCalledTimes(1);
  });

  it('history() incluye ambas direcciones y bodyHtml con el markdown ya renderizado', async () => {
    store.listRecent.mockResolvedValue([
      row({ id: 'o-1', direction: 'out', body: '**hola**' }),
      row({ id: 'i-1', direction: 'in', body: 'dale', answerTo: 'o-1' }),
    ]);

    const messages = await service.history();

    expect(messages).toEqual([
      expect.objectContaining({
        id: 'o-1',
        direction: 'out',
        body: '**hola**',
        bodyHtml: '<b>hola</b>',
      }),
      expect.objectContaining({
        id: 'i-1',
        direction: 'in',
        body: 'dale',
        answerTo: 'o-1',
      }),
    ]);
  });

  it('history() no consume nada — a diferencia de inbox(), es solo lectura', async () => {
    await service.history();

    expect(store.consumePending).not.toHaveBeenCalled();
  });
});
