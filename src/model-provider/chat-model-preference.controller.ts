import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { ChatModelPreferenceService } from './chat-model-preference.service';

// Sistema single-user (BLUEPRINT 5.2): mismo `actor` que ya usan
// AutonomyController/Telegram para acciones autenticadas del owner.
const REQUESTED_BY = 'owner:api';

const VendorSchema = z.enum(['anthropic', 'google', 'openai']);
const EffortSchema = z.enum(['low', 'medium', 'high']);

const ChatModelOptionSchema = z.object({
  vendor: VendorSchema,
  modelId: z.string(),
  label: z.string(),
  supportsEffort: z.boolean(),
});

const ChatModelPreferenceSchema = z.object({
  vendor: VendorSchema,
  modelId: z.string(),
  effort: EffortSchema.nullable(),
  setBy: z.string(),
  changedAt: z.string(),
});

const ChatModelStatusSchema = z.object({
  catalog: z.array(ChatModelOptionSchema),
  // null = sin preferencia: se usa el `primary` de config/models.yaml.
  preference: ChatModelPreferenceSchema.nullable(),
});
class ChatModelStatusDto extends createZodDto(ChatModelStatusSchema) {}

const SetPreferenceBodySchema = z.object({
  vendor: VendorSchema,
  modelId: z.string().min(1),
  // Ausente o null: sin esfuerzo explícito (el provider usa su propio
  // default). Se descarta igual si el modelo elegido no soporta esfuerzo.
  effort: EffortSchema.nullable().optional(),
});
class SetPreferenceDto extends createZodDto(SetPreferenceBodySchema) {}

/**
 * Preferencia de modelo del owner para el chat (2026-09-28). Protegido por
 * el `JwtAuthGuard` global: solo el owner autenticado, igual que
 * `AutonomyController`. El LLM no tiene ninguna tool que llegue acá — es
 * la app la que llama, no el modelo eligiéndose a sí mismo.
 */
@ApiTags('model-provider')
@Controller('api/model-provider/chat-preference')
export class ChatModelPreferenceController {
  constructor(private readonly service: ChatModelPreferenceService) {}

  @Get()
  @ApiOperation({
    summary:
      'Catálogo de modelos elegibles y la preferencia vigente para el chat',
  })
  @ZodResponse({ status: 200, type: ChatModelStatusDto })
  async getStatus(): Promise<z.infer<typeof ChatModelStatusSchema>> {
    // Refresca el caché acá (no en el arranque del módulo, ver el
    // comentario del service): la app llama este GET en cada
    // `refreshAll()`, así que el caché del router nunca queda viejo por mucho.
    await this.service.refresh();
    return this.describe();
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Fija el vendor/modelo/esfuerzo del chat. El mismo modelo decide qué tools correr en el turno (crear pods, terminal) — no es solo "cómo contesta".',
  })
  @ZodResponse({ status: 200, type: ChatModelStatusDto })
  async setPreference(
    @Body() body: SetPreferenceDto,
  ): Promise<z.infer<typeof ChatModelStatusSchema>> {
    await this.service.setPreference(
      {
        vendor: body.vendor,
        modelId: body.modelId,
        effort: body.effort ?? null,
      },
      REQUESTED_BY,
    );
    return this.describe();
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Borra la preferencia: el chat vuelve al modelo default de config/models.yaml',
  })
  @ZodResponse({ status: 200, type: ChatModelStatusDto })
  async clearPreference(): Promise<z.infer<typeof ChatModelStatusSchema>> {
    await this.service.clearPreference(REQUESTED_BY);
    return this.describe();
  }

  private describe(): z.infer<typeof ChatModelStatusSchema> {
    return {
      catalog: [...this.service.listCatalog()],
      preference: this.service.getPreference(),
    };
  }
}
