import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.schema';
import type { RelayMessageRow } from '../db/schema';
import { RelayBotService } from './relay-bot.service';
import type { RelayStore } from './relay.store';
import { buildCallbackData } from './relay.types';

const OWNER_CHAT_ID = 4242;
const RELAY_TOKEN = '123456:relay-fake-token';

function row(overrides: Partial<RelayMessageRow> = {}): RelayMessageRow {
  return {
    id: 'q-1',
    direction: 'out',
    body: '¿repino la imagen?',
    options: ['Sí, repina', 'Espera'],
    answerTo: null,
    telegramMessageId: 900,
    createdAt: new Date('2026-09-21T12:00:00Z'),
    consumedAt: null,
    ...overrides,
  };
}

/**
 * `{ token: null }` = puente sin configurar. Es `null` y no `undefined` a
 * propósito: un `undefined` explícito dispara el valor por defecto del
 * parámetro y el test terminaría construyendo el bot que dice no construir.
 */
function build({ token }: { token: string | null } = { token: RELAY_TOKEN }) {
  const store = {
    findOutbound: vi.fn().mockResolvedValue(row()),
    findAnswer: vi.fn().mockResolvedValue(undefined),
    insertInbound: vi.fn().mockResolvedValue(row({ direction: 'in' })),
    pendingQuestions: vi.fn().mockResolvedValue([row()]),
  };
  const configService = {
    get: vi.fn((key: string) => {
      if (key === 'TELEGRAM_RELAY_BOT_TOKEN') return token ?? undefined;
      if (key === 'TELEGRAM_OWNER_CHAT_ID') return OWNER_CHAT_ID;
      return undefined;
    }),
  } as unknown as ConfigService<Env, true>;

  const service = new RelayBotService(
    configService,
    store as unknown as RelayStore,
  );
  return { service, store };
}

/**
 * Empuja un update por el pipeline real de grammy, sin red. Se prueba contra
 * el bot de verdad —middlewares, filtros y todo— y no contra una imitación:
 * el filtro de `chat_id` es la única frontera entre este puente y un extraño,
 * y un doble podría "pasar" el test mientras el bot real deja entrar a todos.
 */
async function feed(service: RelayBotService, update: unknown): Promise<void> {
  const bot = (
    service as unknown as {
      bot: { botInfo: unknown; handleUpdate: (u: unknown) => Promise<void> };
    }
  ).bot;
  // `handleUpdate` exige un bot inicializado; sin red hay que dárselo a mano.
  bot.botInfo = {
    id: 123_456,
    is_bot: true,
    first_name: 'Jin Claude',
    username: 'Jin_claude_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };
  await bot.handleUpdate(update);
}

function messageUpdate(chatId: number, text: string, id = 1): unknown {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Owner' },
      text,
    },
  };
}

