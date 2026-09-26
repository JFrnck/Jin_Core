import { Injectable, Logger } from '@nestjs/common';
import {
  AllProvidersFailedError,
  StreamAlreadyPartiallyEmittedError,
} from './errors';
import type { ModelStreamDeltaListener } from './model-provider.types';

export interface FailoverContext {
  readonly taskProfile: string;
  readonly primaryModelId: string;
  readonly fallbackModelId: string;
}

// "Backoff exponencial" (docs/MODEL_ROUTING.md 2.3) solo tiene curva real
// con más de un reintento; el doc especifica exactamente 1 reintento del
// primary, así que esto es simplemente el delay base antes de ese único
// reintento.
const RETRY_BACKOFF_MS = 1000;

/**
 * Orquesta el failover de `docs/MODEL_ROUTING.md` §2.3: 1 reintento del
 * primary, luego cambia al fallback con log de warning. No sabe nada de
 * `TaskProfile`/`selectModel` — recibe las dos llamadas ya resueltas
 * (`callPrimary`/`callFallback`), reutilizable sin importar cómo se
 * eligieron esos dos candidatos.
 */
@Injectable()
export class FailoverService {
  private readonly logger = new Logger(FailoverService.name);

  async executeWithFailover<T>(
    context: FailoverContext,
    callPrimary: () => Promise<T>,
    callFallback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.retryOnce(callPrimary);
    } catch (primaryError) {
      // TODO(observability): emitir el contador Prometheus
      // `model_failover_total{from,to,reason}` (MODEL_ROUTING.md §2.3)
      // cuando Core adopte una librería de métricas — verificado, no hay
      // ninguna instalada todavía (ni prom-client ni
      // @willsoto/nestjs-prometheus). El log de warning estructurado de
      // abajo es el comportamiento real exigido; la métrica queda como
      // gap explícito, no como un olvido.
      this.logger.warn(
        `Model failover: ${context.primaryModelId} → ${context.fallbackModelId} ` +
          `(task=${context.taskProfile}, reason=${this.describeError(primaryError)})`,
      );

      try {
        return await callFallback();
      } catch (fallbackError) {
        throw new AllProvidersFailedError(
          context.taskProfile,
          context.primaryModelId,
          context.fallbackModelId,
          fallbackError,
        );
      }
    }
  }

  /**
   * Variante en streaming de `executeWithFailover` (plan de streaming en
   * vivo del chat web). Misma política de retry-once-luego-fallback, con
   * UNA restricción nueva: apenas `onDelta` se disparó al menos una vez
   * en el intento actual, ese intento queda "comprometido" — el owner ya
   * vio texto parcial de ESE modelo. Un fallo después de eso nunca
   * reintenta ni cae a fallback (mezclaría texto de dos modelos en la
   * misma respuesta); se corta con `StreamAlreadyPartiallyEmittedError`.
   * Si el fallo ocurre antes del primer delta, el comportamiento es
   * idéntico al de `executeWithFailover`.
   */
  async executeWithFailoverStream<T>(
    context: FailoverContext,
    callPrimary: (onDelta: ModelStreamDeltaListener) => Promise<T>,
    callFallback: (onDelta: ModelStreamDeltaListener) => Promise<T>,
    onDelta: ModelStreamDeltaListener,
  ): Promise<T> {
    let emittedAny = false;
    const guardedOnDelta: ModelStreamDeltaListener = (delta, snapshot) => {
      emittedAny = true;
      onDelta(delta, snapshot);
    };

    try {
      return await this.retryOnceStream(
        callPrimary,
        guardedOnDelta,
        () => emittedAny,
      );
    } catch (primaryError) {
      if (emittedAny) {
        throw new StreamAlreadyPartiallyEmittedError(
          context.taskProfile,
          context.primaryModelId,
          primaryError,
        );
      }

      this.logger.warn(
        `Model failover: ${context.primaryModelId} → ${context.fallbackModelId} ` +
          `(task=${context.taskProfile}, reason=${this.describeError(primaryError)})`,
      );

      try {
        return await callFallback(guardedOnDelta);
      } catch (fallbackError) {
        if (emittedAny) {
          throw new StreamAlreadyPartiallyEmittedError(
            context.taskProfile,
            context.fallbackModelId,
            fallbackError,
          );
        }
        throw new AllProvidersFailedError(
          context.taskProfile,
          context.primaryModelId,
          context.fallbackModelId,
          fallbackError,
        );
      }
    }
  }

  private async retryOnceStream<T>(
    fn: (onDelta: ModelStreamDeltaListener) => Promise<T>,
    onDelta: ModelStreamDeltaListener,
    hasEmitted: () => boolean,
  ): Promise<T> {
    try {
      return await fn(onDelta);
    } catch (err) {
      // Ya se emitió al menos un delta en este mismo intento: no
      // reintentar (repetiría la llamada y podría duplicar/mezclar texto
      // ya mostrado). El caller decide qué error lanzar con `emittedAny`.
      if (hasEmitted()) throw err;
      await this.sleep(RETRY_BACKOFF_MS);
      return fn(onDelta);
    }
  }

  private async retryOnce<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      await this.sleep(RETRY_BACKOFF_MS);
      // Segundo y último intento del primary (docs/MODEL_ROUTING.md 2.3
      // punto 1). Si también falla, se propaga al caller para activar
      // el cambio a fallback (punto 2) — no hay un tercer intento aquí.
      return fn();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown_error';
  }
}
