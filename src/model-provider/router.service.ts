import { Inject, Injectable } from '@nestjs/common';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { AnthropicProvider } from './anthropic.provider';
import { ChatModelPreferenceService } from './chat-model-preference.service';
import { MODELS_CONFIG } from './model-provider.tokens';
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelEffort,
  ModelProviderClient,
  ModelsConfig,
  ModelStreamDeltaListener,
  SelectModelHints,
  TaskProfile,
} from './model-provider.types';
import { UnknownModelVendorError } from './errors';
import { FailoverService } from './failover.service';
import { GoogleProvider } from './google.provider';
import { OpenAIProvider } from './openai.provider';
import { selectModel } from './router.logic';

/**
 * `ModelRouterService` (docs/MODEL_ROUTING.md §2 — el módulo se llama
 * `router.ts` en la doc; acá sigue la convención `.service.ts` del resto
 * del repo para servicios inyectables, ej. `audit.service.ts`).
 * Une el selector puro (`selectModel`, §2.2) con el failover real (§2.3):
 * elige el primer candidato según los hints, y si falla, cae al otro
 * modelo definido en el mismo profile (sea cual sea el rol — primary o
 * fallback — que `selectModel` no haya elegido ya).
 */
@Injectable()
export class ModelRouterService {
  constructor(
    @Inject(MODELS_CONFIG) private readonly profiles: ModelsConfig,
    private readonly anthropicProvider: AnthropicProvider,
    private readonly googleProvider: GoogleProvider,
    private readonly openaiProvider: OpenAIProvider,
    private readonly failoverService: FailoverService,
    private readonly featureFlagsService: FeatureFlagsService,
    private readonly chatModelPreferenceService: ChatModelPreferenceService,
  ) {}

  async complete(
    taskProfile: TaskProfile,
    request: ModelCompletionRequest,
    hints?: SelectModelHints,
  ): Promise<ModelCompletionResponse> {
    const { selected, secondaryModelId, effort } = this.resolveCandidates(
      taskProfile,
      hints,
    );
    const effectiveRequest = this.withEffort(request, effort);

    return this.failoverService.executeWithFailover(
      {
        taskProfile,
        primaryModelId: selected.modelId,
        fallbackModelId: secondaryModelId,
      },
      () =>
        this.providerFor(selected.modelId).complete(
          selected.modelId,
          effectiveRequest,
        ),
      () =>
        this.providerFor(secondaryModelId).complete(
          secondaryModelId,
          effectiveRequest,
        ),
    );
  }

  /**
   * Variante en streaming de `complete()` (plan de streaming en vivo del
   * chat web). Misma selección primary/fallback; cada llamada individual
   * pasa por `completeOrStream`, que degrada a `complete()` + un único
   * delta si el provider elegido no implementa `completeStream` (hoy,
   * cualquier modelo `gemini-*` — `GoogleProvider` no lo soporta).
   */
  async completeStream(
    taskProfile: TaskProfile,
    request: ModelCompletionRequest,
    onDelta: ModelStreamDeltaListener,
    hints?: SelectModelHints,
  ): Promise<ModelCompletionResponse> {
    const { selected, secondaryModelId, effort } = this.resolveCandidates(
      taskProfile,
      hints,
    );
    const effectiveRequest = this.withEffort(request, effort);

    return this.failoverService.executeWithFailoverStream(
      {
        taskProfile,
        primaryModelId: selected.modelId,
        fallbackModelId: secondaryModelId,
      },
      (onDeltaFn) =>
        this.completeOrStream(selected.modelId, effectiveRequest, onDeltaFn),
      (onDeltaFn) =>
        this.completeOrStream(secondaryModelId, effectiveRequest, onDeltaFn),
      onDelta,
    );
  }

  private async completeOrStream(
    modelId: string,
    request: ModelCompletionRequest,
    onDelta: ModelStreamDeltaListener,
  ): Promise<ModelCompletionResponse> {
    const provider = this.providerFor(modelId);
    if (provider.completeStream) {
      return provider.completeStream(modelId, request, onDelta);
    }
    // Degradación: provider sin streaming (hoy, GoogleProvider) — se
    // resuelve atómico y se manda UN solo delta con el texto completo,
    // así el consumidor (AgentService) no necesita dos caminos distintos.
    const response = await provider.complete(modelId, request);
    onDelta(response.content, response.content);
    return response;
  }

  private resolveCandidates(
    taskProfile: TaskProfile,
    hints?: SelectModelHints,
  ): {
    readonly selected: ReturnType<typeof selectModel>;
    readonly secondaryModelId: string;
    readonly effort: ModelEffort | undefined;
  } {
    // Preferencia del owner (2026-09-28, elegida en la app): solo aplica a
    // `chat_conversational` — es el único TaskProfile que el owner puede
    // elegir (mismo modelo que le contesta Y decide qué tools correr en el
    // turno). Gana sobre el override de operación (feature flag) si ambos
    // están puestos: es la señal más específica y más reciente.
    const chatPreference =
      taskProfile === 'chat_conversational'
        ? this.chatModelPreferenceService.getPreference()
        : null;

    // Fase 9.5 (BLUEPRINT §12.3): override hot de `primary` sobre
    // config/models.yaml -- regla de oro #5 intacta, sigue siendo
    // 100% config-driven, solo con una segunda capa encima de la
    // estática. Ningún cambio si no hay override declarado (camino
    // caliente sin allocación extra).
    const modelOverride =
      chatPreference?.modelId ??
      this.featureFlagsService.getModelOverride(taskProfile);
    const effectiveProfiles = modelOverride
      ? {
          ...this.profiles,
          [taskProfile]: {
            ...this.profiles[taskProfile],
            primary: modelOverride,
          },
        }
      : this.profiles;

    const selected = selectModel(effectiveProfiles, taskProfile, hints);
    const profile = effectiveProfiles[taskProfile];
    const secondaryModelId =
      selected.modelId === profile.primary ? profile.fallback : profile.primary;

    return {
      selected,
      secondaryModelId,
      effort: chatPreference?.effort ?? undefined,
    };
  }

  /** `effort` nunca lo fija el caller de `complete()`/`completeStream()` — solo la preferencia del owner, resuelta acá. */
  private withEffort(
    request: ModelCompletionRequest,
    effort: ModelEffort | undefined,
  ): ModelCompletionRequest {
    return effort === undefined ? request : { ...request, effort };
  }

  private providerFor(modelId: string): ModelProviderClient {
    if (modelId.startsWith('claude-')) {
      return this.anthropicProvider;
    }
    if (modelId.startsWith('gemini-')) {
      return this.googleProvider;
    }
    if (modelId.startsWith('gpt-')) {
      return this.openaiProvider;
    }
    throw new UnknownModelVendorError(modelId);
  }
}
