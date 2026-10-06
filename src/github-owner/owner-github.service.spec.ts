import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { DualConfirmService } from '../hitl/dual-confirm.service';
import type { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import type { HitlPolicyService } from '../hitl-policy/hitl-policy.service';
import { getToolDefinition } from '../tools/registry';
import type {
  GithubExecutorClient,
  GithubRepoStatus,
} from './github-executor.client';
import { OwnerGithubService, PUSH_TOOL_NAME } from './owner-github.service';

const WS = '22222222-2222-4222-8222-222222222222';
const dirty: GithubRepoStatus = {
  repo: 'acme/app',
  branch: 'main',
  head: 'a'.repeat(40),
  clean: false,
  changed: [
    { path: 'src/a.ts', status: 'M' },
    { path: 'src/b.ts', status: '??' },
  ],
  changedTruncated: false,
};

function setup(level: 'confirm' | 'notify' | 'auto' = 'confirm') {
  const client = {
    repos: vi.fn().mockResolvedValue([]),
    clone: vi.fn().mockResolvedValue({
      repo: 'acme/app',
      dir: '.',
      branch: 'main',
      head: 'h',
    }),
    status: vi.fn().mockResolvedValue(dirty),
    branches: vi.fn(),
    checkout: vi.fn().mockResolvedValue({ branch: 'x', head: 'h' }),
    pull: vi
      .fn()
      .mockResolvedValue({ branch: 'main', head: 'h', updated: true }),
    push: vi.fn().mockResolvedValue({
      repo: 'acme/app',
      branch: 'jin/x',
      commit: 'c',
      files: 2,
      url: 'u',
    }),
  };
  const recorded: Array<Record<string, unknown>> = [];
  const audit = {
    recordToolCall: vi.fn((input: Record<string, unknown>) => {
      recorded.push(input);
      return Promise.resolve({});
    }),
  };
  const policy = {
    decide: vi.fn().mockResolvedValue({ level, requestId: 'req-1' }),
  };
  const dual = { createPendingApproval: vi.fn().mockResolvedValue(undefined) };
  const registry = {
    execute: vi.fn().mockResolvedValue({
      repo: 'acme/app',
      branch: 'jin/x',
      commit: 'c',
      files: 2,
      url: 'u',
    }),
  };
  const emitter = { emit: vi.fn() };
  const service = new OwnerGithubService(
    client as unknown as GithubExecutorClient,
    policy as unknown as HitlPolicyService,
    dual as unknown as DualConfirmService,
    registry as unknown as ToolExecutorRegistry,
    audit as unknown as AuditService,
    emitter as never,
  );
  return { service, client, audit, recorded, policy, dual, registry, emitter };
}

describe('OwnerGithubService', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('clonar, cambiar de rama y actualizar son del owner: se auditan (auto) y llegan al Executor', async () => {
    await ctx.service.clone(WS, { repo: 'acme/app', dir: 'app' });
    await ctx.service.checkout(WS, { branch: 'trabajo', create: true });
    await ctx.service.pull(WS, {});
    expect(ctx.client.clone).toHaveBeenCalledWith(WS, {
      repo: 'acme/app',
      dir: 'app',
    });
    expect(ctx.client.checkout).toHaveBeenCalledWith(WS, {
      branch: 'trabajo',
      create: true,
    });
    expect(ctx.recorded.map((r) => r.toolName)).toEqual([
      'githubCloneRepo',
      'githubCheckout',
      'githubPull',
    ]);
    expect(
      ctx.recorded.every(
        (r) => r.approvalStatus === 'auto' && r.actor === 'owner:api',
      ),
    ).toBe(true);
  });

  it('subir cambios con confirm deja una aprobación pendiente que dice qué repo, cuántos archivos y la rama; no se ejecuta nada', async () => {
    const result = await ctx.service.requestPush(WS, {
      branch: 'jin/x',
      message: 'Mi cambio',
    });
    expect(result).toEqual({ status: 'pending-approval', requestId: 'req-1' });
    expect(ctx.registry.execute).not.toHaveBeenCalled();
    expect(ctx.client.push).not.toHaveBeenCalled();
    const approval = ctx.dual.createPendingApproval.mock.calls[0]?.[0] as {
      toolName: string;
      level: string;
      planSummary: string;
      payload: Record<string, unknown>;
    };
    expect(approval).toMatchObject({
      toolName: PUSH_TOOL_NAME,
      level: 'confirm',
    });
    expect(approval.planSummary).toContain('acme/app');
    expect(approval.planSummary).toContain('jin/x');
    expect(approval.planSummary).toContain('2 archivos');
    expect(approval.payload).toEqual({
      workspaceId: WS,
      dir: '.',
      branch: 'jin/x',
      message: 'Mi cambio',
      repo: 'acme/app',
      files: 2,
    });
  });

  it('sin cambios no se crea ninguna aprobación', async () => {
    ctx.client.status.mockResolvedValue({ ...dirty, clean: true, changed: [] });
    await expect(
      ctx.service.requestPush(WS, { branch: 'jin/x', message: 'm' }),
    ).rejects.toThrow(BadRequestException);
    expect(ctx.policy.decide).not.toHaveBeenCalled();
    expect(ctx.dual.createPendingApproval).not.toHaveBeenCalled();
  });

  it('si la política lo relajó a notify, se ejecuta, se audita y se avisa', async () => {
    const relaxed = setup('notify');
    const result = await relaxed.service.requestPush(WS, {
      branch: 'jin/x',
      message: 'm',
    });
    expect(result.status).toBe('pushed');
    expect(relaxed.registry.execute).toHaveBeenCalledWith(
      PUSH_TOOL_NAME,
      expect.objectContaining({ branch: 'jin/x' }),
      { requestId: 'req-1' },
    );
    expect(relaxed.recorded[0]).toMatchObject({
      toolName: PUSH_TOOL_NAME,
      approvalStatus: 'notified',
    });
    expect(relaxed.emitter.emit).toHaveBeenCalled();
  });

  it('executePush manda al Executor solo lo aprobado', async () => {
    await ctx.service.executePush({
      workspaceId: WS,
      dir: 'app',
      branch: 'jin/x',
      message: 'm',
      repo: 'acme/app',
      files: 2,
    });
    expect(ctx.client.push).toHaveBeenCalledWith(WS, {
      dir: 'app',
      branch: 'jin/x',
      message: 'm',
    });
  });

  it('en el registro, pushGithubBranch es confirm y humanDecision (ningún modo de autonomía lo relaja)', () => {
    const tool = getToolDefinition(PUSH_TOOL_NAME);
    expect(tool).toMatchObject({ hitlLevel: 'confirm', humanDecision: true });
  });
});
