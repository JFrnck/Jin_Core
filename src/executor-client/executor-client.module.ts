import { Module, type OnModuleInit } from '@nestjs/common';
import { HitlModule } from '../hitl/hitl.module';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import {
  ExecutorClientService,
  type RunCodeInput,
} from './executor-client.service';

@Module({
  imports: [HitlModule],
  providers: [ExecutorClientService],
  exports: [ExecutorClientService],
})
export class ExecutorClientModule implements OnModuleInit {
  constructor(
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly executorClientService: ExecutorClientService,
  ) {}

  onModuleInit(): void {
    // Registrar el ejecutor de la herramienta `runCode` para ser invocado
    // automáticamente cuando la aprobación HITL se resuelva (mismo patrón
    // que GoogleModule, PR #8). El resultado (stdout/stderr) es contenido
    // no confiable, pero el wrapping con `wrapUntrustedContent` ya lo hace
    // el agent loop (Fase 5.1) para todo resultado de tool — no hace falta
    // duplicarlo acá.
    this.toolExecutorRegistry.register('runCode', async (payload) => {
      const { code, language } = payload as RunCodeInput;
      return this.executorClientService.runCode({ code, language });
    });
  }
}
