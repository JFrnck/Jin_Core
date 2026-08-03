import { Module } from '@nestjs/common';
import { RedisThrottlerStorage } from './redis-throttler-storage.service';

// Separado de `RateLimitModule` porque `ThrottlerModule.forRootAsync()`
// resuelve su `useFactory` con un injector propio, construido a partir de
// su `imports` — no ve directamente los `providers` del módulo que lo
// llama, así que `RedisThrottlerStorage` necesita vivir en un módulo
// aparte, importado explícitamente ahí.
@Module({
  providers: [RedisThrottlerStorage],
  exports: [RedisThrottlerStorage],
})
export class RedisThrottlerStorageModule {}
