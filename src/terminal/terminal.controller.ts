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
  FsDeleteQueryDto,
  FsListQueryDto,
  FsMkdirDto,
  FsReadQueryDto,
  FsWriteDto,
  ImportTerminalDto,
  StartServiceDto,
  StartTerminalDto,
  TerminalServiceInfoDto,
  TerminalServiceLogsDto,
  TerminalServiceStartDto,
  TerminalExportDto,
  TerminalFsFileDto,
  TerminalFsListDto,
  TerminalFsWrittenDto,
  TerminalImportResultDto,
  TerminalPendingDto,
  TerminalWorkspaceDto,
  WorkspaceIdSchema,
  type TerminalServiceInfoSchema,
  type TerminalServiceStartSchema,
  type TerminalWorkspaceSchema,
} from './terminal.schemas';

/**
 * Terminal del owner (ADR 0016 ampliada). El modelo no pasa por acá: es la
 * app la que llama, con el JWT del owner. `:workspaceId` es el id del
 * proyecto en la app (el mismo `CodeProject.id` que nombra su disco en el
 * Executor).
 */
@ApiTags('terminal')
@Controller('api/terminal/workspaces')
export class TerminalController {
  constructor(private readonly terminal: OwnerTerminalService) {}

  @Get()
  @ApiOperation({
    summary: 'Todos tus proyectos con disco propio, corriendo o no',
  })
  @ZodResponse({ status: 200, type: [TerminalWorkspaceDto] })
  async list(): Promise<z.infer<typeof TerminalWorkspaceSchema>[]> {
    return [...(await this.terminal.list())];
  }

