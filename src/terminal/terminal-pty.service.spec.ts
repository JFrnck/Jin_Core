import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { TerminalExecutorClient } from './terminal-executor.client';
import { TerminalPtyService, type PtyEvent } from './terminal-pty.service';
import { TerminalUpstreamError } from './terminal.errors';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PTY_ID = '99999999-9999-4999-8999-999999999999';
const SIZE = { cols: 80, rows: 24 };
const enc = new TextEncoder();
const b64 = (text: string): string => Buffer.from(text).toString('base64');
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

function ndjsonStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body),
    push: (event: object) =>
      controller.enqueue(enc.encode(`${JSON.stringify(event)}\n`)),
  };
}

interface AuditInput {
  toolName: string;
  planSummary?: string;
}

function setup() {
  const order: string[] = [];
  const stream = ndjsonStream();
  const openPty = vi.fn(() => {
    order.push('executor.open');
    return Promise.resolve({ ptyId: PTY_ID });
  });
  const ptyOutput = vi.fn(() => Promise.resolve(stream.response));
  const ptyInput = vi.fn((_w: string, _p: string, data: Buffer) => {
    order.push(`input:${JSON.stringify(data.toString())}`);
    return Promise.resolve();
  });
  const ptyResize = vi.fn(() => Promise.resolve());
  const closePty = vi.fn(() => {
    order.push('executor.close');
    return Promise.resolve();
  });
  const executor = {
    openPty,
    ptyOutput,
    ptyInput,
    ptyResize,
    closePty,
  } as unknown as TerminalExecutorClient;

  const recordToolCall = vi.fn((input: AuditInput) => {
    order.push(`audit:${input.toolName}:${input.planSummary ?? ''}`);
    return Promise.resolve({});
  });
  const audit = { recordToolCall } as unknown as AuditService;

  const service = new TerminalPtyService(executor, audit);
  const events: PtyEvent[] = [];
  const listener = (event: PtyEvent): void => {
    events.push(event);
  };
  return {
    service,
    stream,
    order,
    events,
    listener,
    openPty,
    ptyOutput,
    ptyInput,
    ptyResize,
    closePty,
    recordToolCall,
  };
}

function outputOf(events: readonly PtyEvent[]): string {
  return Buffer.concat(
    events.flatMap((e) =>
      e.type === 'out' ? [Buffer.from(e.data, 'base64')] : [],
    ),
  ).toString();
}

