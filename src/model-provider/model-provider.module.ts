import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { AnthropicProvider } from './anthropic.provider';
import { ChatModelPreferenceController } from './chat-model-preference.controller';
import { ChatModelPreferenceService } from './chat-model-preference.service';
import { FailoverService } from './failover.service';
import { GoogleProvider } from './google.provider';
import { loadChatOptions, loadModelsConfig } from './models-config.schema';
import { CHAT_OPTIONS, MODELS_CONFIG } from './model-provider.tokens';
import type { ChatModelOption, ModelsConfig } from './model-provider.types';
import { OpenAIProvider } from './openai.provider';
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
  controllers: [ChatModelPreferenceController],
  providers: [
    {
      provide: MODELS_CONFIG,
      useFactory: (): ModelsConfig => loadModelsConfig(MODELS_CONFIG_PATH),
    },
    {
      provide: CHAT_OPTIONS,
      useFactory: (): readonly ChatModelOption[] =>
        loadChatOptions(MODELS_CONFIG_PATH),
    },
    AnthropicProvider,
    GoogleProvider,
    OpenAIProvider,
    FailoverService,
    ChatModelPreferenceService,
    ModelRouterService,
  ],
  exports: [ModelRouterService, ChatModelPreferenceService],
})
export class ModelProviderModule {}
