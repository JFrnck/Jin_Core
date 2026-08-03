import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import Redis from 'ioredis';

// Pinneado (nunca `latest`), mismo criterio que `postgres-testcontainer.ts`.
const REDIS_IMAGE = 'redis:7.4-alpine';

export interface TestRedis {
  redis: Redis;
  container: StartedRedisContainer;
  stop: () => Promise<void>;
}

/**
 * Levanta un Redis real (testcontainers, AGENTS.md 6.2) para probar
 * `RedisThrottlerStorage` contra el Redis real, no un mock — la lógica
 * atómica de INCR+PEXPIRE vía `EVAL` es justamente lo que un mock no
 * verificaría de verdad.
 */
export async function startTestRedis(): Promise<TestRedis> {
  const container = await new RedisContainer(REDIS_IMAGE).start();
  const redis = new Redis(container.getConnectionUrl());

  return {
    redis,
    container,
    stop: async () => {
      await redis.quit();
      await container.stop();
    },
  };
}
