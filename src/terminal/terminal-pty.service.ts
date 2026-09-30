import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { computeInputsHash } from '../agent/agent.logic';
import { AuditService } from '../audit/audit.service';
import { PtyInputGate } from './pty-input-gate';
import { auditPreview } from './redact-secrets';
import { TerminalExecutorClient } from './terminal-executor.client';
import {
  AUDIT_COMMAND_PREVIEW_LENGTH,
  CLOSE_TERMINAL_PTY_TOOL,
  OPEN_TERMINAL_PTY_TOOL,
  PTY_KEEPALIVE_DEFAULT_MS,
  PTY_KEEPALIVE_MAX_MS,
  PTY_KEEPALIVE_MIN_MS,
  PTY_RING_BYTES,
  RUN_TERMINAL_COMMAND_TOOL,
  TERMINAL_ACTOR,
} from './terminal.constants';
import { TerminalUpstreamError } from './terminal.errors';

/** Lo que Core le entrega a quien esté conectado (la app, vía el gateway). `data` va en base64. */
export type PtyEvent =
  | { readonly type: 'out'; readonly data: string }
  | { readonly type: 'exit'; readonly code: number }
  /** Fatal: la sesión terminó por un fallo. */
  | { readonly type: 'error'; readonly message: string }
  /** No fatal: algo que el owner debe saber (p. ej. una línea que no se envió). */
  | { readonly type: 'notice'; readonly message: string };

export type PtyListener = (event: PtyEvent) => void;

interface PtySize {
  readonly cols: number;
  readonly rows: number;
}

/** Tope de entrada por sesión: un pegado enorme o un bucle en la app no deben saturar el pod. */
const MAX_INPUT_BYTES_PER_SECOND = 512 * 1024;
/** Trozos de la repetición de salida al reconectar (un mensaje de socket no debe ser gigante). */
const REPLAY_CHUNK_BYTES = 48 * 1024;
const ENDED_LINGER_MS = 30_000;
const PUMP_MAX_RETRIES = 5;
function clampKeepAlive(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return PTY_KEEPALIVE_DEFAULT_MS;
  }
  return Math.min(
    PTY_KEEPALIVE_MAX_MS,
    Math.max(PTY_KEEPALIVE_MIN_MS, Math.round(requested)),
  );
}

/** Ctrl+C: cancela la línea a medias en el shell cuando el audit falla. */
const CTRL_C = Buffer.from([0x03]);

interface PtySession {
  readonly ptyId: string;
  readonly workspaceId: string;
  readonly startedAt: number;
  readonly gate: PtyInputGate;
  readonly abort: AbortController;
  ring: Buffer[];
  ringBytes: number;
  listener: PtyListener | null;
  /** Cuánto esperar sin app antes de cerrar (lo elige el owner). */
  keepAliveMs: number;
  detachTimer: NodeJS.Timeout | null;
  lingerTimer: NodeJS.Timeout | null;
  inputChain: Promise<void>;
  ended: PtyEvent | null;
  bytesIn: number;
  bytesOut: number;
  rateWindowStart: number;
  rateBytes: number;
}

/**
 * Terminal interactiva del owner (ADR 0016 ampliada, 2026-09-29). Core es
 * dueño de lo que el Executor no hace: auth (en el gateway), audit, topes,
 * y la salida reciente para reenganchar tras una desconexión.
 *
 * Audit — cada línea que el owner teclea se registra ANTES de que su Enter
 * llegue al shell (fail-closed): si el registro falla, el Enter no se envía y
 * la línea a medias se cancela con Ctrl+C. Además se audita abrir y cerrar la
 * sesión. Sigue sin haber aprobación por comando: la sesión es un canal dentro
 * del pod que el owner ya aprobó, igual que `exec`.
 */
@Injectable()
export class TerminalPtyService implements OnModuleDestroy {
  private readonly logger = new Logger(TerminalPtyService.name);
  private readonly sessions = new Map<string, PtySession>();
  private readonly byWorkspace = new Map<string, string>();

