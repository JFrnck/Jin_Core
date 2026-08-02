import { describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../agent/agent.service';
import type { AgentTurnResult } from '../agent/agent.types';
import { ChatController } from './chat.controller';

describe('ChatController', () => {
  it('delega en AgentService.runTurn con actorLabel "web-chat"', async () => {
    const result: AgentTurnResult = {
      finalResponse: 'hola',
      plan: { steps: [] },
      pendingApprovals: [],
      iterationsUsed: 1,
    };
    const runTurn = vi.fn().mockResolvedValue(result);
    const controller = new ChatController({
      runTurn,
    } as unknown as AgentService);

    await controller.chat({ sessionId: 's1', objective: 'saluda' });

    expect(runTurn).toHaveBeenCalledWith({
      sessionId: 's1',
      objective: 'saluda',
      actorLabel: 'web-chat',
    });
  });

  it('pasa el history cuando el caller lo manda', async () => {
    const runTurn = vi.fn().mockResolvedValue({
      finalResponse: '',
      plan: { steps: [] },
      pendingApprovals: [],
      iterationsUsed: 1,
    });
    const controller = new ChatController({
      runTurn,
    } as unknown as AgentService);
    const history = [{ role: 'user' as const, content: 'hola' }];

    await controller.chat({ sessionId: 's1', objective: 'sigue', history });

    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ history }));
  });
});
