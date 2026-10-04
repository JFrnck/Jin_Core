import { Injectable } from '@nestjs/common';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;

interface VaultEntry {
  readonly env: Readonly<Record<string, string>>;
  readonly expiresAt: number;
}

/**
 * Valores de variables de entorno de demos mientras su aprobación está pendiente
 * (2026-10-04, ADR 0020). **Solo en memoria**: el `payload` de una aprobación es `jsonb` y se
 * persiste en Postgres, el audit se guarda y los logs salen del proceso; un secreto no puede ir
 * por ninguno de esos caminos. Por eso la aprobación lleva solo NOMBRES y los valores esperan
 * aquí, por `requestId`, hasta que se ejecuta (`take`: lee y borra) o vence.
 *
 * Costo aceptado: si Core se reinicia con una aprobación pendiente, los valores se pierden y esa
 * publicación falla con un mensaje claro ("reenvía las variables").
 */
@Injectable()
export class EnvVaultService {
  private readonly entries = new Map<string, VaultEntry>();

  /** Guarda los valores de una publicación pendiente. No se serializa ni se muestra jamás. */
  put(
    requestId: string,
    env: Readonly<Record<string, string>>,
    ttlMs: number = DEFAULT_TTL_MS,
    nowMs: number = Date.now(),
  ): void {
    this.purge(nowMs);
    if (this.entries.size >= MAX_ENTRIES && !this.entries.has(requestId)) {
      throw new Error(
        'Hay demasiadas publicaciones con variables pendientes de aprobación; resuelve alguna primero.',
      );
    }
    this.entries.set(requestId, { env: { ...env }, expiresAt: nowMs + ttlMs });
  }

  /** Lee Y BORRA los valores (una sola vez). `undefined` si no están (reinicio, vencidos, ya usados). */
  take(
    requestId: string,
    nowMs: number = Date.now(),
  ): Record<string, string> | undefined {
    const entry = this.entries.get(requestId);
    this.entries.delete(requestId);
    if (!entry || entry.expiresAt <= nowMs) return undefined;
    return { ...entry.env };
  }

  /** Descarta sin leer (la aprobación falló al crearse). */
  discard(requestId: string): void {
    this.entries.delete(requestId);
  }

  has(requestId: string, nowMs: number = Date.now()): boolean {
    const entry = this.entries.get(requestId);
    return entry !== undefined && entry.expiresAt > nowMs;
  }

  private purge(nowMs: number): void {
    for (const [requestId, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.entries.delete(requestId);
    }
  }

  // Por si alguien serializa o imprime el servicio entero: nunca salen valores.
  toJSON(): Record<string, never> {
    return {};
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'EnvVaultService { <valores ocultos> }';
  }
}
