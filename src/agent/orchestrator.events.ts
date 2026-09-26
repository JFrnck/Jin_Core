// Un run de orquestación cambió (tickets creados, uno arrancó/terminó/falló,
// un conflicto escaló, el run terminó). Lo escuchan las notificaciones push
// para actualizar la Live Activity del trabajo en paralelo (ADR 0014).
export const ORCHESTRATION_RUN_CHANGED_EVENT = 'orchestration.run.changed';

export interface OrchestrationRunChangedEvent {
  readonly runId: string;
}
