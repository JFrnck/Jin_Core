import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { HitlModule } from '../hitl/hitl.module';
import {
  loadAutonomyConfig,
  type AutonomyConfig,
} from './autonomy-config.schema';
import { AutonomyController } from './autonomy.controller';
import { AutonomyService } from './autonomy.service';
import { AUTONOMY_CONFIG } from './autonomy.tokens';

const AUTONOMY_CONFIG_PATH = join(process.cwd(), 'config', 'autonomy.yaml');

@Module({
  imports: [HitlModule, AuditModule],
  controllers: [AutonomyController],
  providers: [
    {
      provide: AUTONOMY_CONFIG,
      useFactory: (): AutonomyConfig =>
        loadAutonomyConfig(AUTONOMY_CONFIG_PATH),
    },
    AutonomyService,
  ],
  exports: [AutonomyService],
})
export class AutonomyModule {}
