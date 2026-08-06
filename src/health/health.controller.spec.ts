import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';
import type { HealthReport, HealthService } from './health.service';

function buildResponse(): {
  res: Response;
  setStatus: ReturnType<typeof vi.fn>;
} {
  const setStatus = vi.fn();
  return { res: { status: setStatus } as unknown as Response, setStatus };
}

function buildController(report: HealthReport): {
  controller: HealthController;
  check: ReturnType<typeof vi.fn>;
} {
  const check = vi.fn().mockResolvedValue(report);
  const controller = new HealthController({
    check,
  } as unknown as HealthService);
  return { controller, check };
}

describe('HealthController', () => {
  it('liveness responde sin consultar dependencias: reiniciar el pod no arregla un Postgres caído', () => {
    const { controller, check } = buildController({
      status: 'error',
      postgres: 'down',
      redis: 'down',
    });

    expect(controller.live()).toEqual({ status: 'ok' });
    expect(check).not.toHaveBeenCalled();
  });

  it('readiness con todo arriba → 200 (no toca el status code)', async () => {
    const { controller } = buildController({
      status: 'ok',
      postgres: 'up',
      redis: 'up',
    });
    const { res, setStatus } = buildResponse();

    await expect(controller.ready(res)).resolves.toEqual({
      status: 'ok',
      postgres: 'up',
      redis: 'up',
    });
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('readiness degraded → sigue siendo 200: Redis caído no saca el pod de rotación', async () => {
    const { controller } = buildController({
      status: 'degraded',
      postgres: 'up',
      redis: 'down',
    });
    const { res, setStatus } = buildResponse();

    await controller.ready(res);

    expect(setStatus).not.toHaveBeenCalled();
  });

  it('readiness error → 503, que es lo que el kubelet lee para sacar el pod de rotación', async () => {
    const { controller } = buildController({
      status: 'error',
      postgres: 'down',
      redis: 'up',
    });
    const { res, setStatus } = buildResponse();

    await controller.ready(res);

    expect(setStatus).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
  });
});