  constructor(
    private readonly executor: TerminalExecutorClient,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Abre la terminal del workspace o, si ya hay una, se engancha a ella (la
   * app pudo perder el `ptyId` al suspenderse). Entrega enseguida lo guardado.
   */
  async openOrAttach(
    workspaceId: string,
    size: PtySize,
    listener: PtyListener,
    keepAliveMs?: number,
  ): Promise<{ ptyId: string; resumed: boolean }> {
    const keepAlive = clampKeepAlive(keepAliveMs);
    const existingId = this.byWorkspace.get(workspaceId);
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing && !existing.ended) {
      if (keepAliveMs !== undefined) existing.keepAliveMs = keepAlive;
      this.attach(existing, listener);
      await this.resize(existing.ptyId, size).catch(() => undefined);
      return { ptyId: existing.ptyId, resumed: true };
    }
    if (existingId && !existing) {
      // Reserva sin sesión todavía: otra apertura está en curso.
      throw new TerminalUpstreamError(
        409,
        'La terminal de este proyecto se está abriendo: espera un momento.',
      );
    }

    // Reservar antes del primer `await`: dos aperturas casi a la vez no deben abrir dos.
    const reservation = randomUUID();
    this.byWorkspace.set(workspaceId, reservation);
    try {
      await this.audit(
        OPEN_TERMINAL_PTY_TOOL,
        { workspaceId, ...size },
        'terminal interactiva: abrir',
      );
      const { ptyId } = await this.executor.openPty(workspaceId, size);
      const session: PtySession = {
        ptyId,
        workspaceId,
        startedAt: Date.now(),
        gate: new PtyInputGate(),
        abort: new AbortController(),
        ring: [],
        ringBytes: 0,
        listener: null,
        keepAliveMs: keepAlive,
        detachTimer: null,
        lingerTimer: null,
        inputChain: Promise.resolve(),
        ended: null,
        bytesIn: 0,
        bytesOut: 0,
        rateWindowStart: Date.now(),
        rateBytes: 0,
      };
      this.sessions.set(ptyId, session);
      this.byWorkspace.set(workspaceId, ptyId);
      this.attach(session, listener);
      void this.pump(session);
      return { ptyId, resumed: false };
    } catch (error) {
      if (this.byWorkspace.get(workspaceId) === reservation) {
        this.byWorkspace.delete(workspaceId);
      }
      throw error;
    }
  }

  /** Suelta al suscriptor si sigue siendo el actual; arranca la gracia antes de cerrar la sesión. */
  detach(ptyId: string, listener: PtyListener): void {
    const session = this.sessions.get(ptyId);
    if (!session || session.listener !== listener) return;
    session.listener = null;
    if (session.ended) return;
    this.armDetachTimer(session);
  }

  /**
   * (Re)inicia la cuenta atrás de una sesión sin app. Se llama al soltar la
   * app y cada vez que la sesión escribe algo mientras está sola: la espera
   * es de SILENCIO, así un Claude Code que sigue trabajando no se corta.
   */
  private armDetachTimer(session: PtySession): void {
    if (session.detachTimer) clearTimeout(session.detachTimer);
    session.detachTimer = setTimeout(() => {
      this.logger.log(
        `Terminal ${session.ptyId}: sin app conectada ni salida en ${Math.round(session.keepAliveMs / 60_000)} min, se cierra.`,
      );
      void this.close(session.ptyId, 'sin app conectada');
    }, session.keepAliveMs);
    session.detachTimer.unref();
  }

  /**
   * Teclas del owner. Se encolan: el audit de una línea no puede adelantarse
   * ni retrasarse respecto de las teclas siguientes.
   */
  input(ptyId: string, data: Buffer): void {
    const session = this.require(ptyId);
    if (session.ended) return;
    if (!this.withinRate(session, data.length)) {
      this.notify(session, {
        type: 'notice',
        message: 'Demasiada entrada de golpe: se descartó lo último.',
      });
      return;
    }
    session.bytesIn += data.length;
    session.inputChain = session.inputChain
      .then(() => this.process(session, data))
      .catch((error: unknown) => this.onInputFailure(session, error));
  }

