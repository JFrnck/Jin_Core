import {
  All,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { OkResultDto } from '../common/dto/ok-result.dto';
import { OwnerTerminalService } from './owner-terminal.service';
import {
  ExecTerminalDto,
  ExportTerminalQueryDto,
  ExposeTerminalDto,
  ImportTerminalDto,
  StartServiceDto,
  StartTerminalDto,
  TerminalServiceInfoDto,
  TerminalServiceLogsDto,
  TerminalServiceStartDto,
  TerminalExportDto,
  TerminalImportResultDto,
  TerminalPendingDto,
  TerminalSessionDto,
  type TerminalServiceInfoSchema,
  type TerminalServiceStartSchema,
  type TerminalSessionSchema,
} from './terminal.schemas';

/**
 * Terminal del owner (ADR 0016). El modelo no pasa por acá: es la app la que
 * llama, con el JWT del owner.
 */
@ApiTags('terminal')
@Controller('api/terminal/sessions')
export class TerminalController {
  constructor(private readonly terminal: OwnerTerminalService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Pide abrir una sesión de terminal. Siempre queda esperando tu aprobación (nivel confirm fijo).',
  })
  @ZodResponse({ status: 200, type: TerminalPendingDto })
  async start(
    @Body() body: StartTerminalDto,
  ): Promise<{ status: 'pending-approval'; requestId: string }> {
    return this.terminal.requestSession(body);
  }

  @Get()
  @ApiOperation({
    summary: 'Sesiones de terminal (con el link publicado, si hay)',
  })
  @ZodResponse({ status: 200, type: [TerminalSessionDto] })
  async list(): Promise<z.infer<typeof TerminalSessionSchema>[]> {
    return [...(await this.terminal.list())];
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cierra una sesión y destruye su pod' })
  @ZodResponse({ status: 200, type: OkResultDto })
  async stop(@Param('id') id: string): Promise<{ ok: true }> {
    await this.terminal.stop(id);
    return { ok: true };
  }

  /**
   * Corre un comando dentro de la sesión. La respuesta es un stream NDJSON
   * (`application/x-ndjson`): una línea JSON por evento — `{"t":"out","d":"…"}`,
   * `{"t":"err","d":"…"}` — y una última `{"t":"exit","code":0,"truncated":false}`
   * o `{"t":"error","message":"…"}`. Cada comando queda en el audit.
   */
  @Post(':id/exec')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ejecuta un comando en la sesión (salida en streaming NDJSON)',
  })
  @ApiProduces('application/x-ndjson')
  async exec(
    @Param('id') id: string,
    @Body() body: ExecTerminalDto,
    @Res() res: Response,
  ): Promise<void> {
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    // Cualquier error anterior al primer byte (audit, 404, 409) sale como HTTP normal.
    const upstream = await this.terminal.exec(id, body, controller.signal);

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstream.body?.getReader();
    try {
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        res.write(
          `${JSON.stringify({ t: 'error', message: error instanceof Error ? error.message : 'Se cortó la conexión con la terminal.' })}\n`,
        );
      }
    } finally {
      res.end();
    }
  }

  @Get(':id/files')
  @ApiOperation({
    summary:
      'Archivos de texto de la sesión (sin node_modules, .git ni dist), para traerlos al editor',
  })
  @ZodResponse({ status: 200, type: TerminalExportDto })
  async exportFiles(
    @Param('id') id: string,
    @Query() query: ExportTerminalQueryDto,
  ): Promise<{
    files: Record<string, string>;
    skipped: { path: string; reason: string }[];
  }> {
    const result = await this.terminal.exportFiles(id, query.dir);
    return { files: { ...result.files }, skipped: [...result.skipped] };
  }

  @Put(':id/files')
  @ApiOperation({
    summary: 'Copia archivos del editor al espacio de trabajo de la sesión',
  })
  @ZodResponse({ status: 200, type: TerminalImportResultDto })
  async importFiles(
    @Param('id') id: string,
    @Body() body: ImportTerminalDto,
  ): Promise<{ written: number }> {
    return this.terminal.importFiles(id, body.files);
  }

  // ── Servidores en segundo plano y vista previa en vivo ─────────────────

  @Post(':id/services')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Lanza un servidor dentro de la sesión (npm run dev…) y espera a que el puerto responda. Queda en el audit.',
  })
  @ZodResponse({ status: 200, type: TerminalServiceStartDto })
  async startService(
    @Param('id') id: string,
    @Body() body: StartServiceDto,
  ): Promise<z.infer<typeof TerminalServiceStartSchema>> {
    const result = await this.terminal.startService(id, body);
    return {
      status: result.status,
      port: result.port,
      log: result.log,
      ...(result.status === 'exited' ? { code: result.code } : {}),
    };
  }

  @Get(':id/services')
  @ApiOperation({ summary: 'Servidores en segundo plano de la sesión' })
  @ZodResponse({ status: 200, type: [TerminalServiceInfoDto] })
  async listServices(
    @Param('id') id: string,
  ): Promise<z.infer<typeof TerminalServiceInfoSchema>[]> {
    return [...(await this.terminal.listServices(id))];
  }

  @Delete(':id/services/:port')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Detiene un servidor de la sesión' })
  @ZodResponse({ status: 200, type: OkResultDto })
  async stopService(
    @Param('id') id: string,
    @Param('port') rawPort: string,
  ): Promise<{ ok: true }> {
    await this.terminal.stopService(id, this.portOrFail(rawPort));
    return { ok: true };
  }

  @Get(':id/services/:port/logs')
  @ApiOperation({ summary: 'Últimas líneas de la salida de un servidor' })
  @ZodResponse({ status: 200, type: TerminalServiceLogsDto })
  async serviceLogs(
    @Param('id') id: string,
    @Param('port') rawPort: string,
  ): Promise<{ log: string }> {
    return {
      log: await this.terminal.serviceLogs(id, this.portOrFail(rawPort)),
    };
  }

  /**
   * Vista previa en vivo: reenvía la petición al puerto de un servidor de la
   * sesión. Privada: exige el JWT del owner (la app lo agrega a cada petición
   * de la vista web). No es un link público y no expone nada afuera.
   */
  @All([':id/preview/:port', ':id/preview/:port/*rest'])
  @SkipThrottle()
  @ApiOperation({
    summary:
      'Proxy HTTP privado a un puerto de la sesión (vista previa en vivo), con el JWT del owner',
  })
  async preview(
    @Param('id') id: string,
    @Param('port') rawPort: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const port = this.portOrFail(rawPort);
    const prefix = `/api/terminal/sessions/${encodeURIComponent(id)}/preview/${rawPort}`;
    const rest = req.originalUrl.startsWith(prefix)
      ? req.originalUrl.slice(prefix.length)
      : '';
    const pathAndQuery =
      rest === '' || rest.startsWith('?') ? `/${rest}` : rest;

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const upstream = await this.terminal.previewRequest(id, port, {
      method: req.method,
      pathAndQuery,
      headers: previewRequestHeaders(req),
      body: await previewRequestBody(req),
      signal: controller.signal,
    });

    res.status(upstream.status);
    // Le dice a la app que esta respuesta es del servidor del owner: un 404 sin la
    // marca es un fallo de Jin (sesión, puerto), no de su app.
    res.setHeader('x-jin-proxied', '1');
    for (const name of PREVIEW_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) res.setHeader(name, value);
    }
    // La vista previa nunca se cachea en la app ni en el camino.
    res.setHeader('Cache-Control', 'no-store');

    const reader = upstream.body?.getReader();
    try {
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
    } catch {
      // el servidor del owner cortó o el cliente se fue: se cierra tal cual
    } finally {
      res.end();
    }
  }

  private portOrFail(raw: string): number {
    const port = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(port >= 1024 && port <= 65535)) {
      throw new BadRequestException('Puerto no válido (1024–65535).');
    }
    return port;
  }

  @Post(':id/expose')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Pide publicar el build de la sesión bajo https://<slug>.jinserver.com. Siempre queda esperando tu aprobación.',
  })
  @ZodResponse({ status: 200, type: TerminalPendingDto })
  async expose(
    @Param('id') id: string,
    @Body() body: ExposeTerminalDto,
  ): Promise<{ status: 'pending-approval'; requestId: string }> {
    return this.terminal.requestExpose(id, body);
  }
}

/** Cabeceras que se reenvían al servidor: sin cookies, sin Authorization (es el JWT del owner). */
const PREVIEW_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'range',
  'user-agent',
];
/** Cabeceras de la respuesta que llegan a la app (sin set-cookie ni las de conexión). */
const PREVIEW_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'etag',
  'last-modified',
  'location',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'x-content-type-options',
];
const MAX_PREVIEW_BODY_BYTES = 10 * 1024 * 1024;

function previewRequestHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of PREVIEW_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

/** Cuerpo de la petición: el JSON que Nest ya leyó, o el stream crudo (con tope). */
async function previewRequestBody(req: Request): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const parsed: unknown = req.body;
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Object.keys(parsed).length > 0
  ) {
    return Buffer.from(JSON.stringify(parsed));
  }
  if (req.readableEnded) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_PREVIEW_BODY_BYTES) {
      throw new BadRequestException('Cuerpo demasiado grande.');
    }
    chunks.push(buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}
