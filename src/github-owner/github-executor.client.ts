import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { GithubUnavailableError, GithubUpstreamError } from './github.errors';

export interface GithubRepo {
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly description: string | null;
}

export interface GithubCloneResult {
  readonly repo: string;
  readonly dir: string;
  readonly branch: string;
  readonly head: string;
}

export interface GithubRepoStatus {
  readonly repo: string;
  readonly branch: string;
  readonly head: string;
  readonly clean: boolean;
  readonly changed: readonly {
    readonly path: string;
    readonly status: string;
  }[];
  readonly changedTruncated: boolean;
}

export interface GithubBranches {
  readonly current: string;
  readonly local: readonly string[];
  readonly remote: readonly string[];
}

export interface GithubPushResult {
  readonly repo: string;
  readonly branch: string;
  readonly commit: string;
  readonly files: number;
  readonly url: string;
}

/**
 * Contrato HTTP con `/github` del Executor (ADR 0022). Todo git corre allí: Core no habla con GitHub ni
 * guarda tokens. Sin tipos compartidos entre repos: esto es el contrato, no un import.
 */
@Injectable()
export class GithubExecutorClient {
  private readonly baseUrl: string;

  constructor(configService: ConfigService<Env, true>) {
    const rawUrl = configService.get('EXECUTOR_BASE_URL', { infer: true });
    this.baseUrl = `${rawUrl.replace(/\/+$/, '')}/github`;
  }

  repos(): Promise<readonly GithubRepo[]> {
    return this.json('GET', '/repos');
  }

  clone(
    workspaceId: string,
    body: { repo: string; ref?: string | undefined; dir?: string | undefined },
  ): Promise<GithubCloneResult> {
    return this.json(
      'POST',
      `/workspaces/${encodeURIComponent(workspaceId)}/clone`,
      body,
    );
  }

  status(workspaceId: string, dir?: string): Promise<GithubRepoStatus> {
    return this.json(
      'GET',
      `/workspaces/${encodeURIComponent(workspaceId)}/status${dirQuery(dir)}`,
    );
  }

  branches(workspaceId: string, dir?: string): Promise<GithubBranches> {
    return this.json(
      'GET',
      `/workspaces/${encodeURIComponent(workspaceId)}/branches${dirQuery(dir)}`,
    );
  }

  checkout(
    workspaceId: string,
    body: {
      dir?: string | undefined;
      branch: string;
      create?: boolean | undefined;
    },
  ): Promise<{ branch: string; head: string }> {
    return this.json(
      'POST',
      `/workspaces/${encodeURIComponent(workspaceId)}/checkout`,
      body,
    );
  }

  pull(
    workspaceId: string,
    body: { dir?: string | undefined },
  ): Promise<{ branch: string; head: string; updated: boolean }> {
    return this.json(
      'POST',
      `/workspaces/${encodeURIComponent(workspaceId)}/pull`,
      body,
    );
  }

  push(
    workspaceId: string,
    body: { dir?: string | undefined; branch: string; message: string },
  ): Promise<GithubPushResult> {
    return this.json(
      'POST',
      `/workspaces/${encodeURIComponent(workspaceId)}/push`,
      body,
    );
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
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
      });
    } catch (error) {
      throw new GithubUnavailableError(error);
    }
    if (!response.ok) throw await GithubUpstreamError.fromResponse(response);
    return (await response.json()) as T;
  }
}

function dirQuery(dir: string | undefined): string {
  return dir === undefined ? '' : `?dir=${encodeURIComponent(dir)}`;
}
