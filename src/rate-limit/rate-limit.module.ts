import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { RedisThrottlerStorage } from './redis-throttler-storage.service';
import { RedisThrottlerStorageModule } from './redis-throttler-storage.module';

// Límite global default (ADR 0007 decisión #4): 60 requests/min por IP.
// `POST /api/auth/login` sobreescribe esto con un límite más estricto vía
// `@Throttle({ default: { limit: 5, ttl: 900_000 } })` — único vector de
// fuerza bruta real dado que hay una sola contraseña.
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_LIMIT = 60;

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [RedisThrottlerStorageModule],
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({
        throttlers: [
          { name: 'default', ttl: DEFAULT_TTL_MS, limit: DEFAULT_LIMIT },
        ],
        storage,
      }),
    }),
  ],
  exports: [ThrottlerModule],
})
export class RateLimitModule {}
