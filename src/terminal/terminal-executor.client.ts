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
  readonly exposure: { readonly slug: string; readonly url: string } | null;
}

export interface TerminalExportResult {
  readonly files: Readonly<Record<string, string>>;
  readonly skipped: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}

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
