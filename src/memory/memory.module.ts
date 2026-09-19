import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BudgetModule } from '../budget/budget.module';
import type { AppConfigService } from '../config';
import { ConsolidationService } from './consolidation.service';
import { EmbeddingProvider } from './embedding-provider';
import { MemoryController } from './memory.controller';
import { MEMORY_DB_PATH } from './memory.tokens';
import { MemoryService } from './memory.service';
import { MemoryStore } from './store';

@Module({
  imports: [BudgetModule],
  controllers: [MemoryController],
  providers: [
    {
      provide: MEMORY_DB_PATH,
      inject: [ConfigService],
      useFactory: (configService: AppConfigService): string =>
        configService.get('MEMORY_DB_PATH'),
    },
    EmbeddingProvider,
    MemoryStore,
    ConsolidationService,
    MemoryService,
  ],
  // EmbeddingProvider exportado desde Fase 9.3: src/corpus/ lo reusa
  // (importando MemoryModule) en vez de registrar un segundo proveedor
  // de embeddings (AGENTS.md 1.1).
  exports: [MemoryService, ConsolidationService, EmbeddingProvider],
})
export class MemoryModule {}
