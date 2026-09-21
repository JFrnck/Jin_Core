import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  startTestDb,
  type TestDb,
} from '../../test/support/postgres-testcontainer';
import { DB_CONNECTION } from '../db/db.module';
import { relayMessages } from '../db/schema';
import { RelayQuotaExceededError } from './errors';
import type { RelayBotService } from './relay-bot.service';
import { RelayService } from './relay.service';
import { RelayStore } from './relay.store';
import { MAX_OUT_PER_HOUR } from './relay.types';

/**
 * Lo que solo se puede comprobar contra Postgres de verdad: la idempotencia del
 * inbox depende de que el UPDATE…RETURNING sea atómico, y la cuota de un
 * `count(*)` con ventana temporal. Con un doble de la base, ambos pasarían sin
 * decir nada sobre el comportamiento real bajo concurrencia.
 */
describe('puente Claude↔owner (integración, Postgres real)', () => {
  let testDb: TestDb;
  let store: RelayStore;
  let service: RelayService;
  let deliver: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    testDb = await startTestDb();

    deliver = vi.fn().mockResolvedValue(900);

    // El store se resuelve por Nest (así se comprueba que `DB_CONNECTION` es
    // todo lo que necesita). El bot es lo único sustituido: hablar con
    // api.telegram.org no es lo que este test mide.
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [RelayStore, { provide: DB_CONNECTION, useValue: testDb.db }],
    }).compile();

    store = moduleRef.get(RelayStore);
    service = new RelayService(store, {
      deliver,
      enabled: true,
    } as unknown as RelayBotService);
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.delete(relayMessages);
    deliver.mockClear();
  });

  it('un mensaje del owner se entrega UNA sola vez, aunque Claude pregunte dos', async () => {
    await store.insertInbound({ body: 'dale, seguí' });

    const primera = await service.inbox();
    const segunda = await service.inbox();

    expect(primera.map((m) => m.body)).toEqual(['dale, seguí']);
    expect(segunda).toEqual([]);
  });

  it('dos lecturas concurrentes NO se llevan el mismo mensaje', async () => {
    // El caso que motiva el UPDATE…RETURNING: dos sesiones de Claude (o un
    // reintento) consultando a la vez. Si cada mensaje se entregara dos veces,
    // Claude ejecutaría dos veces la misma instrucción del owner.
    for (let i = 0; i < 20; i += 1) {
      await store.insertInbound({ body: `mensaje ${i}` });
    }

    const [a, b] = await Promise.all([service.inbox(), service.inbox()]);

    const ids = [...a, ...b].map((m) => m.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('los mensajes llegan en orden cronológico, el más viejo primero', async () => {
    await store.insertInbound({ body: 'primero' });
    await store.insertInbound({ body: 'segundo' });
    await store.insertInbound({ body: 'tercero' });

    const messages = await service.inbox();

    expect(messages.map((m) => m.body)).toEqual([
      'primero',
      'segundo',
      'tercero',
    ]);
  });

  it('la respuesta a una pregunta queda correlacionada y se puede consultar', async () => {
    const { id } = await service.send({
      body: '¿repino la imagen?',
      options: ['Sí, repina', 'Espera'],
    });

    expect(await service.answer(id)).toEqual({ answered: false });

    await store.insertInbound({ body: 'Sí, repina', answerTo: id });

    const answer = await service.answer(id);
    expect(answer.answered).toBe(true);
    expect(answer.body).toBe('Sí, repina');
  });

  it('si el owner responde dos veces, gana la más reciente', async () => {
    const { id } = await service.send({ body: '¿seguimos?', options: ['Sí'] });

    await store.insertInbound({ body: 'Sí', answerTo: id });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.insertInbound({ body: 'mejor no', answerTo: id });

    expect((await service.answer(id)).body).toBe('mejor no');
  });

  it('pasado el tope por hora corta: el 31º no se manda ni se registra', async () => {
    for (let i = 0; i < MAX_OUT_PER_HOUR; i += 1) {
      await service.send({ body: `mensaje ${i}` });
    }
    expect(deliver).toHaveBeenCalledTimes(MAX_OUT_PER_HOUR);

    await expect(service.send({ body: 'uno de más' })).rejects.toBeInstanceOf(
      RelayQuotaExceededError,
    );
    expect(deliver).toHaveBeenCalledTimes(MAX_OUT_PER_HOUR);

    const [row] = await testDb.db
      .select({ count: sql<number>`count(*)::int` })
      .from(relayMessages);
    expect(row?.count).toBe(MAX_OUT_PER_HOUR);
  });

  it('los mensajes de hace más de una hora no cuentan para la cuota', async () => {
    await service.send({ body: 'reciente' });
    await testDb.db.execute(
      sql`update ${relayMessages} set created_at = now() - interval '2 hours'`,
    );

    await expect(service.send({ body: 'otro' })).resolves.toHaveProperty('id');
  });

  it('la base rechaza una dirección que no sea in/out', async () => {
    // El CHECK es la última línea: aunque alguien inserte por fuera del store,
    // no puede crear una tercera categoría de mensaje.
    await expect(
      testDb.db.execute(
        sql`insert into relay_messages (direction, body) values ('sideways', 'x')`,
      ),
    ).rejects.toThrow();
  });

  it('el mensaje se registra aunque Telegram falle: no se pierde el rastro', async () => {
    deliver.mockRejectedValueOnce(new Error('telegram caído'));

    await expect(service.send({ body: 'algo importante' })).rejects.toThrow(
      'telegram caído',
    );

    const rows = await testDb.db.select().from(relayMessages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('algo importante');
    // Sin `telegram_message_id`: quedó claro que nunca llegó a entregarse.
    expect(rows[0]?.telegramMessageId).toBeNull();
  });
});
