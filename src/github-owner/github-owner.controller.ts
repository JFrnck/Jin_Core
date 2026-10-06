import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import {
  BranchesDto,
  CheckoutBodyDto,
  CheckoutResultDto,
  CloneBodyDto,
  CloneResultDto,
  DirQueryDto,
  PullBodyDto,
  PullResultDto,
  PushBodyDto,
  PushOutcomeDto,
  PushOutcomeSchema,
  RepoListDto,
  RepoStatusDto,
} from './github.schemas';
import { OwnerGithubService } from './owner-github.service';

/**
 * GitHub desde la app (ADR 0022): repos clonados en el disco de un proyecto (`:workspaceId` = id del
 * proyecto, como en `/api/terminal/workspaces`). Subir cambios deja una aprobación; lo demás es del owner.
 */
@ApiTags('github')
@Controller('api/github')
export class GithubOwnerController {
  constructor(private readonly github: OwnerGithubService) {}

  @Get('repos')
  @ApiOperation({ summary: 'Repos donde está instalada la GitHub App' })
  @ZodResponse({ status: 200, type: RepoListDto })
  async repos() {
    return { repos: [...(await this.github.repos())] };
  }

  @Post('workspaces/:workspaceId/clone')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clona un repo en una carpeta vacía del proyecto' })
  @ZodResponse({ status: 200, type: CloneResultDto })
  clone(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() body: CloneBodyDto,
  ) {
    return this.github.clone(workspaceId, body);
  }

  @Get('workspaces/:workspaceId/status')
  @ApiOperation({ summary: 'Rama, commit y archivos cambiados' })
  @ZodResponse({ status: 200, type: RepoStatusDto })
  async status(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Query() query: DirQueryDto,
  ) {
    const status = await this.github.status(workspaceId, query.dir);
    return { ...status, changed: [...status.changed] };
  }

  @Get('workspaces/:workspaceId/branches')
  @ApiOperation({ summary: 'Ramas locales y remotas' })
  @ZodResponse({ status: 200, type: BranchesDto })
  async branches(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Query() query: DirQueryDto,
  ) {
    const branches = await this.github.branches(workspaceId, query.dir);
    return {
      current: branches.current,
      local: [...branches.local],
      remote: [...branches.remote],
    };
  }

  @Post('workspaces/:workspaceId/checkout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cambia (o crea) una rama' })
  @ZodResponse({ status: 200, type: CheckoutResultDto })
  checkout(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() body: CheckoutBodyDto,
  ) {
    return this.github.checkout(workspaceId, body);
  }

  @Post('workspaces/:workspaceId/pull')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Actualiza la rama actual (solo avance rápido)' })
  @ZodResponse({ status: 200, type: PullResultDto })
  pull(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() body: PullBodyDto,
  ) {
    return this.github.pull(workspaceId, body);
  }

  @Post('workspaces/:workspaceId/push')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Pide subir los cambios a una rama nueva (nunca main): queda una aprobación pendiente',
  })
  @ZodResponse({ status: 200, type: PushOutcomeDto })
  push(
    @Param('workspaceId', new ParseUUIDPipe()) workspaceId: string,
    @Body() body: PushBodyDto,
  ): Promise<z.infer<typeof PushOutcomeSchema>> {
    return this.github.requestPush(workspaceId, body);
  }
}
