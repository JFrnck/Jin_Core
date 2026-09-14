import { Module, type OnModuleInit } from '@nestjs/common';
import { HitlModule } from '../hitl/hitl.module';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { MemoryModule } from '../memory/memory.module';
import { MetricsModule } from '../metrics/metrics.module';
import { CorpusService } from './corpus.service';
import type { IndexEmailInput } from './corpus.types';

@Module({
  imports: [HitlModule, MemoryModule, MetricsModule],
  providers: [CorpusService],
  exports: [CorpusService],
})
export class CorpusModule implements OnModuleInit {
  constructor(
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly corpusService: CorpusService,
  ) {}

  onModuleInit(): void {
    // Registrar ejecutor para `indexEmailToCorpus`
    this.toolExecutorRegistry.register(
      'indexEmailToCorpus',
      async (payload) => {
        const input = payload as IndexEmailInput;
        return this.corpusService.indexEmail(input);
      },
    );

    // Registrar ejecutor para `searchCorpus`
    this.toolExecutorRegistry.register('searchCorpus', async (payload) => {
      const { query, limit } = payload as { query: string; limit?: number };
      return this.corpusService.search(query, limit);
    });
  }
}
