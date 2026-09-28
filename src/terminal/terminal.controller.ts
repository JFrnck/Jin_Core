import {
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
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { OkResultDto } from '../common/dto/ok-result.dto';
import { OwnerTerminalService } from './owner-terminal.service';
import {
  ExecTerminalDto,
  ExportTerminalQueryDto,
  ExposeTerminalDto,
  ImportTerminalDto,
  StartTerminalDto,
  TerminalExportDto,
  TerminalImportResultDto,
  TerminalPendingDto,
  TerminalSessionDto,
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
