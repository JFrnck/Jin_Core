import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startTestRedis,
  type TestRedis,
} from '../../test/support/redis-testcontainer';
import { RedisThrottlerStorage } from './redis-throttler-storage.service';

function buildStorage(redisUrl: string): RedisThrottlerStorage {
  // `ConfigService` real con un solo valor en vez de un mock: el
  // constructor solo lee `REDIS_URL`, y así el tipo estricto
  // (`AppConfigService`) no necesita un cast que oculte una firma rota.
  return new RedisThrottlerStorage(
    new ConfigService({ REDIS_URL: redisUrl }) as never,
  );
}

/**
 * Redis real vía testcontainers (AGENTS.md 6.2). `isReachable()` es lo
 * que decide entre `ok` y `degraded` en la readiness probe: mockear
 * ioredis probaría el mock, no que un Redis genuinamente inalcanzable
 * resuelva `false` dentro del timeout en vez de colgar la probe.
 */
describe('RedisThrottlerStorage.isReachable (Redis real)', () => {
  let testRedis: TestRedis;
  let storage: RedisThrottlerStorage;

  beforeAll(async () => {
    testRedis = await startTestRedis();
    storage = buildStorage(testRedis.container.getConnectionUrl());
  });

  afterAll(async () => {
    await storage.onModuleDestroy();
    await testRedis.stop();
  });

  it('con Redis arriba responde true', async () => {
    await expect(storage.isReachable(2000)).resolves.toBe(true);
  });

  it('contra un puerto sin nada escuchando resuelve false dentro del timeout, no lanza', async () => {
    // Puerto reservado a propósito para "acá nunca hay nada" (mismo
    // criterio que la recomendación de separar el Redis de e2e del de
    // desarrollo).
    const dead = buildStorage('redis://127.0.0.1:6399');
    try {
      const startedAt = Date.now();
      await expect(dead.isReachable(2000)).resolves.toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(5000);
    } finally {
      await dead.onModuleDestroy().catch(() => undefined);
    }
  });
});
