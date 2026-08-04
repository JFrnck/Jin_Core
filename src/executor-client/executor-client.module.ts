import { Module, type OnModuleInit } from '@nestjs/common';
import { HitlModule } from '../hitl/hitl.module';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import {
  ExecutorClientService,
  type RunCodeInput,
  type StartPreviewServiceInput,
} from './executor-client.service';
import { PreviewServicesController } from './preview-services.controller';

@Module({
  imports: [HitlModule],
  controllers: [PreviewServicesController],
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

    // Fase 5.5 (ADR 0006): mismo patrón — `startPreviewService` es
    // `confirm` (diferida hasta que el owner apruebe por Telegram, la
    // ejecuta `ApprovalExecutionService`), `stopPreviewService`/
    // `listPreviewServices` son `notify`/`auto` (el agent loop las
    // ejecuta ya, vía este mismo registry).
    this.toolExecutorRegistry.register(
      'startPreviewService',
      async (payload) => {
        const input = payload as StartPreviewServiceInput;
        return this.executorClientService.startPreviewService(input);
      },
    );
    this.toolExecutorRegistry.register(
      'stopPreviewService',
      async (payload) => {
        const { serviceId } = payload as { serviceId: string };
        await this.executorClientService.stopPreviewService(serviceId);
        return { serviceId, stopped: true };
      },
    );
    this.toolExecutorRegistry.register('listPreviewServices', async () => {
      return this.executorClientService.listPreviewServices();
    });
  }
}
