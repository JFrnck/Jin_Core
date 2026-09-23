import { describe, expect, it, vi } from 'vitest';
import { RelayDashboardController } from './relay-dashboard.controller';
import type { RelayHistoryMessage } from './relay.types';
import type { RelayService } from './relay.service';

function buildController(overrides?: Partial<RelayService>): RelayDashboardController {
  const relayService: Partial<RelayService> = {
    history: vi.fn().mockResolvedValue([]),
    reply: vi.fn().mockResolvedValue({ id: 'in-1' }),
    ...overrides,
  };
  return new RelayDashboardController(relayService as RelayService);
}

function historyMessage(
  overrides: Partial<RelayHistoryMessage> = {},
): RelayHistoryMessage {
  return {
    id: 'o-1',
    direction: 'out',
    body: 'hola',
    bodyHtml: 'hola',
    createdAt: '2026-09-22T12:00:00.000Z',
    ...overrides,
  };
}

describe('RelayDashboardController', () => {
  it('messages() delega en RelayService.history() con el `limit` ya resuelto por el ZodValidationPipe global', async () => {
    const history = vi.fn().mockResolvedValue([historyMessage()]);
    const controller = buildController({ history });

    // El default (50) y la coerción de string->number los aplica el pipe
    // global antes de llegar acá (mismo patrón que orchestrator/audit
    // controllers) — el controller solo reenvía el número ya resuelto.
    const result = await controller.messages({ limit: 50 });

    expect(history).toHaveBeenCalledWith(50);
    expect(result.messages).toEqual([historyMessage()]);
  });

  it('messages() reenvía un `limit` explícito', async () => {
    const history = vi.fn().mockResolvedValue([]);
    const controller = buildController({ history });

    await controller.messages({ limit: 10 });

    expect(history).toHaveBeenCalledWith(10);
  });

  it('messages() copia el array `options` para no filtrar el readonly del dominio al borde HTTP', async () => {
    const withOptions = historyMessage({ options: ['Sí', 'No'] });
    const history = vi.fn().mockResolvedValue([withOptions]);
    const controller = buildController({ history });

    const result = await controller.messages({ limit: 50 });

    expect(result.messages[0]?.options).toEqual(['Sí', 'No']);
    expect(result.messages[0]?.options).not.toBe(withOptions.options);
  });

  it('reply() delega en RelayService.reply() con el body y el answerTo opcional', async () => {
    const reply = vi.fn().mockResolvedValue({ id: 'in-1' });
    const controller = buildController({ reply });

    const result = await controller.reply({
      body: 'dale, segui',
      answerTo: '11111111-1111-1111-1111-111111111111',
    });

    expect(reply).toHaveBeenCalledWith({
      body: 'dale, segui',
      answerTo: '11111111-1111-1111-1111-111111111111',
    });
    expect(result).toEqual({ id: 'in-1' });
  });

  it('reply() sin answerTo manda un mensaje suelto, no una correlación inventada', async () => {
    const reply = vi.fn().mockResolvedValue({ id: 'in-2' });
    const controller = buildController({ reply });

    await controller.reply({ body: 'un mensaje cualquiera' });

    expect(reply).toHaveBeenCalledWith({ body: 'un mensaje cualquiera' });
  });
});
