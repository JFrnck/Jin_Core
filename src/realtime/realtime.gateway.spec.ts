import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  let gateway: RealtimeGateway;

  beforeEach(() => {
    jwtService = new JwtService({ secret: 'a'.repeat(32) });
    gateway = new RealtimeGateway(jwtService);
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

  it('reenvía los eventos de BudgetAlertMonitor como budget:alert y kill-switch:activated', () => {
    const emit = vi.fn();
    Object.assign(gateway, { server: { emit } });

    gateway.handleBudgetThresholdCrossed({ ratio: 0.83, threshold: 0.8 });
    gateway.handleKillSwitchActivated();

    expect(emit).toHaveBeenCalledWith('budget:alert', {
      ratio: 0.83,
      threshold: 0.8,
    });
    expect(emit).toHaveBeenCalledWith('kill-switch:activated', {});
  });
});
