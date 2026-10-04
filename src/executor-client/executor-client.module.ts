import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { HitlModule } from '../hitl/hitl.module';
import { HitlPolicyModule } from '../hitl-policy/hitl-policy.module';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import {
  ExecutorClientService,
  type RunCodeInput,
} from './executor-client.service';
import {
  expandPreviewTemplate,
  type PreviewServiceToolInput,
} from './preview-template.logic';
import { EnvVaultService } from './env-vault.service';
import { OwnerPreviewPublishService } from './owner-preview-publish.service';
import { PreviewServicesController } from './preview-services.controller';

@Module({
  imports: [HitlModule, HitlPolicyModule, AuditModule],
  controllers: [PreviewServicesController],
  providers: [
    ExecutorClientService,
    OwnerPreviewPublishService,
    EnvVaultService,
  ],
  exports: [ExecutorClientService, EnvVaultService],
})
export class ExecutorClientModule implements OnModuleInit {
  constructor(
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly executorClientService: ExecutorClientService,
    private readonly envVault?: EnvVaultService,
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
      async (payload, context) => {
        // `template: "static"` agrega el servidor fijo de Jin (ver
        // preview-template.logic.ts); sin template, command/port del modelo.
        const input = expandPreviewTemplate(payload as PreviewServiceToolInput);
        // Variables de entorno (ADR 0020): el payload (que persiste y que puede escribir el
        // modelo) lleva SOLO nombres; los valores salen de la bóveda en memoria, por la
        // aprobación, y se piden UNA vez. Un `env` dentro del payload se ignora siempre.
        const envNames =
          (payload as { envNames?: readonly string[] }).envNames ?? [];
        const env =
          envNames.length > 0
            ? this.takeEnv(envNames, context?.requestId)
            : undefined;
        // El id de la aprobación viene del contexto (lo pone quien ejecuta),
        // NUNCA del payload: el payload lo puede escribir el modelo.
        return this.executorClientService.startPreviewService({
          ...input,
          ...(env ? { env } : {}),
          ...(context?.requestId ? { requestId: context.requestId } : {}),
        });
      },
    );
    this.toolExecutorRegistry.register(
      'extendPreviewService',
      async (payload) => {
        const { serviceId, extraSeconds } = payload as {
          serviceId: string;
          extraSeconds: number;
        };
        return this.executorClientService.extendPreviewService(
          serviceId,
          extraSeconds,
        );
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

    // Demos en GitHub (ADR 0019): guardar es `confirm` (y `humanDecision`: ningún modo de
    // autonomía lo automatiza); listar es de solo lectura.
    this.toolExecutorRegistry.register('saveDemoToGithub', async (payload) => {
      const { serviceId, slug } = payload as {
        serviceId: string;
        slug: string;
      };
      return this.executorClientService.saveGithubDemo({ serviceId, slug });
    });
    this.toolExecutorRegistry.register('listGithubDemos', async () => {
      return this.executorClientService.listGithubDemos();
    });
  }

  /** Valores de la bóveda para esta aprobación; falla claro si se perdieron o no coinciden con los nombres. */
  private takeEnv(
    names: readonly string[],
    requestId: string | undefined,
  ): Record<string, string> {
    const env = requestId ? this.envVault?.take(requestId) : undefined;
    if (!env) {
      throw new Error(
        'Las variables de entorno de esta demo no están disponibles (Core se reinició o la aprobación venció). Vuelve a publicar con las variables.',
      );
    }
    const given = Object.keys(env).sort().join(',');
    if (given !== [...names].sort().join(',')) {
      throw new Error(
        'Las variables recibidas no coinciden con las aprobadas: no se crea la demo.',
      );
    }
    return env;
  }
}
