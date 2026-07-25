import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { BudgetModule } from './budget/budget.module';
import { ConfigModule } from './config';
import { DbModule } from './db/db.module';
import { HitlModule } from './hitl/hitl.module';
import { CanvasModule } from './integrations/canvas/canvas.module';
import { GoogleModule } from './integrations/google/google.module';
import { ModelProviderModule } from './model-provider/model-provider.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    ScheduleModule.forRoot(),
    AuditModule,
    HitlModule,
    ModelProviderModule,
    BudgetModule,
    CanvasModule,
    GoogleModule,
    TelegramModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
