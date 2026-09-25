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
 * `router.service.ts` decide qué provider (Anthropic/Google) usar por el
 * prefijo del model ID (`claude-`/`gemini-`, ver docs/MODEL_ROUTING.md
 * §1). Un modelId que no matchea ninguno de los dos significaría que
 * `config/models.yaml` referencia un modelo de un vendor no soportado
 * todavía — fail-safe: rechazar en vez de adivinar un provider.
 */
export class UnknownModelVendorError extends JinError {
  constructor(modelId: string) {
    super(
      `No se pudo determinar el vendor (Anthropic/Google) para el modelId "${modelId}".`,
      { code: 'MODEL_PROVIDER_UNKNOWN_VENDOR', httpStatus: 500 },
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