describe('TerminalPtyService (Core, terminal interactiva)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('audita la apertura ANTES de abrir en el Executor (fail-closed)', async () => {
    const { service, order, listener } = setup();
    await service.openOrAttach(WORKSPACE, SIZE, listener);
    expect(order.slice(0, 2)).toEqual([
      'audit:openTerminalPty:terminal interactiva: abrir',
      'executor.open',
    ]);
  });

  it('si el audit de la apertura falla, no se abre nada y el workspace queda libre', async () => {
    const { service, openPty, recordToolCall, listener } = setup();
    recordToolCall.mockRejectedValueOnce(new Error('audit caído'));
    await expect(
      service.openOrAttach(WORKSPACE, SIZE, listener),
    ).rejects.toThrow('audit caído');
    expect(openPty).not.toHaveBeenCalled();
    await expect(
      service.openOrAttach(WORKSPACE, SIZE, listener),
    ).resolves.toEqual({ ptyId: PTY_ID, resumed: false });
  });

  it('dos aperturas casi simultáneas abren una sola sesión en el Executor', async () => {
    const { service, openPty, listener } = setup();
    await Promise.allSettled([
      service.openOrAttach(WORKSPACE, SIZE, listener),
      service.openOrAttach(WORKSPACE, SIZE, listener),
    ]);
    expect(openPty).toHaveBeenCalledTimes(1);
  });

  it('reparte la salida al suscriptor tal cual (base64)', async () => {
    const { service, stream, events, listener } = setup();
    await service.openOrAttach(WORKSPACE, SIZE, listener);
    stream.push({ t: 'out', d: b64('hola') });
    await flush();
    expect(events).toContainEqual({ type: 'out', data: b64('hola') });
  });

  it('abrir de nuevo el mismo workspace se engancha a la sesión viva y repite la salida guardada', async () => {
    const { service, stream, openPty, listener } = setup();
    await service.openOrAttach(WORKSPACE, SIZE, listener);
    stream.push({ t: 'out', d: b64('linea 1\r\n') });
    stream.push({ t: 'out', d: b64('linea 2\r\n') });
    await flush();

    service.detach(PTY_ID, listener);
    const second: PtyEvent[] = [];
    const result = await service.openOrAttach(WORKSPACE, SIZE, (e) =>
      second.push(e),
    );

    expect(result).toEqual({ ptyId: PTY_ID, resumed: true });
    expect(openPty).toHaveBeenCalledTimes(1);
    expect(outputOf(second)).toBe('linea 1\r\nlinea 2\r\n');
  });

  it('la salida guardada tiene tope: conserva lo más reciente', async () => {
    const { service, stream, listener } = setup();
    await service.openOrAttach(WORKSPACE, SIZE, listener);
    const chunk = 'x'.repeat(100 * 1024);
    for (let i = 0; i < 6; i += 1) {
      stream.push({ t: 'out', d: b64(`${i}${chunk}`) });
    }
    await flush();

    service.detach(PTY_ID, listener);
    const replay: PtyEvent[] = [];
    await service.openOrAttach(WORKSPACE, SIZE, (e) => replay.push(e));
    const joined = outputOf(replay);

    expect(joined.length).toBeLessThanOrEqual(256 * 1024 + 100 * 1024);
    expect(joined.startsWith('0')).toBe(false);
    expect(joined).toContain(`5${chunk}`);
  });

  describe('audit de lo que se teclea', () => {
    it('las teclas sueltas pasan sin auditar; la línea se audita ANTES de reenviar su Enter', async () => {
      const { service, order, listener } = setup();
      await service.openOrAttach(WORKSPACE, SIZE, listener);
      order.length = 0;

      service.input(PTY_ID, Buffer.from('npm create vite'));
      service.input(PTY_ID, Buffer.from('@latest\r'));
      await flush();

      expect(order).toEqual([
        'input:"npm create vite"',
        'audit:runTerminalCommand:terminal (interactiva): npm create vite@latest',
        'input:"@latest\\r"',
      ]);
    });

    it('si el audit falla, el Enter NO llega al shell, se cancela la línea (Ctrl+C) y se avisa', async () => {
      const { service, order, events, listener, recordToolCall } = setup();
      await service.openOrAttach(WORKSPACE, SIZE, listener);
      order.length = 0;
      recordToolCall.mockRejectedValueOnce(new Error('audit caído'));

      service.input(PTY_ID, Buffer.from('rm -rf x\r'));
      await flush();

      expect(order).toEqual(['input:"\\u0003"']);
      expect(events).toContainEqual({
        type: 'notice',
        message:
          'No se pudo registrar esa línea en el audit: no se envió al terminal.',
      });

      // La siguiente línea, con el audit sano, sí sale (la anterior no quedó a medias).
      order.length = 0;
      service.input(PTY_ID, Buffer.from('ls\r'));
      await flush();
      expect(order).toEqual([
        'audit:runTerminalCommand:terminal (interactiva): ls',
        'input:"ls\\r"',
      ]);
    });

    it('un pegado con varias líneas audita cada una antes de su Enter, en orden', async () => {
      const { service, order, listener } = setup();
      await service.openOrAttach(WORKSPACE, SIZE, listener);
      order.length = 0;

      service.input(PTY_ID, Buffer.from('cd app\nnpm i\n'));
      await flush();

      expect(order).toEqual([
        'audit:runTerminalCommand:terminal (interactiva): cd app',
        'input:"cd app\\n"',
        'audit:runTerminalCommand:terminal (interactiva): npm i',
        'input:"npm i\\n"',
      ]);
    });

    it('mensajes seguidos mantienen el orden aunque el audit tarde', async () => {
      const { service, order, listener, recordToolCall } = setup();
      await service.openOrAttach(WORKSPACE, SIZE, listener);
      order.length = 0;
      recordToolCall.mockImplementationOnce(
        (input: AuditInput) =>
          new Promise((resolve) =>
            setTimeout(() => {
              order.push(`audit:${input.toolName}:${input.planSummary ?? ''}`);
              resolve({});
            }, 30),
          ),
      );

      service.input(PTY_ID, Buffer.from('ls\r'));
      service.input(PTY_ID, Buffer.from('pwd\r'));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(order).toEqual([
        'audit:runTerminalCommand:terminal (interactiva): ls',
        'input:"ls\\r"',
        'audit:runTerminalCommand:terminal (interactiva): pwd',
        'input:"pwd\\r"',
      ]);
    });

    it('descarta la entrada que pasa el tope por segundo y avisa', async () => {
      const { service, events, ptyInput, listener } = setup();
      await service.openOrAttach(WORKSPACE, SIZE, listener);

      service.input(PTY_ID, Buffer.alloc(400 * 1024, 0x61));
      service.input(PTY_ID, Buffer.alloc(400 * 1024, 0x61));
      await flush();

      expect(events).toContainEqual({
        type: 'notice',
        message: 'Demasiada entrada de golpe: se descartó lo último.',
      });
      const forwarded = ptyInput.mock.calls.reduce(
        (sum, call) => sum + call[2].length,
        0,
      );
      expect(forwarded).toBe(400 * 1024);
    });
  });

  it('el resize llega al Executor', async () => {
    const { service, ptyResize, listener } = setup();
    await service.openOrAttach(WORKSPACE, SIZE, listener);
    await service.resize(PTY_ID, { cols: 100, rows: 40 });
    expect(ptyResize).toHaveBeenCalledWith(WORKSPACE, PTY_ID, {
      cols: 100,
      rows: 40,
    });
  });

  it('el exit del shell llega a la app, se audita el cierre y el workspace queda libre', async () => {
    const { service, stream, events, order, listener, openPty } = setup();
    await service.openOrAttach(WORKSPACE, SIZE, listener);
    stream.push({ t: 'exit', code: 0 });
    await flush();

    expect(events.at(-1)).toEqual({ type: 'exit', code: 0 });
    expect(
      order.some((line) => line.startsWith('audit:closeTerminalPty')),
    ).toBe(true);

    await service.openOrAttach(WORKSPACE, SIZE, listener);
    expect(openPty).toHaveBeenCalledTimes(2);
  });

  it('si el Executor dice que la terminal ya no existe (404), termina con un error claro', async () => {
    const { service, ptyOutput, events, listener } = setup();
    ptyOutput.mockRejectedValueOnce(
      new TerminalUpstreamError(404, 'no existe'),
    );
    await service.openOrAttach(WORKSPACE, SIZE, listener);
    await flush();
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'La terminal ya no existe en el servidor.',
    });
  });

  it('close cierra en el Executor, avisa y audita el cierre', async () => {
    const { service, order, events, listener, recordToolCall } = setup();
    await service.openOrAttach(WORKSPACE, SIZE, listener);

    await service.close(PTY_ID);

    expect(order).toContain('executor.close');
    expect(events.at(-1)).toEqual({ type: 'exit', code: -1 });
    const closeCall = recordToolCall.mock.calls.find(
      ([input]) => input.toolName === 'closeTerminalPty',
    );
    expect(closeCall?.[0].planSummary).toContain('cerrada por el owner');
  });

  it('sin app conectada la sesión sigue 1 h por defecto y luego se cierra sola; reconectar la salva', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { service, closePty, listener } = setup();
    await service.openOrAttach(WORKSPACE, SIZE, listener);

    service.detach(PTY_ID, listener);
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(closePty).not.toHaveBeenCalled();

    // La app vuelve a los 59 min: se engancha y el reloj se cancela.
    await service.openOrAttach(WORKSPACE, SIZE, listener);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(closePty).not.toHaveBeenCalled();

    // Se va otra vez y esta vez no vuelve.
    service.detach(PTY_ID, listener);
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 1000);
    expect(closePty).toHaveBeenCalledTimes(1);
  });

  it('respeta el tiempo que elige el owner y lo acota a 5 min–4 h', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const short = setup();
    await short.service.openOrAttach(
      WORKSPACE,
      SIZE,
      short.listener,
      30 * 60_000,
    );
    short.service.detach(PTY_ID, short.listener);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(short.closePty).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(short.closePty).toHaveBeenCalledTimes(1);

    // Absurdo hacia abajo: el mínimo es 5 min.
    const tiny = setup();
    await tiny.service.openOrAttach(WORKSPACE, SIZE, tiny.listener, 1000);
    tiny.service.detach(PTY_ID, tiny.listener);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(tiny.closePty).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(tiny.closePty).toHaveBeenCalledTimes(1);

    // Absurdo hacia arriba: el máximo es 4 h.
    const huge = setup();
    await huge.service.openOrAttach(
      WORKSPACE,
      SIZE,
      huge.listener,
      99 * 60 * 60_000,
    );
    huge.service.detach(PTY_ID, huge.listener);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000 + 1000);
    expect(huge.closePty).toHaveBeenCalledTimes(1);
  });

  it('al reengancharse con otro tiempo, el nuevo vale para la próxima espera', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { service, closePty, listener } = setup();
    await service.openOrAttach(WORKSPACE, SIZE, listener, 10 * 60_000);
    service.detach(PTY_ID, listener);
    await service.openOrAttach(WORKSPACE, SIZE, listener, 2 * 60 * 60_000);
    service.detach(PTY_ID, listener);

    await vi.advanceTimersByTimeAsync(119 * 60_000);
    expect(closePty).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(closePty).toHaveBeenCalledTimes(1);
  });

  it('la espera es de silencio: mientras la sesión sigue escribiendo sola no se corta', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { service, stream, closePty, listener } = setup();
    await service.openOrAttach(WORKSPACE, SIZE, listener, 10 * 60_000);
    service.detach(PTY_ID, listener);

    // Claude Code trabajando 40 min con el teléfono bloqueado: una línea cada 5 min.
    for (let minute = 5; minute <= 40; minute += 5) {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      stream.push({
        t: 'out',
        d: Buffer.from('trabajando\n').toString('base64'),
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(closePty).not.toHaveBeenCalled();

    // Se calla: 10 min de silencio y se cierra.
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1000);
    expect(closePty).toHaveBeenCalledTimes(1);
  });

  it('un suscriptor viejo no puede soltar al nuevo (detach solo vale para el actual)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { service, closePty, listener } = setup();
    await service.openOrAttach(WORKSPACE, SIZE, listener);
    const newer = vi.fn();
    await service.openOrAttach(WORKSPACE, SIZE, newer);

    service.detach(PTY_ID, listener);
    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(closePty).not.toHaveBeenCalled();
  });
});
