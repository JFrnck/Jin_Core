import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { RedisThrottlerStorage } from '../rate-limit/redis-throttler-storage.service';

/**
 * Tope de espera de cada chequeo. Corto a propósito: una readiness probe
 * que tarda más que el `timeoutSeconds` del kubelet es indistinguible de
 * una que falla, pero además deja requests colgados. `pg.Pool` sin
 * `connectionTimeoutMillis` reintenta hasta el timeout TCP del SO
 * (minutos), de ahí el `Promise.race` en vez de confiar en el driver.
 */
const CHECK_TIMEOUT_MS = 2000;

export interface HealthReport {
  readonly status: 'ok' | 'degraded' | 'error';
  readonly postgres: 'up' | 'down';
  readonly redis: 'up' | 'down';
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), CHECK_TIMEOUT_MS).unref();
    }),
  ]);
}

/**
 * Readiness real (BLUEPRINT 12.2: "ReadinessProbe obligatoria"). Antes de
 * esto el único endpoint era `GET /`, que devuelve un string estático:
 * apuntar la probe ahí marcaría el pod como listo con Postgres caído, y
 * el rolling update `maxSurge:1/maxUnavailable:0` de 12.2 mataría la
 * réplica vieja antes de que la nueva pudiera servir de verdad.
 *
 * **Postgres es dependencia dura, Redis no.** No es una asimetría
 * arbitraria: `RedisThrottlerStorage` ya es deliberadamente fail-open
 * (ADR 0007 decisión #4 — "un Redis caído no debe tumbar TODA la API de
 * un sistema single-user"). Sacar el pod de rotación por Redis
 * contradiría esa decisión justo cuando más importa. Sin Postgres, en
 * cambio, no hay HITL, ni audit log, ni budget: el pod no puede servir
 * nada útil y debe salir de rotación.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(DB_CONNECTION) private readonly db: Db,
    private readonly redisStorage: RedisThrottlerStorage,
  ) {}

  async check(): Promise<HealthReport> {
    const [postgresUp, redisUp] = await Promise.all([
      this.checkPostgres(),
      this.redisStorage.isReachable(CHECK_TIMEOUT_MS),
    ]);

    if (!postgresUp)
      return {
        status: 'error',
        postgres: 'down',
        redis: redisUp ? 'up' : 'down',
      };
    return {
      status: redisUp ? 'ok' : 'degraded',
      postgres: 'up',
      redis: redisUp ? 'up' : 'down',
    };
  }

  private async checkPostgres(): Promise<boolean> {
    // `Promise.resolve().then(...)` en vez de llamar `execute()` directo:
    // un throw SÍNCRONO del driver (pool ya cerrado) esquivaría el
    // `.catch` de la cadena y haría que la probe respondiera 500 en vez
    // de 503. Los dos sacan el pod de rotación, pero un 500 se reporta
    // como bug de la app y no como "la dependencia está caída".
    const query = Promise.resolve()
      .then(() => this.db.execute(sql`select 1`))
      .then(() => true)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Postgres no responde en el health check: ${message}`);
        return false;
      });
    return withTimeout(query, false);
  }
}
