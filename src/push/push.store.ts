import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import { DB_CONNECTION, type Db } from '../db/db.module';
import {
  pushActivityTokens,
  pushDevices,
  type PushActivityTokenRow,
  type PushDeviceRow,
} from '../db/schema';
import type { ApnsEnvironment } from './push.types';

/** iOS termina una Live Activity a las 8 h (+4 h en pantalla bloqueada). */
const ACTIVITY_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Único punto que toca `push_devices` y `push_activity_tokens` (ADR 0014). */
@Injectable()
export class PushStore {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  async upsertDevice(input: {
    token: string;
    environment: ApnsEnvironment;
    preferences: Record<string, boolean>;
  }): Promise<void> {
    await this.db
      .insert(pushDevices)
      .values(input)
      .onConflictDoUpdate({
        target: pushDevices.token,
        set: {
          environment: input.environment,
          preferences: input.preferences,
          lastSeenAt: new Date(),
        },
      });
  }

  async deleteDevice(token: string): Promise<void> {
    await this.db.delete(pushDevices).where(eq(pushDevices.token, token));
  }

  async listDevices(): Promise<PushDeviceRow[]> {
    return this.db.select().from(pushDevices);
  }

  async upsertActivityToken(input: {
    token: string;
    environment: ApnsEnvironment;
    purpose: 'update' | 'start';
    kind?: string | undefined;
    referenceId?: string | undefined;
  }): Promise<void> {
    // Un solo token 'start' por entorno: iOS lo rota y el viejo deja de servir.
    if (input.purpose === 'start') {
      await this.db
        .delete(pushActivityTokens)
        .where(
          and(
            eq(pushActivityTokens.purpose, 'start'),
            eq(pushActivityTokens.environment, input.environment),
          ),
        );
    }
    await this.db
      .insert(pushActivityTokens)
      .values({
        token: input.token,
        environment: input.environment,
        purpose: input.purpose,
        kind: input.kind ?? null,
        referenceId: input.referenceId ?? null,
      })
      .onConflictDoUpdate({
        target: pushActivityTokens.token,
        set: {
          kind: input.kind ?? null,
          referenceId: input.referenceId ?? null,
        },
      });
  }

  async deleteActivityToken(token: string): Promise<void> {
    await this.db
      .delete(pushActivityTokens)
      .where(eq(pushActivityTokens.token, token));
  }

  /** Tokens de las Live Activities vivas para una referencia (run, 'kill'...). */
  async activityTokensFor(
    referenceId: string,
  ): Promise<PushActivityTokenRow[]> {
    await this.pruneActivityTokens();
    return this.db
      .select()
      .from(pushActivityTokens)
      .where(
        and(
          eq(pushActivityTokens.purpose, 'update'),
          eq(pushActivityTokens.referenceId, referenceId),
        ),
      );
  }

  async startTokens(): Promise<PushActivityTokenRow[]> {
    return this.db
      .select()
      .from(pushActivityTokens)
      .where(eq(pushActivityTokens.purpose, 'start'));
  }

  private async pruneActivityTokens(): Promise<void> {
    await this.db
      .delete(pushActivityTokens)
      .where(
        and(
          eq(pushActivityTokens.purpose, 'update'),
          lt(
            pushActivityTokens.createdAt,
            new Date(Date.now() - ACTIVITY_TOKEN_MAX_AGE_MS),
          ),
        ),
      );
  }
}
