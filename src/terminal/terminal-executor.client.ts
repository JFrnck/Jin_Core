import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import {
  TerminalUnavailableError,
  TerminalUpstreamError,
} from './terminal.errors';

export interface TerminalWorkspaceInfo {
  readonly id: string;
  readonly status: 'stopped' | 'starting' | 'running' | 'expired' | 'failed';
  readonly createdAt: string;
  readonly expiresAt: string | null;
  /** Aprobación que abrió el pod actual (enlace con el audit); null si no hay pod. */
  readonly requestId: string | null;
  readonly exposure: { readonly slug: string; readonly url: string } | null;
  readonly lastActivityAt: string | null;
}

export interface TerminalExportResult {
  readonly files: Readonly<Record<string, string>>;
  readonly skipped: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}

export interface TerminalServiceInfo {
  readonly port: number;
  readonly command: string;
  readonly startedAt: string;
  readonly running: boolean;
  readonly listening: boolean;
}

export type TerminalServiceStart =
  | {
      readonly status: 'listening' | 'already-running' | 'timeout';
      readonly port: number;
      readonly log: string;
    }
  | {
      readonly status: 'exited';
      readonly port: number;
      readonly code: number;
      readonly log: string;
    };

/**
 * Contrato HTTP con `/terminal/workspaces` del Executor (ADR 0016 ampliada,
 * 2026-09-28: un disco por proyecto que sobrevive a que su pod se destruya).
 * Sin tipos compartidos entre repos: esto es el contrato, no un import.
 */
@Injectable()
export class TerminalExecutorClient {
  private readonly baseUrl: string;

  constructor(configService: ConfigService<Env, true>) {
    const rawUrl = configService.get('EXECUTOR_BASE_URL', { infer: true });
    this.baseUrl = `${rawUrl.replace(/\/+$/, '')}/terminal/workspaces`;
  }

  /** Todos los workspaces (proyectos con disco propio) del owner, corriendo o no. */
  list(): Promise<readonly TerminalWorkspaceInfo[]> {
    return this.json('GET', '');
  }

  start(
    workspaceId: string,
    input: {
      files: Readonly<Record<string, string>>;
      ttlSeconds: number;
      requestId?: string | undefined;
    },
  ): Promise<TerminalWorkspaceInfo> {
    return this.json(
      'POST',
      `/${encodeURIComponent(workspaceId)}/start`,
      input,
    );
  }

  /** Detiene el pod del workspace; el disco NO se toca. */
  async stopPod(workspaceId: string): Promise<void> {
    await this.send('DELETE', `/${encodeURIComponent(workspaceId)}/pod`);
  }

