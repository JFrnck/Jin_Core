import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { AnthropicProvider } from './anthropic.provider';
import { FailoverService } from './failover.service';
import { GoogleProvider } from './google.provider';
import { loadModelsConfig } from './models-config.schema';
import { MODELS_CONFIG } from './model-provider.tokens';
import type { ModelsConfig } from './model-provider.types';
import { ModelRouterService } from './router.service';

// El I/O de disco (leer y parsear el YAML) queda fuera del constructor
// de ModelRouterService vía este provider de factory — mismo espíritu
// que DB_POOL/DB_CONNECTION en db.module.ts — para que sus tests
// unitarios puedan inyectar un ModelsConfig fijo sin tocar el
// filesystem. El token vive en model-provider.tokens.ts, no acá, para
// evitar un import circular con router.service.ts (ver ese archivo).
const MODELS_CONFIG_PATH = join(process.cwd(), 'config', 'models.yaml');

@Module({
  imports: [FeatureFlagsModule],
  providers: [
    {
      provide: MODELS_CONFIG,
      useFactory: (): ModelsConfig => loadModelsConfig(MODELS_CONFIG_PATH),
    },
    AnthropicProvider,
    GoogleProvider,
    FailoverService,
    ModelRouterService,
  ],
  exports: [ModelRouterService],
})
export class ModelProviderModule {}
