import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BudgetService } from '../budget/budget.service';
import type { KillSwitchService } from '../budget/kill-switch.service';
import { RealtimeGateway } from './realtime.gateway';

function buildSocket(overrides?: {
  auth?: Record<string, unknown>;
  headers?: Record<string, string>;
}): {
  client: Parameters<RealtimeGateway['handleConnection']>[0];
  disconnect: ReturnType<typeof vi.fn>;
} {
  const disconnect = vi.fn();
  const client = {
    handshake: {
      auth: overrides?.auth ?? {},
      headers: overrides?.headers ?? {},
    },
    disconnect,
  } as unknown as Parameters<RealtimeGateway['handleConnection']>[0];
  return { client, disconnect };
}

describe('RealtimeGateway', () => {
  let jwtService: JwtService;
  let budgetService: Partial<BudgetService>;
  let killSwitchService: Partial<KillSwitchService>;
  let gateway: RealtimeGateway;

  beforeEach(() => {
    jwtService = new JwtService({ secret: 'a'.repeat(32) });
    budgetService = { getDailyUsageRatio: vi.fn().mockResolvedValue(0) };
    killSwitchService = { isActive: vi.fn().mockResolvedValue(false) };
    gateway = new RealtimeGateway(
      jwtService,
      budgetService as BudgetService,
      killSwitchService as KillSwitchService,
    );
  });

  it('desconecta un cliente sin token', async () => {
    const { client, disconnect } = buildSocket();
    await gateway.handleConnection(client);
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('desconecta un cliente con token inválido', async () => {
    const { client, disconnect } = buildSocket({
      auth: { token: 'no-es-un-jwt' },
    });
    await gateway.handleConnection(client);
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('acepta un cliente con token válido', async () => {
    const token = await jwtService.signAsync({ sub: 'owner' });
    const { client, disconnect } = buildSocket({ auth: { token } });
    await gateway.handleConnection(client);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('handlePendingApprovalCreated emite pending-approval:new a todos los clientes', () => {
    const emit = vi.fn();
    // `server` es privado — la única forma real de setearlo desde fuera
    // es vía el mismo mecanismo que usa Nest (`@WebSocketServer()`
    // asigna la propiedad directamente), así que se replica acá.
    Object.assign(gateway, { server: { emit } });

    const event = {
      requestId: 'r1',
      toolName: 'sendEmail',
      level: 'confirm' as const,
    };
    gateway.handlePendingApprovalCreated(event);

    expect(emit).toHaveBeenCalledWith('pending-approval:new', event);
  });
});