  async resize(ptyId: string, size: PtySize): Promise<void> {
    const session = this.require(ptyId);
    if (session.ended) return;
    await this.executor.ptyResize(session.workspaceId, ptyId, size);
  }

  async close(ptyId: string, reason = 'cerrada por el owner'): Promise<void> {
    const session = this.sessions.get(ptyId);
    if (!session || session.ended) return;
    try {
      await this.executor.closePty(session.workspaceId, ptyId);
    } catch (error) {
      this.logger.warn(
        `Terminal ${ptyId}: el Executor no confirmó el cierre: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.finish(session, { type: 'exit', code: -1 }, reason);
  }

  onModuleDestroy(): void {
    for (const session of this.sessions.values()) {
      session.abort.abort();
      if (session.detachTimer) clearTimeout(session.detachTimer);
      if (session.lingerTimer) clearTimeout(session.lingerTimer);
    }
  }

  // ── internos ───────────────────────────────────────────────────────────

  private require(ptyId: string): PtySession {
    const session = this.sessions.get(ptyId);
    if (!session) {
      throw new TerminalUpstreamError(
        404,
        'La terminal interactiva ya no existe: abre otra.',
      );
    }
    return session;
  }

  private attach(session: PtySession, listener: PtyListener): void {
    if (session.detachTimer) clearTimeout(session.detachTimer);
    session.detachTimer = null;
    session.listener = listener;

    const replay = Buffer.concat(session.ring);
    for (let offset = 0; offset < replay.length; offset += REPLAY_CHUNK_BYTES) {
      listener({
        type: 'out',
        data: replay
          .subarray(offset, offset + REPLAY_CHUNK_BYTES)
          .toString('base64'),
      });
    }
    if (session.ended) listener(session.ended);
  }

  private async process(session: PtySession, data: Buffer): Promise<void> {
    for (const step of session.gate.feed(data)) {
      if (step.line !== null) {
        // Fail-closed: si esto lanza, el Enter de esta línea NO se reenvía.
        await this.audit(
          RUN_TERMINAL_COMMAND_TOOL,
          {
            workspaceId: session.workspaceId,
            command: step.line,
            interactive: true,
          },
          `terminal (interactiva): ${auditPreview(step.line, AUDIT_COMMAND_PREVIEW_LENGTH)}`,
        );
      }
      await this.executor.ptyInput(
        session.workspaceId,
        session.ptyId,
        step.bytes,
      );
    }
  }

  private async onInputFailure(
    session: PtySession,
    error: unknown,
  ): Promise<void> {
    this.logger.error(
      `Terminal ${session.ptyId}: entrada no enviada: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Lo tecleado antes del Enter ya está en el shell: se cancela la línea para
    // que un Enter posterior no ejecute algo que nunca se registró.
    session.gate.reset();
    await this.executor
      .ptyInput(session.workspaceId, session.ptyId, CTRL_C)
      .catch(() => undefined);
    this.notify(session, {
      type: 'notice',
      message:
        'No se pudo registrar esa línea en el audit: no se envió al terminal.',
    });
  }

  private withinRate(session: PtySession, bytes: number): boolean {
    const now = Date.now();
    if (now - session.rateWindowStart >= 1000) {
      session.rateWindowStart = now;
      session.rateBytes = 0;
    }
    session.rateBytes += bytes;
    return session.rateBytes <= MAX_INPUT_BYTES_PER_SECOND;
  }

  private notify(session: PtySession, event: PtyEvent): void {
    session.listener?.(event);
  }

  /**
   * Lee la salida del Executor y la reparte. Si el stream se corta sin que
   * la sesión termine (una caída de red entre pods), reintenta: el Executor
   * conserva lo que salió mientras nadie escuchaba.
   */
  private async pump(session: PtySession): Promise<void> {
    let failures = 0;
    while (!session.ended && !session.abort.signal.aborted) {
      try {
        const response = await this.executor.ptyOutput(
          session.workspaceId,
          session.ptyId,
          session.abort.signal,
        );
        failures = 0;
        await this.readStream(session, response);
      } catch (error) {
        if (session.abort.signal.aborted || session.ended) return;
        if (
          error instanceof TerminalUpstreamError &&
          error.httpStatus === 404
        ) {
          await this.finish(
            session,
            {
              type: 'error',
              message: 'La terminal ya no existe en el servidor.',
            },
            'ya no existía en el Executor',
          );
          return;
        }
        failures += 1;
        if (failures > PUMP_MAX_RETRIES) {
          await this.finish(
            session,
            {
              type: 'error',
              message: 'Se perdió la conexión con la terminal.',
            },
            'conexión perdida',
          );
          return;
        }
      }
      if (session.ended) return;
      await new Promise((resolve) => setTimeout(resolve, 500 * (failures + 1)));
    }
  }

  private async readStream(
    session: PtySession,
    response: Response,
  ): Promise<void> {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const raw = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
        if (raw.length > 0 && (await this.handleLine(session, raw))) return;
      }
    }
  }

