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
export type DemoDbEngine = 'sqlite' | 'redis' | 'postgres' | 'mongodb';

export interface StartPreviewServiceInput {
  readonly files: Readonly<Record<string, string>>;
  readonly command: readonly string[];
  readonly port: number;
  readonly ttlSeconds: number;
  readonly slugHint?: string;
  /** El pod puede enviar correo por el proxy `mail-egress` (Executor pone el label). */
  readonly mailEgress?: boolean;
  /** El backend instala dependencias por el proxy de npm (template "node"). */
  readonly npm?: boolean;
  /** Base de datos de DEMO: sqlite (archivo) o redis/postgres/mongodb (contenedor auxiliar en el pod). */
  readonly db?: DemoDbEngine;
  /** Secretos de demo (Secret `demo-secret-<n>` creado por el owner), como variables de entorno del pod. */
  readonly secrets?: readonly string[];
  /** Variables de entorno de ESTA demo (con valores): el Executor las pone en un Secret ligado al pod. */
  readonly env?: Readonly<Record<string, string>>;
  /** Aprobación que lo originó (enlace con el audit). */
  readonly requestId?: string;
}

export interface SaveGithubDemoResult {
  readonly repo: string;
  readonly branch: string;
  readonly slug: string;
  readonly commit: string;
  readonly files: number;
  /** `true` si la rama ya tenía exactamente esos archivos (no hubo commit nuevo). */
  readonly unchanged: boolean;
  readonly skipped: readonly { path: string; reason: string }[];
  readonly url: string;
}

export interface GithubDemoBranch {
  readonly slug: string;
  readonly branch: string;
  readonly commit: string;
}

export interface PreviewServiceInfo {
  readonly id: string;
  readonly slug: string;
  readonly url: string;
  readonly status: 'running' | 'expired';
  readonly expiresAt: string;
  /** Aprobación que lo originó; ausente en pods anteriores a este campo. */
  readonly requestId?: string;
  /** Motor de base de datos de la demo, si pidió uno. */
  readonly db?: string;
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

  /** Archivos de texto de un pod vivo, para traerlos al editor (Executor `GET /services/:id/files`). */
  async exportPreviewFiles(
    serviceId: string,
    dir: string,
  ): Promise<{
    files: Readonly<Record<string, string>>;
    skipped: readonly { path: string; reason: string }[];
  }> {
    const response = await fetch(
      `${this.baseUrl}/services/${encodeURIComponent(serviceId)}/files?dir=${encodeURIComponent(dir)}`,
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ExecutorApiError(response.status, errorText);
    }

    return (await response.json()) as {
      files: Readonly<Record<string, string>>;
      skipped: readonly { path: string; reason: string }[];
    };
  }

  /** Alarga la vida de un servicio activo (Executor `POST /services/:id/extend`); devuelve el nuevo vencimiento. */
  async extendPreviewService(
    serviceId: string,
    extraSeconds: number,
  ): Promise<PreviewServiceInfo> {
    const response = await fetch(
      `${this.baseUrl}/services/${encodeURIComponent(serviceId)}/extend`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extraSeconds }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ExecutorApiError(response.status, errorText);
    }

    return (await response.json()) as PreviewServiceInfo;
  }

  /**
   * Guarda una demo en GitHub (Executor `POST /github/demos`): rama huérfana `demo/<slug>`
   * del repo compartido. El token de la GitHub App vive solo en el Executor.
   */
  async saveGithubDemo(input: {
    serviceId: string;
    slug: string;
  }): Promise<SaveGithubDemoResult> {
    const response = await fetch(`${this.baseUrl}/github/demos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ExecutorApiError(response.status, errorText);
    }

    return (await response.json()) as SaveGithubDemoResult;
  }

  /** Las demos guardadas en GitHub (ramas `demo/*`). Solo lectura. */
  async listGithubDemos(): Promise<readonly GithubDemoBranch[]> {
    const response = await fetch(`${this.baseUrl}/github/demos`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new ExecutorApiError(response.status, errorText);
    }

    return (await response.json()) as readonly GithubDemoBranch[];
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
