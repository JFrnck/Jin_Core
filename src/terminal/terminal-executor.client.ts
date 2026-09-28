import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import {
  TerminalUnavailableError,
  TerminalUpstreamError,
} from './terminal.errors';

export interface TerminalSessionInfo {
  readonly id: string;
  readonly status: 'starting' | 'running' | 'expired' | 'failed';
  readonly expiresAt: string;
  /** Aprobación que abrió la sesión (enlace con el audit); null en sesiones anteriores. */
  readonly requestId: string | null;
  readonly exposure: { readonly slug: string; readonly url: string } | null;
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
 * Contrato HTTP con `/terminal/sessions` del Executor (ADR 0016). Sin tipos
 * compartidos entre repos: esto es el contrato, no un import.
 */
@Injectable()
export class TerminalExecutorClient {
  private readonly baseUrl: string;

  constructor(configService: ConfigService<Env, true>) {
    const rawUrl = configService.get('EXECUTOR_BASE_URL', { infer: true });
    this.baseUrl = `${rawUrl.replace(/\/+$/, '')}/terminal/sessions`;
  }

  start(input: {
    files: Readonly<Record<string, string>>;
    ttlSeconds: number;
    requestId?: string | undefined;
  }): Promise<TerminalSessionInfo> {
    return this.json('POST', '', input);
  }

  list(): Promise<readonly TerminalSessionInfo[]> {
    return this.json('GET', '');
  }

  async stop(id: string): Promise<void> {
    await this.send('DELETE', `/${encodeURIComponent(id)}`);
  }

  exportFiles(id: string, dir: string): Promise<TerminalExportResult> {
    return this.json(
      'GET',
      `/${encodeURIComponent(id)}/files?dir=${encodeURIComponent(dir)}`,
    );
  }

  importFiles(
    id: string,
    files: Readonly<Record<string, string>>,
  ): Promise<{ written: number }> {
    return this.json('PUT', `/${encodeURIComponent(id)}/files`, { files });
  }

  expose(
    id: string,
    input: {
      dir: string;
      slugHint?: string | undefined;
      port: number;
      serverSource: string;
    },
  ): Promise<{ slug: string; url: string }> {
    return this.json('POST', `/${encodeURIComponent(id)}/expose`, input);
  }

  startService(
    id: string,
    input: { command: string; port: number },
  ): Promise<TerminalServiceStart> {
    return this.json('POST', `/${encodeURIComponent(id)}/services`, input);
  }

  listServices(id: string): Promise<readonly TerminalServiceInfo[]> {
    return this.json('GET', `/${encodeURIComponent(id)}/services`);
  }

  async stopService(id: string, port: number): Promise<void> {
    await this.send('DELETE', `/${encodeURIComponent(id)}/services/${port}`);
  }

  async serviceLogs(id: string, port: number): Promise<string> {
    const result = await this.json<{ log: string }>(
      'GET',
      `/${encodeURIComponent(id)}/services/${port}/logs`,
    );
    return result.log;
  }

  /**
   * Reenvía una petición al puerto de un servidor de la sesión. Devuelve la
   * respuesta SIN validar el estado: un 404 o un 500 del servidor del owner es
   * parte de lo que quiere ver. Solo los fallos del propio Executor (sesión
   * inexistente, puerto inválido, red) salen como error.
   */
  async proxy(
    id: string,
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
        `${this.baseUrl}/${encodeURIComponent(id)}/proxy/${port}${request.pathAndQuery}`,
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
    // una respuesta sin la marca es un fallo del propio Executor (sesión, puerto, red).
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
    id: string,
    input: { command: string; timeoutSeconds?: number | undefined },
    signal: AbortSignal,
  ): Promise<Response> {
    return this.send('POST', `/${encodeURIComponent(id)}/exec`, input, signal);
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
