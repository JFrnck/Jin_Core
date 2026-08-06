import { Module } from '@nestjs/common';
import { RedisThrottlerStorageModule } from '../rate-limit/redis-throttler-storage.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

// `RedisThrottlerStorageModule` importado explícitamente: es donde vive
// la única conexión a Redis del repo (ver el comentario de ese módulo
// sobre por qué está separado de `RateLimitModule`). `DB_CONNECTION`
// llega solo — `DbModule` es `@Global()`.
@Module({
  imports: [RedisThrottlerStorageModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
