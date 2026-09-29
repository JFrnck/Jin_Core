/**
 * Tools VIRTUALES de la terminal del owner (ADR 0016). No están en
 * `TOOL_REGISTRY`: el modelo no las ve y no puede invocarlas (`UnknownToolError`
 * al clasificarlas), igual que `autonomyModeChange`. Las inicia solo el owner
 * desde la app, y las aprobaciones se crean en un nivel FIJO (`confirm`) que
 * ningún modo de autonomía relaja.
 */
export const START_TERMINAL_SESSION_TOOL = 'startTerminalSession';
export const EXPOSE_TERMINAL_SESSION_TOOL = 'exposeTerminalSession';
/** Cada comando que teclea el owner queda en el audit con este nombre. */
export const RUN_TERMINAL_COMMAND_TOOL = 'runTerminalCommand';
/** Detener el pod de un workspace (el disco se conserva): solo audit, sin aprobación. */
export const STOP_TERMINAL_SESSION_TOOL = 'stopTerminalSession';
/**
 * Borrar el pod Y el disco de un workspace (2026-09-28, ADR 0016 ampliada):
 * también solo audit — destruye únicamente datos que ya son del owner, sin
 * abrir ningún egress nuevo (mismo criterio que `stopPreviewService`).
 */
export const DELETE_TERMINAL_WORKSPACE_TOOL = 'deleteTerminalWorkspace';

export const TERMINAL_ACTOR = 'owner:terminal';

/** Cuántos caracteres del comando quedan en el audit (el hash cubre el resto). */
export const AUDIT_COMMAND_PREVIEW_LENGTH = 120;
