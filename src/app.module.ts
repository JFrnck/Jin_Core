import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ZodSerializerInterceptor, ZodValidationPipe } from 'nestjs-zod';
import { AgentModule } from './agent/agent.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AutonomyModule } from './autonomy/autonomy.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { BudgetModule } from './budget/budget.module';
import { ChatModule } from './chat/chat.module';
import { JinErrorFilter } from './common/filters/jin-error.filter';
import { ConfigModule } from './config';
import { CorpusModule } from './corpus/corpus.module';
import { DbModule } from './db/db.module';
import { ExecutorClientModule } from './executor-client/executor-client.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { HealthModule } from './health/health.module';
import { HitlModule } from './hitl/hitl.module';
import { HitlPolicyModule } from './hitl-policy/hitl-policy.module';
import { CanvasModule } from './integrations/canvas/canvas.module';
import { GoogleModule } from './integrations/google/google.module';
import { McpModule } from './mcp/mcp.module';
import { MemoryModule } from './memory/memory.module';
import { ModelProviderModule } from './model-provider/model-provider.module';
import { OrchestratorModule } from './agent/orchestrator.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RelayModule } from './relay/relay.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    RateLimitModule,
    HealthModule,
    AuditModule,
    HitlModule,
    ModelProviderModule,
    BudgetModule,
    CanvasModule,
    GoogleModule,
    MemoryModule,
    CorpusModule,
    FeatureFlagsModule,
    AutonomyModule,
    HitlPolicyModule,
    McpModule,
    AgentModule,
    OrchestratorModule,
    TelegramModule,
    ExecutorClientModule,
    AuthModule,
    ChatModule,
    RealtimeModule,
    RelayModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Orden real de ejecución: Nest corre los guards `APP_GUARD` en el
    // orden en que se registran acá — Throttler antes que JWT, para que
    // un intento de fuerza bruta contra /api/auth/login se frene por
    // rate limit incluso antes de evaluarse como no autenticado.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: JinErrorFilter },
    // nestjs-zod (Fase 6.1.1): valida request bodies/query/params contra
    // los DTOs `createZodDto(...)` de cada controller, y serializa cada
    // response contra el schema declarado en `@ZodResponse(...)` —
    // reemplaza el `ZodValidationPipe` casero (borrado) y es lo que hace
    // que `contracts/openapi.json` documente algo más que el path/summary
    // (ningún endpoint de Fase 6.1 tenía request/response en el contrato).
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: ZodSerializerInterceptor },
  ],
})
export class AppModule {}
