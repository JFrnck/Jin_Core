import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { z } from 'zod';
import { extractWsToken } from '../auth/ws-token';
import { JinError } from '../common/errors/jin-error';
import {
  TerminalPtyService,
  type PtyEvent,
  type PtyListener,
} from './terminal-pty.service';

const SizeSchema = z.object({
  cols: z.number().int().min(20).max(300),
  rows: z.number().int().min(5).max(100),
});
const OpenSchema = SizeSchema.extend({ workspaceId: z.string().uuid() });
/** 64 KB de teclado en base64; lo que pase de eso la app lo parte. */
const InputSchema = z.object({
  data: z
    .string()
    .min(1)
    .max(88 * 1024)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'base64 inválido'),
});

interface PtyClientData {
  ptyId?: string | undefined;
  listener?: PtyListener | undefined;
}

function dataOf(client: Socket): PtyClientData {
  return client.data as PtyClientData;
}

/**
 * Terminal interactiva (PTY) hacia la app, por socket.io en el namespace
 * `/terminal` (2026-09-29). Misma auth que `/chat`: JWT del owner en el
 * handshake. Una terminal por conexión; si la conexión se cae, la sesión sigue
 * viva `PTY_DETACH_GRACE_MS` y la app se reengancha con `pty:open` (devuelve
 * lo que salió mientras no estaba).
 *
 * cliente → servidor: `pty:open {workspaceId, cols, rows}`, `pty:input {data}`,
 * `pty:resize {cols, rows}`, `pty:close`.
 * servidor → cliente: `pty:opened {ptyId, resumed}`, `pty:output {data}`,
 * `pty:exit {code}`, `pty:notice {message}`, `pty:error {message}`.
 * `data` va siempre en base64 (bytes crudos del terminal).
 */
@WebSocketGateway({ namespace: '/terminal' })
export class TerminalGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(TerminalGateway.name);

  constructor(
    private readonly pty: TerminalPtyService,
    private readonly jwtService: JwtService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = extractWsToken(client);
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      await this.jwtService.verifyAsync(token);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    const { ptyId, listener } = dataOf(client);
    if (ptyId && listener) this.pty.detach(ptyId, listener);
  }

  @SubscribeMessage('pty:open')
  async open(
    @MessageBody() payload: unknown,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const parsed = OpenSchema.safeParse(payload);
    if (!parsed.success) {
      client.emit('pty:error', { message: 'Pedido de terminal inválido.' });
      return;
    }
    // La app sale de la pantalla sin cerrar la sesión y vuelve por la MISMA
    // conexión: se suelta la suscripción anterior (empieza su gracia de 10 min)
    // y `openOrAttach` se reengancha a la sesión viva, cancelando esa gracia.
    const previous = dataOf(client);
    if (previous.ptyId && previous.listener) {
      this.pty.detach(previous.ptyId, previous.listener);
    }
    previous.ptyId = undefined;
    previous.listener = undefined;

    // La salida guardada se entrega dentro de `openOrAttach`, antes de que la app
    // sepa el `ptyId`: se encola y se suelta justo después de `pty:opened`.
    let ready = false;
    const queued: PtyEvent[] = [];
    const listener: PtyListener = (event) => {
      if (!ready) queued.push(event);
      else this.forward(client, event);
    };

    try {
      const { ptyId, resumed } = await this.pty.openOrAttach(
        parsed.data.workspaceId,
        { cols: parsed.data.cols, rows: parsed.data.rows },
        listener,
      );
      dataOf(client).ptyId = ptyId;
      dataOf(client).listener = listener;
      client.emit('pty:opened', { ptyId, resumed });
      ready = true;
      for (const event of queued) this.forward(client, event);
    } catch (error) {
      client.emit('pty:error', { message: this.messageOf(error) });
    }
  }

  @SubscribeMessage('pty:input')
  input(
    @MessageBody() payload: unknown,
    @ConnectedSocket() client: Socket,
  ): void {
    const parsed = InputSchema.safeParse(payload);
    const { ptyId } = dataOf(client);
    if (!parsed.success || !ptyId) return;
    try {
      this.pty.input(ptyId, Buffer.from(parsed.data.data, 'base64'));
    } catch (error) {
      client.emit('pty:error', { message: this.messageOf(error) });
    }
  }

  @SubscribeMessage('pty:resize')
  async resize(
    @MessageBody() payload: unknown,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const parsed = SizeSchema.safeParse(payload);
    const { ptyId } = dataOf(client);
    if (!parsed.success || !ptyId) return;
    try {
      await this.pty.resize(ptyId, parsed.data);
    } catch (error) {
      this.logger.warn(`resize: ${this.messageOf(error)}`);
    }
  }

  @SubscribeMessage('pty:close')
  async close(@ConnectedSocket() client: Socket): Promise<void> {
    const { ptyId } = dataOf(client);
    if (!ptyId) return;
    dataOf(client).ptyId = undefined;
    await this.pty.close(ptyId);
  }

  private forward(client: Socket, event: PtyEvent): void {
    switch (event.type) {
      case 'out':
        client.emit('pty:output', { data: event.data });
        break;
      case 'exit':
        client.emit('pty:exit', { code: event.code });
        break;
      case 'notice':
        client.emit('pty:notice', { message: event.message });
        break;
      case 'error':
        client.emit('pty:error', { message: event.message });
        break;
    }
  }

  private messageOf(error: unknown): string {
    // Los errores de dominio ya traen un mensaje pensado para el owner.
    if (error instanceof JinError) return error.message;
    this.logger.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return 'Falló la terminal.';
  }
}
