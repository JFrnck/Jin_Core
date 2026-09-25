import { describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../agent/agent.service';
import type { AgentTurnInput, AgentTurnResult } from '../agent/agent.types';
import type { JwtService } from '@nestjs/jwt';
import { ChatGateway } from './chat.gateway';

function fakeClient() {
  return { emit: vi.fn() } as unknown as { emit: ReturnType<typeof vi.fn> };
}

describe('ChatGateway.handleMessage', () => {
  it('pasa onProgress a runTurn y reenvía cada evento como "chat:progress", además de "chat:response" al cerrar el turno', async () => {
    const result: AgentTurnResult = {
      finalResponse: 'Hola, ¿en qué te ayudo?',
      plan: { steps: [] },
      pendingApprovals: [],
      iterationsUsed: 1,
      modelsUsed: ['claude-sonnet-5'],
    };
    const runTurn = vi.fn().mockImplementation((input: AgentTurnInput) => {
      input.onProgress?.({
        type: 'text-delta',
        iteration: 1,
        delta: 'Hola',
        snapshot: 'Hola',
      });
      input.onProgress?.({
        type: 'text-delta',
        iteration: 1,
        delta: ', ¿en qué te ayudo?',
        snapshot: 'Hola, ¿en qué te ayudo?',
      });
      return result;
    });
    const gateway = new ChatGateway(
      { runTurn } as unknown as AgentService,
      {} as JwtService,
    );
    const client = fakeClient();

    await gateway.handleMessage(
      { sessionId: 's1', objective: 'saludame' },
      client as never,
    );

    const [input] = runTurn.mock.calls[0] as [AgentTurnInput];
    expect(input.sessionId).toBe('s1');
    expect(input.objective).toBe('saludame');
    expect(input.actorLabel).toBe('web-chat');
    expect(typeof input.onProgress).toBe('function');
    expect(client.emit).toHaveBeenNthCalledWith(1, 'chat:progress', {
      type: 'text-delta',
      iteration: 1,
      delta: 'Hola',
      snapshot: 'Hola',
    });
    expect(client.emit).toHaveBeenNthCalledWith(2, 'chat:progress', {
      type: 'text-delta',
      iteration: 1,
      delta: ', ¿en qué te ayudo?',
      snapshot: 'Hola, ¿en qué te ayudo?',
    });
    expect(client.emit).toHaveBeenNthCalledWith(3, 'chat:response', result);
  });

  it('si runTurn rechaza (ej. StreamAlreadyPartiallyEmittedError), emite "chat:error" — el texto parcial ya emitido por chat:progress no se retira', async () => {
    const runTurn = vi.fn().mockImplementation((input: AgentTurnInput) => {
      input.onProgress?.({
        type: 'text-delta',
        iteration: 1,
        delta: 'Hola',
        snapshot: 'Hola',
      });
      // Throw síncrono, no `async`/`Promise.reject`: el `try/catch` real de
      // `handleMessage` envuelve el `await this.agentService.runTurn(...)`
      // completo, así que atrapa esto igual — y evita que `mockImplementation`
      // (sin genéricos, inferido como void-returning) dispare
      // `no-misused-promises` por devolver una Promise.
      throw new Error(
        'El modelo "claude-sonnet-5" falló después de emitir contenido parcial al cliente',
      );
    });
    const gateway = new ChatGateway(
      { runTurn } as unknown as AgentService,
      {} as JwtService,
    );
    const client = fakeClient();

    await gateway.handleMessage(
      { sessionId: 's1', objective: 'saludame' },
      client as never,
    );

    expect(client.emit).toHaveBeenNthCalledWith(1, 'chat:progress', {
      type: 'text-delta',
      iteration: 1,
      delta: 'Hola',
      snapshot: 'Hola',
    });
    const [event, payload] = client.emit.mock.calls[1] as [
      string,
      { message: string },
    ];
    expect(event).toBe('chat:error');
    expect(payload.message).toContain('contenido parcial');
  });

  it('payload inválido: emite "chat:error" sin llamar a runTurn', async () => {
    const runTurn = vi.fn();
    const gateway = new ChatGateway(
      { runTurn } as unknown as AgentService,
      {} as JwtService,
    );
    const client = fakeClient();

    await gateway.handleMessage(
      { objective: 'sin sessionId' },
      client as never,
    );

    expect(runTurn).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('chat:error', {
      message: 'Payload inválido.',
    });
  });
});
