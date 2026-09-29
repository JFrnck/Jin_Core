import type { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalPtyService, PtyListener } from './terminal-pty.service';
import { TerminalUpstreamError } from './terminal.errors';
import { TerminalGateway } from './terminal.gateway';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PTY_ID = '99999999-9999-4999-8999-999999999999';

interface FakeClient {
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  data: Record<string, unknown>;
  handshake: {
    auth: Record<string, unknown>;
    headers: Record<string, string>;
  };
}

function fakeClient(token?: string): FakeClient {
  return {
    emit: vi.fn(),
    disconnect: vi.fn(),
    data: {},
    handshake: { auth: token ? { token } : {}, headers: {} },
  };
}

function setup(overrides: Partial<Record<string, unknown>> = {}) {
  const openOrAttach = vi.fn(
    (_workspace: string, _size: unknown, _listener: PtyListener) =>
      Promise.resolve({ ptyId: PTY_ID, resumed: false }),
  );
  const input = vi.fn();
  const resize = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve());
  const detach = vi.fn();
  const service = {
    openOrAttach,
    input,
    resize,
    close,
    detach,
    ...overrides,
  } as unknown as TerminalPtyService;
  const verifyAsync = vi.fn(() => Promise.resolve({}));
  const gateway = new TerminalGateway(service, {
    verifyAsync,
  } as unknown as JwtService);
  return { gateway, openOrAttach, input, resize, close, detach, verifyAsync };
}

const openPayload = { workspaceId: WORKSPACE, cols: 80, rows: 24 };
const events = (client: FakeClient): string[] =>
  client.emit.mock.calls.map((call) => call[0] as string);