  /** Borra el pod (si lo hay) Y el disco del workspace. Irreversible. */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.send('DELETE', `/${encodeURIComponent(workspaceId)}`);
  }

  exportFiles(workspaceId: string, dir: string): Promise<TerminalExportResult> {
    return this.json(
      'GET',
      `/${encodeURIComponent(workspaceId)}/files?dir=${encodeURIComponent(dir)}`,
    );
  }

  importFiles(
    workspaceId: string,
    files: Readonly<Record<string, string>>,
  ): Promise<{ written: number }> {
    return this.json('PUT', `/${encodeURIComponent(workspaceId)}/files`, {
      files,
    });
  }

  expose(
    workspaceId: string,
    input: {
      dir: string;
      slugHint?: string | undefined;
      port: number;
      serverSource: string;
    },
  ): Promise<{ slug: string; url: string }> {
    return this.json(
      'POST',
      `/${encodeURIComponent(workspaceId)}/expose`,
      input,
    );
  }

  startService(
    workspaceId: string,
    input: { command: string; port: number },
  ): Promise<TerminalServiceStart> {
    return this.json(
      'POST',
      `/${encodeURIComponent(workspaceId)}/services`,
      input,
    );
  }

  listServices(workspaceId: string): Promise<readonly TerminalServiceInfo[]> {
    return this.json('GET', `/${encodeURIComponent(workspaceId)}/services`);
  }

  async stopService(workspaceId: string, port: number): Promise<void> {
    await this.send(
      'DELETE',
      `/${encodeURIComponent(workspaceId)}/services/${port}`,
    );
  }

  async serviceLogs(workspaceId: string, port: number): Promise<string> {
    const result = await this.json<{ log: string }>(
      'GET',
      `/${encodeURIComponent(workspaceId)}/services/${port}/logs`,
    );
    return result.log;
  }

  /**
   * Reenvía una petición al puerto de un servidor del workspace. Devuelve la
   * respuesta SIN validar el estado: un 404 o un 500 del servidor del owner es
   * parte de lo que quiere ver. Solo los fallos del propio Executor (workspace
   * inexistente, puerto inválido, red) salen como error.
   */
  async proxy(
    workspaceId: string,
    port: number,
    request: {
      method: string;
      pathAndQuery: string;
      headers: Readonly<Record<string, string>>;
      body?: Buffer | undefined;
      signal: AbortSignal;
    },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/${encodeURIComponent(workspaceId)}/proxy/${port}${request.pathAndQuery}`,
        {
          method: request.method,
          headers: request.headers,
          ...(request.body ? { body: new Uint8Array(request.body) } : {}),
          signal: request.signal,
          redirect: 'manual',
        },
      );
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw new TerminalUnavailableError(error);
    }
    // El Executor marca con `x-jin-proxied` lo que viene del servidor del owner;
    // una respuesta sin la marca es un fallo del propio Executor (workspace, puerto, red).
    if (response.headers.get('x-jin-proxied') !== '1') {
      throw await TerminalUpstreamError.fromResponse(response);
    }
    return response;
  }

  /**
   * Abre el stream NDJSON de un comando. Devuelve la respuesta ya validada
   * (2xx): los errores previos al primer byte (404, 409...) salen como
   * `TerminalUpstreamError`. `signal` corta la conexión si el owner se va.
   */
  async openExec(
    workspaceId: string,
    input: { command: string; timeoutSeconds?: number | undefined },
    signal: AbortSignal,
  ): Promise<Response> {
    return this.send(
      'POST',
      `/${encodeURIComponent(workspaceId)}/exec`,
      input,
      signal,
    );
  }

  // ── Terminal interactiva (PTY) ─────────────────────────────────────────
  // El Executor solo transporta bytes; el audit y los topes son de Core.

  async openPty(
    workspaceId: string,
    size: { readonly cols: number; readonly rows: number },
  ): Promise<{ ptyId: string }> {
    return this.json<{ ptyId: string }>(
      'POST',
      `/${encodeURIComponent(workspaceId)}/pty`,
      size,
    );
  }

  /** Stream NDJSON de la salida (`{t:'out', d:<base64>}`, luego `exit` o `error`). */
  async ptyOutput(
    workspaceId: string,
    ptyId: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.send(
      'GET',
      `/${encodeURIComponent(workspaceId)}/pty/${encodeURIComponent(ptyId)}/output`,
      undefined,
      signal,
    );
  }

  async ptyInput(
    workspaceId: string,
    ptyId: string,
    data: Buffer,
  ): Promise<void> {
    await this.send(
      'POST',
      `/${encodeURIComponent(workspaceId)}/pty/${encodeURIComponent(ptyId)}/input`,
      { data: data.toString('base64') },
    );
  }

  async ptyResize(
    workspaceId: string,
    ptyId: string,
    size: { readonly cols: number; readonly rows: number },
  ): Promise<void> {
    await this.send(
      'POST',
      `/${encodeURIComponent(workspaceId)}/pty/${encodeURIComponent(ptyId)}/resize`,
      size,
    );
  }

  async closePty(workspaceId: string, ptyId: string): Promise<void> {
    await this.send(
      'DELETE',
      `/${encodeURIComponent(workspaceId)}/pty/${encodeURIComponent(ptyId)}`,
    );
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.send(method, path, body);
    return (await response.json()) as T;
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        ...(body !== undefined
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TerminalUnavailableError(error);
    }
    if (!response.ok) throw await TerminalUpstreamError.fromResponse(response);
    return response;
  }
}
