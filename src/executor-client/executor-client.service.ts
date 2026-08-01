import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { ExecutorApiError } from './errors';

export interface RunCodeInput {
  readonly code: string;
  readonly language: 'typescript' | 'python';
}

export interface ExecutionResult {
  readonly runId: string;
  readonly succeeded: boolean;
  readonly logs: string;
}

// Fase 5.5 (ADR 0006) — contrato HTTP con POST/DELETE/GET /services del
// Executor. Mismo criterio que RunCodeInput: sin tipos compartidos entre
// repos, esto es el contrato HTTP, no un import.
export interface StartPreviewServiceInput {
  readonly files: Readonly<Record<string, string>>;
  readonly command: readonly string[];
  readonly port: number;
  readonly ttlSeconds: number;
  readonly slugHint?: string;
}

export interface PreviewServiceInfo {
  readonly id: string;
  readonly slug: string;
  readonly url: string;
  readonly status: 'running' | 'expired';
  readonly expiresAt: string;
}

/**
 * Tope de cordura enviado en el request (AGENTS.md 4.5: no hay tipos
 * compartidos entre repos, este es el contrato HTTP, no un import). El
 * Executor igual aplica su propio hard cap por tool (`maxTimeoutSeconds`
 * local / `remoteMaxTimeoutSeconds` Modal, ver `tool-whitelist.ts` allá) —
 * este valor solo necesita ser mayor o igual al mayor de esos dos topes
 * para no recortar la ejecución antes de que el Executor lo haga.
 */
const EXECUTE_TIMEOUT_SECONDS = 1800;

/**
 * Cliente HTTP del Executor (BLUEPRINT 4 / PROMPTS.md 5.2). Deliberadamente
 * NO expone `env` como parámetro: el LLM nunca provee variables de entorno
 * (ver el comentario en `src/tools/registry.ts` sobre `runCode`), así que
 * siempre se envía `{}` fijo — defensa en profundidad, no una limitación
 * de la API del Executor.
 */
@Injectable()
export class ExecutorClientService {
  private readonly baseUrl: string;

  constructor(configService: ConfigService<Env, true>) {
    const rawUrl = configService.get('EXECUTOR_BASE_URL', { infer: true });
    this.baseUrl = rawUrl.replace(/\/+$/, '');
  }

  async runCode(input: RunCodeInput): Promise<ExecutionResult> {
    const response = await fetch(`${this.baseUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'runCode',
        code: input.code,
        language: input.language,
        env: {},
        timeout: EXECUTE_TIMEOUT_SECONDS,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ExecutorApiError(response.status, errorText);
    }

    return (await response.json()) as ExecutionResult;
  }

  async startPreviewService(
    input: StartPreviewServiceInput,
  ): Promise<PreviewServiceInfo> {
    const response = await fetch(`${this.baseUrl}/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'startPreviewService', ...input }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ExecutorApiError(response.status, errorText);
    }

    return (await response.json()) as PreviewServiceInfo;
  }

  async stopPreviewService(serviceId: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/services/${encodeURIComponent(serviceId)}`,
      { method: 'DELETE' },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ExecutorApiError(response.status, errorText);
    }
  }

  async listPreviewServices(): Promise<readonly PreviewServiceInfo[]> {
    const response = await fetch(`${this.baseUrl}/services`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ExecutorApiError(response.status, errorText);
    }

    return (await response.json()) as readonly PreviewServiceInfo[];
  }
}