describe('RelayBotService', () => {
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    sent = [];
  });

  /** Transformador de grammy: intercepta las llamadas a la API sin red. */
  type ApiTransformer = (
    prev: unknown,
    method: string,
    payload: unknown,
  ) => Promise<unknown>;

  function captureApi(service: RelayBotService) {
    const bot = (
      service as unknown as {
        bot: { api: { config: { use: (t: ApiTransformer) => void } } };
      }
    ).bot;
    bot.api.config.use((_prev: unknown, method: string, payload: unknown) => {
      if (method === 'sendMessage') {
        sent.push(payload as Record<string, unknown>);
        return Promise.resolve({
          ok: true,
          result: { message_id: 900 },
        } as never);
      }
      return Promise.resolve({ ok: true, result: true } as never);
    });
  }

  it('sin token el puente queda deshabilitado y Jin arranca igual', () => {
    const { service } = build({ token: null });
    expect(service.enabled).toBe(false);
    // No lanza: `onModuleInit` solo registra que está apagado.
    expect(() => service.onModuleInit()).not.toThrow();
  });

  it('IGNORA cualquier chat que no sea el del owner', async () => {
    const { service, store } = build();
    captureApi(service);

    await feed(service, messageUpdate(999_999, 'hola, soy un intruso'));

    expect(store.insertInbound).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('un texto del owner entra a la cola que Claude consulta', async () => {
    const { service, store } = build();
    captureApi(service);

    await feed(service, messageUpdate(OWNER_CHAT_ID, 'dale, seguí'));

    expect(store.insertInbound).toHaveBeenCalledWith({ body: 'dale, seguí' });
  });

  it('una pregunta se manda con un botón por opción y su callback correlacionado', async () => {
    const { service } = build();
    captureApi(service);

    await service.deliver({
      body: '¿repino la imagen?',
      options: ['Sí, repina', 'Espera'],
      questionId: 'q-1',
    });

    expect(sent).toHaveLength(1);
    const keyboard = (
      sent[0]?.['reply_markup'] as {
        inline_keyboard: { callback_data: string }[][];
      }
    ).inline_keyboard;
    expect(keyboard.flat().map((b) => b.callback_data)).toEqual([
      buildCallbackData('q-1', 0),
      buildCallbackData('q-1', 1),
    ]);
    expect(sent[0]?.['chat_id']).toBe(OWNER_CHAT_ID);
  });

  it('un mensaje simple no lleva botones', async () => {
    const { service } = build();
    captureApi(service);

    await service.deliver({ body: 'terminé el deploy', questionId: 'q-2' });

    expect(sent[0]).not.toHaveProperty('reply_markup');
  });

  it('tocar un botón guarda la opción elegida, no su índice', async () => {
    const { service, store } = build();
    captureApi(service);

    await feed(service, {
      update_id: 2,
      callback_query: {
        id: 'cb-1',
        from: { id: OWNER_CHAT_ID, is_bot: false, first_name: 'Owner' },
        chat_instance: 'x',
        message: {
          message_id: 900,
          date: 1_700_000_000,
          chat: { id: OWNER_CHAT_ID, type: 'private' },
        },
        data: buildCallbackData('q-1', 1),
      },
    });

    expect(store.insertInbound).toHaveBeenCalledWith({
      body: 'Espera',
      answerTo: 'q-1',
    });
  });

  it('una pregunta ya respondida no se puede responder dos veces', async () => {
    const { service, store } = build();
    store.findAnswer.mockResolvedValue(
      row({ direction: 'in', body: 'Sí, repina' }),
    );
    captureApi(service);

    await feed(service, {
      update_id: 3,
      callback_query: {
        id: 'cb-2',
        from: { id: OWNER_CHAT_ID, is_bot: false, first_name: 'Owner' },
        chat_instance: 'x',
        message: {
          message_id: 900,
          date: 1_700_000_000,
          chat: { id: OWNER_CHAT_ID, type: 'private' },
        },
        data: buildCallbackData('q-1', 0),
      },
    });

    expect(store.insertInbound).not.toHaveBeenCalled();
  });

  it('un callback con datos basura no escribe nada', async () => {
    const { service, store } = build();
    captureApi(service);

    await feed(service, {
      update_id: 4,
      callback_query: {
        id: 'cb-3',
        from: { id: OWNER_CHAT_ID, is_bot: false, first_name: 'Owner' },
        chat_instance: 'x',
        message: {
          message_id: 900,
          date: 1_700_000_000,
          chat: { id: OWNER_CHAT_ID, type: 'private' },
        },
        data: 'no-es-un-callback-valido',
      },
    });

    expect(store.insertInbound).not.toHaveBeenCalled();
  });

  it('el Markdown de Claude llega como HTML de Telegram, no crudo', async () => {
    const { service } = build();
    captureApi(service);

    await service.deliver({
      body: '**listo** con `kubectl`',
      questionId: 'q-3',
    });

    expect(String(sent[0]?.['text'])).toContain('<b>listo</b>');
    expect(String(sent[0]?.['text'])).toContain('<code>kubectl</code>');
    expect(sent[0]?.['parse_mode']).toBe('HTML');
  });
});