  @Post(':workspaceId/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Pide abrir (o reanudar) la terminal de un proyecto. Siempre queda esperando tu aprobación (nivel confirm fijo).',
  })
  @ZodResponse({ status: 200, type: TerminalPendingDto })
  async start(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body() body: StartTerminalDto,
  ): Promise<{ status: 'pending-approval'; requestId: string }> {
    return this.terminal.requestStart(
      this.workspaceIdOrFail(rawWorkspaceId),
      body,
    );
  }

  @Delete(':workspaceId/pod')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Detiene el pod del proyecto (el disco se conserva)',
  })
  @ZodResponse({ status: 200, type: OkResultDto })
  async stopPod(
    @Param('workspaceId') rawWorkspaceId: string,
  ): Promise<{ ok: true }> {
    await this.terminal.stopPod(this.workspaceIdOrFail(rawWorkspaceId));
    return { ok: true };
  }

  @Delete(':workspaceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Borra el pod (si lo hay) Y el disco del proyecto. Irreversible.',
  })
  @ZodResponse({ status: 200, type: OkResultDto })
  async deleteWorkspace(
    @Param('workspaceId') rawWorkspaceId: string,
  ): Promise<{ ok: true }> {
    await this.terminal.deleteWorkspace(this.workspaceIdOrFail(rawWorkspaceId));
    return { ok: true };
  }

  /**
   * Corre un comando dentro del workspace. La respuesta es un stream NDJSON
   * (`application/x-ndjson`): una línea JSON por evento — `{"t":"out","d":"…"}`,
   * `{"t":"err","d":"…"}` — y una última `{"t":"exit","code":0,"truncated":false}`
   * o `{"t":"error","message":"…"}`. Cada comando queda en el audit.
   */
  @Post(':workspaceId/exec')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ejecuta un comando en el proyecto (salida en streaming NDJSON)',
  })
  @ApiProduces('application/x-ndjson')
  async exec(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body() body: ExecTerminalDto,
    @Res() res: Response,
  ): Promise<void> {
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    // Cualquier error anterior al primer byte (audit, 404, 409) sale como HTTP normal.
    const upstream = await this.terminal.exec(
      this.workspaceIdOrFail(rawWorkspaceId),
      body,
      controller.signal,
    );

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

  @Get(':workspaceId/files')
  @ApiOperation({
    summary:
      'Archivos de texto del proyecto (sin node_modules, .git ni dist), para traerlos al editor',
  })
  @ZodResponse({ status: 200, type: TerminalExportDto })
  async exportFiles(
    @Param('workspaceId') rawWorkspaceId: string,
    @Query() query: ExportTerminalQueryDto,
  ): Promise<{
    files: Record<string, string>;
    skipped: { path: string; reason: string }[];
  }> {
    const result = await this.terminal.exportFiles(
      this.workspaceIdOrFail(rawWorkspaceId),
      query.dir,
    );
    return { files: { ...result.files }, skipped: [...result.skipped] };
  }

  @Put(':workspaceId/files')
  @ApiOperation({
    summary: 'Copia archivos del editor al espacio de trabajo del proyecto',
  })
  @ZodResponse({ status: 200, type: TerminalImportResultDto })
  async importFiles(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body() body: ImportTerminalDto,
  ): Promise<{ written: number }> {
    return this.terminal.importFiles(
      this.workspaceIdOrFail(rawWorkspaceId),
      body.files,
    );
  }

  // ── Explorador de archivos del pod ─────────────────────────────────────

  @Get(':workspaceId/fs/list')
  @ApiOperation({ summary: 'Lista una carpeta del disco del proyecto' })
  @ZodResponse({ status: 200, type: TerminalFsListDto })
  async fsList(
    @Param('workspaceId') rawWorkspaceId: string,
    @Query() query: FsListQueryDto,
  ) {
    const result = await this.terminal.fsList(
      this.workspaceIdOrFail(rawWorkspaceId),
      query.path,
    );
    return { entries: [...result.entries], truncated: result.truncated };
  }

  @Get(':workspaceId/fs/file')
  @ApiOperation({
    summary: 'Lee un archivo de texto del proyecto (UTF-8, hasta 512 KB)',
  })
  @ZodResponse({ status: 200, type: TerminalFsFileDto })
  fsRead(
    @Param('workspaceId') rawWorkspaceId: string,
    @Query() query: FsReadQueryDto,
  ) {
    return this.terminal.fsRead(
      this.workspaceIdOrFail(rawWorkspaceId),
      query.path,
    );
  }

  @Put(':workspaceId/fs/file')
  @ApiOperation({
    summary:
      'Guarda un archivo de texto en el disco del proyecto. Con expectedSha256, 409 (TERMINAL_FS_CONFLICT) si cambió en el pod. Queda en el audit',
  })
  @ZodResponse({ status: 200, type: TerminalFsWrittenDto })
  fsWrite(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body() body: FsWriteDto,
  ) {
    return this.terminal.fsWrite(this.workspaceIdOrFail(rawWorkspaceId), body);
  }

  @Post(':workspaceId/fs/dir')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Crea una carpeta en el proyecto. Queda en el audit',
  })
  @ZodResponse({ status: 200, type: OkResultDto })
  async fsMkdir(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body() body: FsMkdirDto,
  ): Promise<{ ok: true }> {
    await this.terminal.fsMkdir(
      this.workspaceIdOrFail(rawWorkspaceId),
      body.path,
    );
    return { ok: true };
  }

  @Delete(':workspaceId/fs/entry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Borra un archivo o una carpeta vacía del proyecto (no recursivo). Queda en el audit',
  })
  @ZodResponse({ status: 200, type: OkResultDto })
  async fsDelete(
    @Param('workspaceId') rawWorkspaceId: string,
    @Query() query: FsDeleteQueryDto,
  ): Promise<{ ok: true }> {
    await this.terminal.fsDelete(
      this.workspaceIdOrFail(rawWorkspaceId),
      query.path,
    );
    return { ok: true };
  }

  // ── Servidores en segundo plano y vista previa en vivo ─────────────────

  @Post(':workspaceId/services')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Lanza un servidor dentro del proyecto (npm run dev…) y espera a que el puerto responda. Queda en el audit.',
  })
  @ZodResponse({ status: 200, type: TerminalServiceStartDto })
  async startService(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body() body: StartServiceDto,
  ): Promise<z.infer<typeof TerminalServiceStartSchema>> {
    const result = await this.terminal.startService(
      this.workspaceIdOrFail(rawWorkspaceId),
      body,
    );
    return {
      status: result.status,
      port: result.port,
      log: result.log,
      ...(result.status === 'exited' ? { code: result.code } : {}),
    };
  }

  @Get(':workspaceId/services')
  @ApiOperation({ summary: 'Servidores en segundo plano del proyecto' })
  @ZodResponse({ status: 200, type: [TerminalServiceInfoDto] })
  async listServices(
    @Param('workspaceId') rawWorkspaceId: string,
  ): Promise<z.infer<typeof TerminalServiceInfoSchema>[]> {
    return [
      ...(await this.terminal.listServices(
        this.workspaceIdOrFail(rawWorkspaceId),
      )),
    ];
  }

  @Delete(':workspaceId/services/:port')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Detiene un servidor del proyecto' })
  @ZodResponse({ status: 200, type: OkResultDto })
  async stopService(
    @Param('workspaceId') rawWorkspaceId: string,
    @Param('port') rawPort: string,
  ): Promise<{ ok: true }> {
    await this.terminal.stopService(
      this.workspaceIdOrFail(rawWorkspaceId),
      this.portOrFail(rawPort),
    );
    return { ok: true };
  }

  @Get(':workspaceId/services/:port/logs')
  @ApiOperation({ summary: 'Últimas líneas de la salida de un servidor' })
  @ZodResponse({ status: 200, type: TerminalServiceLogsDto })
  async serviceLogs(
    @Param('workspaceId') rawWorkspaceId: string,
    @Param('port') rawPort: string,
  ): Promise<{ log: string }> {
    return {
      log: await this.terminal.serviceLogs(
        this.workspaceIdOrFail(rawWorkspaceId),
        this.portOrFail(rawPort),
      ),
    };
  }

  /**
   * Vista previa en vivo: reenvía la petición al puerto de un servidor del
   * proyecto. Privada: exige el JWT del owner (la app lo agrega a cada
   * petición de la vista web). No es un link público y no expone nada afuera.
   */
  @All([':workspaceId/preview/:port', ':workspaceId/preview/:port/*rest'])
  @SkipThrottle()
  @ApiOperation({
    summary:
      'Proxy HTTP privado a un puerto del proyecto (vista previa en vivo), con el JWT del owner',
  })
  async preview(
    @Param('workspaceId') rawWorkspaceId: string,
    @Param('port') rawPort: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const workspaceId = this.workspaceIdOrFail(rawWorkspaceId);
    const port = this.portOrFail(rawPort);
    const prefix = `/api/terminal/workspaces/${encodeURIComponent(rawWorkspaceId)}/preview/${rawPort}`;
    const rest = req.originalUrl.startsWith(prefix)
      ? req.originalUrl.slice(prefix.length)
      : '';
    const pathAndQuery =
      rest === '' || rest.startsWith('?') ? `/${rest}` : rest;

    const controller = new AbortController();
    res.on('close', () => controller.abort());

    const upstream = await this.terminal.previewRequest(workspaceId, port, {
      method: req.method,
      pathAndQuery,
      headers: previewRequestHeaders(req),
      body: await previewRequestBody(req),
      signal: controller.signal,
    });

    res.status(upstream.status);
    // Le dice a la app que esta respuesta es del servidor del owner: un 404 sin la
    // marca es un fallo de Jin (workspace, puerto), no de su app.
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

  /** Valida y normaliza el id de proyecto ANTES de que llegue al Executor. */
  private workspaceIdOrFail(raw: string): string {
    const result = WorkspaceIdSchema.safeParse(raw);
    if (!result.success)
      throw new BadRequestException('Id de proyecto inválido.');
    return result.data;
  }

  @Post(':workspaceId/expose')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Pide publicar el build del proyecto bajo https://<slug>.jinserver.com. Siempre queda esperando tu aprobación.',
  })
  @ZodResponse({ status: 200, type: TerminalPendingDto })
  async expose(
    @Param('workspaceId') rawWorkspaceId: string,
    @Body() body: ExposeTerminalDto,
  ): Promise<{ status: 'pending-approval'; requestId: string }> {
    return this.terminal.requestExpose(
      this.workspaceIdOrFail(rawWorkspaceId),
      body,
    );
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
