import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';
import type { AppConfigService } from '../config';

export interface RedisThrottlerRecord {
  readonly totalHits: number;
  readonly timeToExpire: number;
  readonly isBlocked: boolean;
  readonly timeToBlockExpire: number;
}

// Ventana fija atómica: INCR + PEXPIRE en un solo `EVAL` (ADR 0007
// decisión #4) — evita la condición de carrera de hacer ambos comandos
// por separado bajo escrituras concurrentes.
const INCR_WITH_TTL_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if tonumber(current) == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return current
`;

function buildBucketKey(key: string, throttlerName: string): string {
  return `throttle:${throttlerName}:${key}`;
}

function buildBlockKey(key: string, throttlerName: string): string {
  return `throttle-block:${throttlerName}:${key}`;
}

/**
 * `ThrottlerStorage` sobre Redis real (ADR 0007 decisión #4) — primera
 * vez que Jin_Core habla con la instancia de Redis ya desplegada en
 * Jin_Infra. Ventana fija, no sliding window: correcta sin condiciones de
 * carrera y suficiente para un sistema single-user sin adversarios
 * multi-tenant reales.
 */
@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy
{
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redis: Redis;

  constructor(@Inject(ConfigService) configService: AppConfigService) {
    const url: string = configService.get('REDIS_URL');
    // `lazyConnect`: mismo criterio que `DbModule`'s `pg.Pool` (no
    // conecta hasta la primera query) — evita abrir una conexión TCP al
    // instanciar el provider si `AppModule` se compila sin usarlo (ej. el
    // smoke test de `test/app.e2e-spec.ts`). `maxRetriesPerRequest` +
    // `connectTimeout` acotados: sin esto, ioredis reintenta conectar
    // indefinidamente y cada request HTTP queda colgado hasta ~20
    // reintentos (encontrado corriendo el smoke test real sin Redis
    // disponible — `ThrottlerGuard` corre en TODA request, incluidas las
    // `@Public()`, porque no conoce nuestro decorador).
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    // Sin un listener, ioredis vuelca cada error de conexión directo a
    // consola en vez de por el `Logger` de Nest — mismo tratamiento que
    // el resto de los servicios del repo.
    this.redis.on('error', (err: Error) => {
      this.logger.warn(`Error de conexión a Redis: ${err.message}`);
    });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<RedisThrottlerRecord> {
    const bucketKey = buildBucketKey(key, throttlerName);
    const blockKey = buildBlockKey(key, throttlerName);

    try {
      const blockPttl = await this.redis.pttl(blockKey);
      if (blockPttl > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: Math.ceil(blockPttl / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockPttl / 1000),
        };
      }

      const totalHits = Number(
        await this.redis.eval(INCR_WITH_TTL_SCRIPT, 1, bucketKey, ttl),
      );
      const bucketPttl = await this.redis.pttl(bucketKey);

      let isBlocked = false;
      let timeToBlockExpire = 0;
      if (totalHits > limit) {
        isBlocked = true;
        await this.redis.set(blockKey, '1', 'PX', blockDuration);
        timeToBlockExpire = Math.ceil(blockDuration / 1000);
      }

      return {
        totalHits,
        timeToExpire: Math.ceil(Math.max(bucketPttl, 0) / 1000),
        isBlocked,
        timeToBlockExpire,
      };
    } catch (err: unknown) {
      // Fail-open, no fail-closed: un Redis caído no debe tumbar TODA la
      // API de un sistema single-user (incluido /api/auth/login) — el
      // rate limit es defensa en profundidad, no una dependencia dura.
      // Documentado como decisión deliberada en ADR 0007, no un intento
      // de esconder el error (se loguea igual).
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Redis no disponible — rate limit deshabilitado para este request: ${message}`,
      );
      return {
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  /**
   * Usado solo por el health check (`HealthService`): es el único punto
   * del repo que tiene la conexión a Redis, así que expone el PING en vez
   * de abrir una segunda conexión solo para sondear. Nunca lanza — el
   * caller decide qué significa `false` (para readiness, "degraded", no
   * "fuera de rotación": ver el porqué en `HealthService`).
   */
  async isReachable(timeoutMs: number): Promise<boolean> {
    try {
      const ping = this.redis.ping().then(() => true);
      const timeout = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), timeoutMs).unref();
      });
      return await Promise.race([ping, timeout]);
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