  /** Devuelve `true` si la sesión terminó con esta línea. */
  private async handleLine(session: PtySession, raw: string): Promise<boolean> {
    let event: { t?: string; d?: string; code?: number; message?: string };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return false;
    }
    if (event.t === 'out' && typeof event.d === 'string') {
      const bytes = Buffer.from(event.d, 'base64');
      session.bytesOut += bytes.length;
      this.remember(session, bytes);
      if (session.listener) session.listener({ type: 'out', data: event.d });
      else if (session.detachTimer) this.armDetachTimer(session);
      return false;
    }
    if (event.t === 'exit') {
      await this.finish(
        session,
        {
          type: 'exit',
          code: typeof event.code === 'number' ? event.code : -1,
        },
        'el shell terminó',
      );
      return true;
    }
    if (event.t === 'error') {
      await this.finish(
        session,
        { type: 'error', message: event.message ?? 'Falló la terminal.' },
        'error de la terminal',
      );
      return true;
    }
    return false;
  }

  private remember(session: PtySession, bytes: Buffer): void {
    session.ring.push(bytes);
    session.ringBytes += bytes.length;
    while (session.ringBytes > PTY_RING_BYTES && session.ring.length > 1) {
      session.ringBytes -= session.ring.shift()?.length ?? 0;
    }
  }

  private async finish(
    session: PtySession,
    event: PtyEvent,
    reason: string,
  ): Promise<void> {
    if (session.ended) return;
    session.ended = event;
    session.abort.abort();
    if (session.detachTimer) clearTimeout(session.detachTimer);
    session.detachTimer = null;
    if (this.byWorkspace.get(session.workspaceId) === session.ptyId) {
      this.byWorkspace.delete(session.workspaceId);
    }
    session.listener?.(event);
    // Se conserva un momento para que una app que se reengancha reciba el final.
    session.lingerTimer = setTimeout(
      () => this.sessions.delete(session.ptyId),
      ENDED_LINGER_MS,
    );
    session.lingerTimer.unref();

    // Cerrar la sesión no es algo que haya que impedir: si el audit falla, se avisa en el log.
    await this.audit(
      CLOSE_TERMINAL_PTY_TOOL,
      {
        workspaceId: session.workspaceId,
        reason,
        bytesIn: session.bytesIn,
        bytesOut: session.bytesOut,
        seconds: Math.round((Date.now() - session.startedAt) / 1000),
      },
      `terminal interactiva: cerrar (${reason})`,
    ).catch((error: unknown) =>
      this.logger.error(
        `Terminal ${session.ptyId}: no se pudo auditar el cierre: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  private async audit(
    toolName: string,
    inputs: unknown,
    planSummary: string,
  ): Promise<void> {
    await this.auditService.recordToolCall({
      requestId: randomUUID(),
      actor: TERMINAL_ACTOR,
      toolName,
      inputsHash: computeInputsHash(inputs),
      planSummary,
      approvalStatus: 'auto',
    });
  }
}
