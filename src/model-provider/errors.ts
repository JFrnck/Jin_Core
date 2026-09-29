import { JinError } from '../common/errors/jin-error';

/**
 * Fail-safe (MODEL_ROUTING.md §6.1 — "todo modelo pasa por el
 * ModelProvider"): un TaskProfile que no existe en `config/models.yaml`
 * nunca cae a un default silencioso, se rechaza explícitamente.
 */
export class UnknownTaskProfileError extends JinError {
  constructor(taskProfile: string) {
    super(`TaskProfile "${taskProfile}" no existe en config/models.yaml.`, {
      code: 'MODEL_PROVIDER_UNKNOWN_TASK_PROFILE',
      httpStatus: 400,
    });
  }
}

/**
 * Se lanza cuando tanto el modelo `primary` como el `fallback` fallan
 * (MODEL_ROUTING.md §2.3: 1 reintento del primary, luego fallback; si
 * el fallback también falla, no hay un tercer modelo al que degradar).
 */
export class AllProvidersFailedError extends JinError {
  constructor(
    taskProfile: string,
    primaryModelId: string,
    fallbackModelId: string,
    cause: unknown,
  ) {
    super(
      `Tanto el modelo primary (${primaryModelId}) como el fallback (${fallbackModelId}) fallaron para el profile "${taskProfile}".`,
      { code: 'MODEL_PROVIDER_ALL_FAILED', httpStatus: 502, cause },
    );
  }
}

/**
 * `router.service.ts` decide qué provider (Anthropic/Google/OpenAI) usar
 * por el prefijo del model ID (`claude-`/`gemini-`/`gpt-`, ver
 * docs/MODEL_ROUTING.md §1). Un modelId que no matchea ninguno de los tres
 * significaría que `config/models.yaml` referencia un modelo de un vendor
 * no soportado todavía — fail-safe: rechazar en vez de adivinar un provider.
 */
export class UnknownModelVendorError extends JinError {
  constructor(modelId: string) {
    super(
      `No se pudo determinar el vendor (Anthropic/Google/OpenAI) para el modelId "${modelId}".`,
      { code: 'MODEL_PROVIDER_UNKNOWN_VENDOR', httpStatus: 500 },
    );
  }
}

/**
 * El owner pidió un vendor+modelo para `chat_conversational` que no está
 * en el catálogo curado (`config/models.yaml` → `chat_options`) — 2026-09-28,
 * preferencia de modelo. Fail-safe, mismo criterio que
 * `UnknownTaskProfileError`: un valor fuera del catálogo nunca cae a un
 * default silencioso ni se guarda tal cual (rompería el budget guard, que
 * necesita el precio del modelo en `model_prices`).
 */
export class InvalidChatModelOptionError extends JinError {
  constructor(vendor: string, modelId: string) {
    super(
      `"${vendor}/${modelId}" no está en el catálogo de modelos elegibles para el chat.`,
      { code: 'MODEL_PROVIDER_INVALID_CHAT_OPTION', httpStatus: 400 },
    );
  }
}

/**
 * Streaming en vivo del chat web (plan de la sesión): una vez que ya se
 * emitió al menos un delta de texto al socket del owner, un fallo del
 * primary NO puede reintentarse ni caer a fallback en silencio — el
 * owner ya vio texto parcial de un modelo específico, y mezclarlo con
 * texto de otro modelo en la misma respuesta sería peor que cortar el
 * turno. `FailoverService.executeWithFailoverStream` la lanza en ese
 * caso puntual; el catch ya existente de `ChatGateway.handleMessage` la
 * recibe como cualquier otro error de turno (`chat:error`).
 */
export class StreamAlreadyPartiallyEmittedError extends JinError {
  constructor(taskProfile: string, modelId: string, cause: unknown) {
    super(
      `El modelo "${modelId}" (profile "${taskProfile}") falló después de emitir contenido parcial al cliente — no se reintenta ni se cae a fallback para no mezclar texto de dos modelos en la misma respuesta.`,
      { code: 'MODEL_PROVIDER_STREAM_INTERRUPTED', httpStatus: 502, cause },
    );
  }
}
