import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { HitlModule } from '../hitl/hitl.module';
import { loadFeatureFlagsConfig } from './feature-flags-config.schema';
import { FeatureFlagsService } from './feature-flags.service';
import { FEATURE_FLAGS_CONFIG } from './feature-flags.tokens';
import type { FeatureFlagsConfig } from './feature-flags.types';

const FEATURE_FLAGS_CONFIG_PATH = join(
  process.cwd(),
  'config',
  'feature-flags.yaml',
);

@Module({
  imports: [HitlModule],
  providers: [
    {
      provide: FEATURE_FLAGS_CONFIG,
      useFactory: (): FeatureFlagsConfig =>
        loadFeatureFlagsConfig(FEATURE_FLAGS_CONFIG_PATH),
    },
    FeatureFlagsService,
  ],
  exports: [FeatureFlagsService],
})
export class FeatureFlagsModule {}
