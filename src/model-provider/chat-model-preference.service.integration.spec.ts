import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  startTestDb,
  type TestDb,
} from '../../test/support/postgres-testcontainer';
import { chatModelPreference } from '../db/schema';
import { ChatModelPreferenceService } from './chat-model-preference.service';
import { InvalidChatModelOptionError } from './errors';
import type { ChatModelOption } from './model-provider.types';

const CATALOG: readonly ChatModelOption[] = [
  {
    vendor: 'anthropic',
    modelId: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    supportsEffort: true,
  },
  {
    vendor: 'anthropic',
    modelId: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    // A propósito sin esfuerzo, para probar que setPreference() lo descarta.
    supportsEffort: false,
  },
  {
    vendor: 'openai',
    modelId: 'gpt-5.1',
    label: 'GPT-5.1',
    supportsEffort: true,
  },
];

describe('ChatModelPreferenceService (integración, Postgres real, 2026-09-28)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    // Vuelve al reposo sembrado por la migración: sin preferencia.
    await testDb.db
      .update(chatModelPreference)
      .set({
        vendor: null,
        modelId: null,
        effort: null,
        setBy: 'system:default',
      })
      .where(eq(chatModelPreference.id, 1));
  });

  function service(): ChatModelPreferenceService {
    return new ChatModelPreferenceService(testDb.db, CATALOG);
  }

  it('listCatalog() devuelve el catálogo tal cual, sin tocar la DB', () => {
    expect(service().listCatalog()).toEqual(CATALOG);
  });

  it('sin preferencia guardada, refresh() deja getPreference() en null', async () => {
    const svc = service();
    await svc.refresh();
    expect(svc.getPreference()).toBeNull();
  });

  it('setPreference() guarda, refresh() de una instancia nueva la lee de la DB', async () => {
    const svc = service();
    await svc.refresh();
    const result = await svc.setPreference(
      { vendor: 'anthropic', modelId: 'claude-sonnet-5', effort: 'high' },
      'owner:api',
    );

    expect(result).toMatchObject({
      vendor: 'anthropic',
      modelId: 'claude-sonnet-5',
      effort: 'high',
      setBy: 'owner:api',
    });
    // getPreference() es sync (caché en memoria): refleja lo recién guardado sin releer.
    expect(svc.getPreference()).toMatchObject({ modelId: 'claude-sonnet-5' });

    // Una instancia NUEVA (simula un restart) la lee de la fila persistida.
    const reloaded = service();
    await reloaded.refresh();
    expect(reloaded.getPreference()).toMatchObject({
      vendor: 'anthropic',
      modelId: 'claude-sonnet-5',
      effort: 'high',
    });
  });

  it('un modelo que soporta esfuerzo pero el owner no pidió ninguno: effort queda null', async () => {
    const svc = service();
    await svc.refresh();
    const result = await svc.setPreference(
      { vendor: 'openai', modelId: 'gpt-5.1', effort: null },
      'owner:api',
    );
    expect(result.effort).toBeNull();
  });

  it('un modelo que NO soporta esfuerzo: el esfuerzo pedido se descarta (queda null), no se guarda "sin efecto"', async () => {
    const svc = service();
    await svc.refresh();
    const result = await svc.setPreference(
      { vendor: 'anthropic', modelId: 'claude-haiku-4-5', effort: 'high' },
      'owner:api',
    );
    expect(result.effort).toBeNull();
  });

  it('un vendor/modelo fuera del catálogo curado se rechaza: no se guarda nada', async () => {
    const svc = service();
    await svc.refresh();
    await expect(
      svc.setPreference(
        { vendor: 'anthropic', modelId: 'claude-fable-5-1', effort: null },
        'owner:api',
      ),
    ).rejects.toBeInstanceOf(InvalidChatModelOptionError);
    expect(svc.getPreference()).toBeNull();
  });

  it('clearPreference() vuelve al default (null) y lo persiste', async () => {
    const svc = service();
    await svc.refresh();
    await svc.setPreference(
      { vendor: 'openai', modelId: 'gpt-5.1', effort: 'medium' },
      'owner:api',
    );
    expect(svc.getPreference()).not.toBeNull();

    await svc.clearPreference('owner:api');
    expect(svc.getPreference()).toBeNull();

    const reloaded = service();
    await reloaded.refresh();
    expect(reloaded.getPreference()).toBeNull();
  });
});
