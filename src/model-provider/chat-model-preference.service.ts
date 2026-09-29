import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { chatModelPreference } from '../db/schema';
import { InvalidChatModelOptionError } from './errors';
import { CHAT_OPTIONS } from './model-provider.tokens';
import type {
  ChatModelOption,
  ChatModelPreference,
  ModelEffort,
} from './model-provider.types';

const STATE_ROW_ID = 1;

/**
 * Preferencia de modelo del owner para `chat_conversational` (2026-09-28) —
 * vendor/modelo/esfuerzo elegidos a mano en la app en vez del `primary`
 * fijo de `config/models.yaml`. Ajuste GLOBAL (mismo criterio que
 * `AutonomyService`: una sola fila singleton, no por conversación) — app
 * iOS: Más → Ajustes.
 *
 * `null` = sin preferencia: `ModelRouterService` usa el `primary` de
 * siempre. Nunca la toca el LLM: solo
 * `POST /api/model-provider/chat-preference`, autenticado (mismo patrón
 * que `POST /api/autonomy`).
 *
 * Lectura sync (`getPreference()`) desde un caché en memoria:
 * `ModelRouterService` la consulta en el camino caliente de cada turno de
 * chat, no puede depender de I/O de DB ahí. El caché se llena con
 * `refresh()` (lo llama el controller en cada `GET`, y por lo tanto
 * también cada vez que la app hace su `refreshAll()`) y con cada
 * escritura — NUNCA en el arranque del módulo: a diferencia de
 * `AutonomyService` (que relee la fila en cada llamada, sin caché),
 * este caché necesita mantenerse al día, pero cargarlo en
 * `OnModuleInit` bloquearía — y podía romper — el arranque de toda la
 * app si la DB no está lista todavía (encontrado en CI: `app.e2e-spec.ts`
 * no provee Postgres real, y esto era la única pieza de todo Jin_Core
 * que consultaba la DB durante el bootstrap). Ventana aceptada: recién
 * reiniciado el pod, antes del primer `GET`, un turno de chat usa el
 * `primary` de `models.yaml` en vez de la preferencia guardada — se
 * corrige solo en cuanto algo pida el estado (la propia app, al abrir
 * Ajustes o en su refresh periódico).
 */
@Injectable()
export class ChatModelPreferenceService {
  private readonly logger = new Logger(ChatModelPreferenceService.name);
  private cached: ChatModelPreference | null = null;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: Db,
    @Inject(CHAT_OPTIONS) private readonly catalog: readonly ChatModelOption[],
  ) {}

  /** Vuelve a leer la fila y actualiza el caché — barato (una fila por id). */
  async refresh(): Promise<void> {
    this.cached = await this.readFromDb();
  }

  /** Catálogo elegible (`config/models.yaml` → `chat_options`), tal cual para la app. */
  listCatalog(): readonly ChatModelOption[] {
    return this.catalog;
  }

  getPreference(): ChatModelPreference | null {
    return this.cached;
  }

  async setPreference(
    input: { vendor: string; modelId: string; effort: ModelEffort | null },
    setBy: string,
  ): Promise<ChatModelPreference> {
    const option = this.catalog.find(
      (candidate) =>
        candidate.vendor === input.vendor &&
        candidate.modelId === input.modelId,
    );
    if (!option) {
      throw new InvalidChatModelOptionError(input.vendor, input.modelId);
    }
    // Un esfuerzo pedido para un modelo que no lo soporta se descarta en
    // vez de guardarse sin efecto: la app no debería mostrar el control en
    // ese caso, pero si igual llega, mejor un valor consistente que uno
    // que nunca se aplica.
    const effort = option.supportsEffort ? input.effort : null;
    const changedAt = new Date();

    await this.db
      .update(chatModelPreference)
      .set({
        vendor: option.vendor,
        modelId: option.modelId,
        effort,
        setBy,
        changedAt,
      })
      .where(eq(chatModelPreference.id, STATE_ROW_ID));

    this.cached = {
      vendor: option.vendor,
      modelId: option.modelId,
      effort,
      setBy,
      changedAt: changedAt.toISOString(),
    };
    this.logger.log(
      `Preferencia de modelo de chat: ${option.vendor}/${option.modelId} (esfuerzo: ${effort ?? 'default'}), por ${setBy}.`,
    );
    return this.cached;
  }

  /** Vuelve al default de `config/models.yaml` (borra la preferencia). */
  async clearPreference(setBy: string): Promise<void> {
    const changedAt = new Date();
    await this.db
      .update(chatModelPreference)
      .set({ vendor: null, modelId: null, effort: null, setBy, changedAt })
      .where(eq(chatModelPreference.id, STATE_ROW_ID));
    this.cached = null;
    this.logger.log(
      `Preferencia de modelo de chat borrada por ${setBy}: vuelve al default de models.yaml.`,
    );
  }

  private async readFromDb(): Promise<ChatModelPreference | null> {
    const [row] = await this.db
      .select()
      .from(chatModelPreference)
      .where(eq(chatModelPreference.id, STATE_ROW_ID));
    if (!row?.vendor || !row.modelId) return null;
    return {
      vendor: row.vendor as ChatModelPreference['vendor'],
      modelId: row.modelId,
      effort: (row.effort as ModelEffort | null) ?? null,
      setBy: row.setBy,
      changedAt: row.changedAt.toISOString(),
    };
  }
}
