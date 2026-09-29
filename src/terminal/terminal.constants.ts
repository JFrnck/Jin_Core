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

/**
 * Terminal interactiva (PTY, 2026-09-29). Abrir y cerrar la sesión quedan en el
 * audit; cada línea que el owner teclea sigue yendo con `runTerminalCommand`.
 * Virtuales igual que las demás: el modelo no las ve.
 */
export const OPEN_TERMINAL_PTY_TOOL = 'openTerminalPty';
export const CLOSE_TERMINAL_PTY_TOOL = 'closeTerminalPty';

/** Salida reciente que Core guarda por sesión para reenganchar tras una desconexión. */
export const PTY_RING_BYTES = 256 * 1024;
/** Cuánto sigue viva una sesión sin ninguna app conectada antes de cerrarse. */
export const PTY_DETACH_GRACE_MS = 10 * 60 * 1000;

export const TERMINAL_ACTOR = 'owner:terminal';

/** Cuántos caracteres del comando quedan en el audit (el hash cubre el resto). */
export const AUDIT_COMMAND_PREVIEW_LENGTH = 120;