describe('TerminalGateway (/terminal)', () => {
  describe('auth del handshake', () => {
    it('sin token: desconecta', async () => {
      const { gateway } = setup();
      const client = fakeClient();
      await gateway.handleConnection(client as never);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('token inválido: desconecta', async () => {
      const { gateway, verifyAsync } = setup();
      verifyAsync.mockRejectedValueOnce(new Error('jwt malformed'));
      const client = fakeClient('malo');
      await gateway.handleConnection(client as never);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('token válido: se queda', async () => {
      const { gateway } = setup();
      const client = fakeClient('bueno');
      await gateway.handleConnection(client as never);
      expect(client.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('pty:open', () => {
    it.each([
      ['sin workspace', { cols: 80, rows: 24 }],
      ['workspace que no es uuid', { ...openPayload, workspaceId: 'x' }],
      ['columnas fuera de rango', { ...openPayload, cols: 5 }],
      ['filas fuera de rango', { ...openPayload, rows: 500 }],
      ['no es un objeto', 'hola'],
    ])(
      'payload inválido (%s): pty:error y no abre nada',
      async (_name, payload) => {
        const { gateway, openOrAttach } = setup();
        const client = fakeClient();
        await gateway.open(payload, client as never);
        expect(events(client)).toEqual(['pty:error']);
        expect(openOrAttach).not.toHaveBeenCalled();
      },
    );

    it('abre y responde pty:opened con el ptyId', async () => {
      const { gateway, openOrAttach } = setup();
      const client = fakeClient();
      await gateway.open(openPayload, client as never);

      expect(openOrAttach).toHaveBeenCalledWith(
        WORKSPACE,
        { cols: 80, rows: 24 },
        expect.any(Function),
      );
      expect(client.emit).toHaveBeenCalledWith('pty:opened', {
        ptyId: PTY_ID,
        resumed: false,
      });
    });

    it('la salida guardada que llega durante la apertura sale DESPUÉS de pty:opened', async () => {
      const { gateway, openOrAttach } = setup();
      openOrAttach.mockImplementationOnce((_w, _s, listener) => {
        listener({ type: 'out', data: 'AAAA' });
        return Promise.resolve({ ptyId: PTY_ID, resumed: true });
      });
      const client = fakeClient();
      await gateway.open(openPayload, client as never);

      expect(events(client)).toEqual(['pty:opened', 'pty:output']);
      expect(client.emit).toHaveBeenLastCalledWith('pty:output', {
        data: 'AAAA',
      });
    });

    it('después de abrir, los eventos se reenvían con su nombre', async () => {
      const { gateway, openOrAttach } = setup();
      let listener: PtyListener | undefined;
      openOrAttach.mockImplementationOnce((_w, _s, l) => {
        listener = l;
        return Promise.resolve({ ptyId: PTY_ID, resumed: false });
      });
      const client = fakeClient();
      await gateway.open(openPayload, client as never);

      listener?.({ type: 'out', data: 'QQ==' });
      listener?.({ type: 'notice', message: 'ojo' });
      listener?.({ type: 'exit', code: 0 });
      listener?.({ type: 'error', message: 'roto' });

      expect(client.emit).toHaveBeenCalledWith('pty:output', { data: 'QQ==' });
      expect(client.emit).toHaveBeenCalledWith('pty:notice', {
        message: 'ojo',
      });
      expect(client.emit).toHaveBeenCalledWith('pty:exit', { code: 0 });
      expect(client.emit).toHaveBeenCalledWith('pty:error', {
        message: 'roto',
      });
    });

    it('un error de dominio le llega a la app con su mensaje', async () => {
      const { gateway, openOrAttach } = setup();
      openOrAttach.mockRejectedValueOnce(
        new TerminalUpstreamError(409, 'La terminal no está corriendo.'),
      );
      const client = fakeClient();
      await gateway.open(openPayload, client as never);
      expect(client.emit).toHaveBeenCalledWith('pty:error', {
        message: 'La terminal no está corriendo.',
      });
    });

    it('un error inesperado NO filtra detalles internos', async () => {
      const { gateway, openOrAttach } = setup();
      openOrAttach.mockRejectedValueOnce(
        new Error('ECONNREFUSED 10.0.0.5:3001'),
      );
      const client = fakeClient();
      await gateway.open(openPayload, client as never);
      expect(client.emit).toHaveBeenCalledWith('pty:error', {
        message: 'Falló la terminal.',
      });
    });

    it('volver a abrir por la misma conexión suelta la suscripción anterior y se reengancha', async () => {
      const { gateway, openOrAttach, detach } = setup();
      openOrAttach.mockResolvedValueOnce({ ptyId: PTY_ID, resumed: false });
      openOrAttach.mockResolvedValueOnce({ ptyId: PTY_ID, resumed: true });
      const client = fakeClient();

      await gateway.open(openPayload, client as never);
      await gateway.open(openPayload, client as never);

      expect(detach).toHaveBeenCalledTimes(1);
      expect(detach).toHaveBeenCalledWith(PTY_ID, expect.any(Function));
      expect(openOrAttach).toHaveBeenCalledTimes(2);
      expect(client.emit).toHaveBeenLastCalledWith('pty:opened', {
        ptyId: PTY_ID,
        resumed: true,
      });
    });

    it('si la reapertura falla, la conexión queda sin terminal (no arrastra la anterior)', async () => {
      const { gateway, openOrAttach, detach } = setup();
      const client = fakeClient();
      await gateway.open(openPayload, client as never);

      openOrAttach.mockRejectedValueOnce(
        new TerminalUpstreamError(409, 'no está corriendo'),
      );
      await gateway.open(openPayload, client as never);
      gateway.handleDisconnect(client as never);

      expect(client.emit).toHaveBeenLastCalledWith('pty:error', {
        message: 'no está corriendo',
      });
      // Solo el detach de la reapertura; al desconectarse no hay nada más que soltar.
      expect(detach).toHaveBeenCalledTimes(1);
    });
  });

  describe('teclado, tamaño y cierre', () => {
    it('pty:input decodifica el base64 y lo manda a la sesión', async () => {
      const { gateway, input } = setup();
      const client = fakeClient();
      await gateway.open(openPayload, client as never);

      gateway.input(
        { data: Buffer.from('ls\r').toString('base64') },
        client as never,
      );

      expect(input).toHaveBeenCalledTimes(1);
      const [ptyId, bytes] = input.mock.calls[0] as [string, Buffer];
      expect(ptyId).toBe(PTY_ID);
      expect(bytes.toString()).toBe('ls\r');
    });

    it('pty:input inválido, demasiado grande o sin terminal abierta se ignora', async () => {
      const { gateway, input } = setup();
      const client = fakeClient();

      gateway.input({ data: 'QQ==' }, client as never); // sin terminal abierta
      await gateway.open(openPayload, client as never);
      gateway.input({ data: '!!!no-base64!!!' }, client as never);
      gateway.input({ data: 'A'.repeat(100 * 1024) }, client as never);
      gateway.input({}, client as never);
      gateway.input(null, client as never);

      expect(input).not.toHaveBeenCalled();
    });

    it('pty:resize valida el rango y reenvía', async () => {
      const { gateway, resize } = setup();
      const client = fakeClient();
      await gateway.open(openPayload, client as never);

      await gateway.resize({ cols: 100, rows: 30 }, client as never);
      await gateway.resize({ cols: 1, rows: 30 }, client as never);

      expect(resize).toHaveBeenCalledTimes(1);
      expect(resize).toHaveBeenCalledWith(PTY_ID, { cols: 100, rows: 30 });
    });

    it('pty:close cierra la sesión y permite abrir otra en la misma conexión', async () => {
      const { gateway, close, openOrAttach } = setup();
      const client = fakeClient();
      await gateway.open(openPayload, client as never);

      await gateway.close(client as never);
      expect(close).toHaveBeenCalledWith(PTY_ID);

      await gateway.open(openPayload, client as never);
      expect(openOrAttach).toHaveBeenCalledTimes(2);
    });

    it('al desconectarse la app, suelta la sesión (empieza la gracia) sin cerrarla', async () => {
      const { gateway, detach, close } = setup();
      const client = fakeClient();
      await gateway.open(openPayload, client as never);

      gateway.handleDisconnect(client as never);

      expect(detach).toHaveBeenCalledWith(PTY_ID, expect.any(Function));
      expect(close).not.toHaveBeenCalled();
    });

    it('desconectarse sin haber abierto nada no hace nada', () => {
      const { gateway, detach } = setup();
      gateway.handleDisconnect(fakeClient() as never);
      expect(detach).not.toHaveBeenCalled();
    });
  });
});
