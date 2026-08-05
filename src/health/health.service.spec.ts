import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.module';
import type { RedisThrottlerStorage } from '../rate-limit/redis-throttler-storage.service';
import { HealthService } from './health.service';

function buildService(overrides?: {
  dbExecute?: () => Promise<unknown>;
  redisReachable?: () => Promise<boolean>;
}): HealthService {
  const db = {
    execute: vi.fn(overrides?.dbExecute ?? (() => Promise.resolve([]))),
  };
  const redisStorage = {
    isReachable: vi.fn(
      overrides?.redisReachable ?? (() => Promise.resolve(true)),
    ),
  };
  return new HealthService(
    db as unknown as Db,
    redisStorage as unknown as RedisThrottlerStorage,
  );
}

describe('HealthService', () => {
  it('ambas dependencias arriba → ok', async () => {
    await expect(buildService().check()).resolves.toEqual({
      status: 'ok',
      postgres: 'up',
      redis: 'up',
    });
  });

  it('Redis caído → degraded, NO error: el pod sigue en rotación (fail-open, ADR 0007 #4)', async () => {
    const service = buildService({
      redisReachable: () => Promise.resolve(false),
    });

    await expect(service.check()).resolves.toEqual({
      status: 'degraded',
      postgres: 'up',
      redis: 'down',
    });
  });

  it('Postgres caído → error: sin él no hay HITL, audit ni budget', async () => {
    const service = buildService({
      dbExecute: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      postgres: 'down',
      redis: 'up',
    });
  });

  it('un Postgres caído manda sobre el estado de Redis (error, no degraded)', async () => {
    const service = buildService({
      dbExecute: () => Promise.reject(new Error('ECONNREFUSED')),
      redisReachable: () => Promise.resolve(false),
    });

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      postgres: 'down',
      redis: 'down',
    });
  });

  it('un throw síncrono del driver se traduce a "down", no revienta la probe con un 500', async () => {
    const service = buildService({
      dbExecute: () => {
        throw new Error('pool ya cerrado');
      },
    });

    await expect(service.check()).resolves.toEqual({
      status: 'error',
      postgres: 'down',
      redis: 'up',
    });
  });

  it('una query de Postgres que nunca resuelve se corta por timeout en vez de colgar la probe', async () => {
    vi.useFakeTimers();
    try {
      const service = buildService({
        // `pg.Pool` sin `connectionTimeoutMillis` reintenta hasta el
        // timeout TCP del SO (minutos): esto es exactamente el caso que
        // el `Promise.race` de `withTimeout` existe para cubrir.
        dbExecute: () => new Promise(() => {}),
      });

      const pending = service.check();
      await vi.advanceTimersByTimeAsync(2000);

      await expect(pending).resolves.toEqual({
        status: 'error',
        postgres: 'down',
        redis: 'up',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
