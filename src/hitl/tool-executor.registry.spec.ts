import { describe, expect, it, vi } from 'vitest';
import {
  NoExecutorRegisteredError,
  ToolExecutorAlreadyRegisteredError,
  ToolExecutorRegistry,
} from './tool-executor.registry';

describe('ToolExecutorRegistry', () => {
  it('registra un executor y lo ejecuta con el payload exacto', async () => {
    const registry = new ToolExecutorRegistry();
    const executor = vi.fn().mockResolvedValue('resultado');
    registry.register('sendEmail', executor);

    const result = await registry.execute('sendEmail', { to: 'a@b.com' });

    expect(result).toBe('resultado');
    expect(executor).toHaveBeenCalledWith({ to: 'a@b.com' }, undefined);
  });

  it('le pasa al executor el contexto de quien ejecuta (p. ej. la aprobación), aparte del payload', async () => {
    const registry = new ToolExecutorRegistry();
    const executor = vi.fn().mockResolvedValue('ok');
    registry.register('sendEmail', executor);

    await registry.execute(
      'sendEmail',
      { to: 'a@b.com' },
      { requestId: 'req-1' },
    );

    expect(executor).toHaveBeenCalledWith(
      { to: 'a@b.com' },
      { requestId: 'req-1' },
    );
  });

  it('lanza ToolExecutorAlreadyRegisteredError ante doble registro del mismo toolName', () => {
    const registry = new ToolExecutorRegistry();
    registry.register('sendEmail', vi.fn());

    expect(() => registry.register('sendEmail', vi.fn())).toThrow(
      ToolExecutorAlreadyRegisteredError,
    );
  });

  it('lanza NoExecutorRegisteredError si nadie registró la tool', async () => {
    const registry = new ToolExecutorRegistry();

    await expect(registry.execute('sendEmail', {})).rejects.toThrow(
      NoExecutorRegisteredError,
    );
  });

  it('permite registrar executors para distintas tools sin conflicto', async () => {
    const registry = new ToolExecutorRegistry();
    const sendEmailExecutor = vi.fn().mockResolvedValue('email enviado');
    const deleteEventExecutor = vi.fn().mockResolvedValue('evento borrado');
    registry.register('sendEmail', sendEmailExecutor);
    registry.register('deleteCalendarEventFuture', deleteEventExecutor);

    await expect(registry.execute('sendEmail', {})).resolves.toBe(
      'email enviado',
    );
    await expect(
      registry.execute('deleteCalendarEventFuture', {}),
    ).resolves.toBe('evento borrado');
  });
});
