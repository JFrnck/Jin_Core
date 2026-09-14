import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { computeInputsHash } from '../agent/agent.logic';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { featureFlagHitlOverrides } from '../db/schema';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import type { HitlDecision, HitlLevel } from '../hitl/types';
import { hitlLevelOrdinal } from '../hitl/types';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { getToolDefinition } from '../tools/registry';
import { loadFeatureFlagsConfig } from './feature-flags-config.schema';
import { FEATURE_FLAGS_CONFIG } from './feature-flags.tokens';
import type {
  FeatureFlagsConfig,
  IntegrationName,
} from './feature-flags.types';

// Mismo path en el factory del módulo (carga inicial) y acá (reload) --
// se computa dos veces a propósito en vez de inyectar un token solo
// para un string constante durante la vida del proceso.
const FEATURE_FLAGS_CONFIG_PATH = join(
  process.cwd(),
  'config',
  'feature-flags.yaml',
);

/**
 * Nombre fijo del "tool" virtual que resuelve un override de hitlLevel
 * al aprobarse -- no es una tool real invocable por el LLM (no está en
 * `Jin_Core/src/tools/registry.ts`, `AgentService` nunca la declara al
 * modelo). Es el mismo mecanismo genérico de "aprobar -> ejecutar" que
 * usa cualquier tool `confirm`/`dual-confirm` real (PR #8, Fase 4.2) --
 * cero código de aprobación nuevo.
 */
export const FEATURE_FLAG_HITL_OVERRIDE_TOOL_NAME = 'featureFlagHitlOverride';

interface FeatureFlagHitlOverridePayload {
  readonly targetTool: string;
  readonly newLevel: HitlLevel;
}

const SYSTEM_APPROVER = 'system:configmap-reload';

/**
 * Feature flags en caliente (Fase 9.5, BLUEPRINT §12.3). Ver
 * docs/adr (Jin_Docs) para el diseño completo -- resumen: el LLM no
 * tiene NINGÚN camino hacia este servicio (no es una tool del registry,
 * `AgentService` solo lo consulta, nunca lo expone). El owner cambia
 * `config/feature-flags.yaml` vía PR a Jin_Infra + `reload()` (SIGHUP).
 */
@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private config: FeatureFlagsConfig;

  constructor(
    @Inject(FEATURE_FLAGS_CONFIG) initialConfig: FeatureFlagsConfig,
    @Inject(DB_CONNECTION) private readonly db: Db,
    private readonly dualConfirmService: DualConfirmService,
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
  ) {
    this.config = initialConfig;
    this.toolExecutorRegistry.register(
      FEATURE_FLAG_HITL_OVERRIDE_TOOL_NAME,
      async (payload) =>
        this.applyApprovedOverride(payload as FeatureFlagHitlOverridePayload),
    );
  }

  isIntegrationEnabled(integration: IntegrationName | undefined): boolean {
    if (integration === undefined) return true;
    return this.config.integrations[integration].enabled;
  }

  getModelOverride(taskProfile: string): string | undefined {
    return this.config.modelRouting[taskProfile]?.primary;
  }

  /**
   * Re-lee `config/feature-flags.yaml` (SIGHUP, `main.ts`) y reconcilia
   * `hitlOverrides` contra la tabla `feature_flag_hitl_overrides`:
   * - Sube o queda igual respecto del nivel estático del registry ->
   *   se aplica ya (approver `SYSTEM_APPROVER`).
   * - Baja -> NO se aplica: crea una pending approval `dual-confirm`
   *   real (mismo flujo que cualquier otra tool `dual-confirm`) y
   *   espera a que un humano la resuelva dos veces, >=30s aparte.
   */
  async reload(): Promise<void> {
    const nextConfig = loadFeatureFlagsConfig(FEATURE_FLAGS_CONFIG_PATH);

    for (const [toolName, declaredLevel] of Object.entries(
      nextConfig.hitlOverrides,
    )) {
      await this.reconcileHitlOverride(toolName, declaredLevel);
    }

    this.config = nextConfig;
    this.logger.log('Feature flags recargados.');
  }

  private async reconcileHitlOverride(
    toolName: string,
    declaredLevel: HitlLevel,
  ): Promise<void> {
    const tool = getToolDefinition(toolName);
    if (!tool) {
      this.logger.warn(
        `hitlOverrides declara la tool "${toolName}", que no existe en el registry -- ignorado.`,
      );
      return;
    }

    const [existing] = await this.db
      .select()
      .from(featureFlagHitlOverrides)
      .where(eq(featureFlagHitlOverrides.toolName, toolName));
    if (existing?.level === declaredLevel) {
      return; // ya vigente, nada que hacer.
    }

    if (hitlLevelOrdinal(declaredLevel) >= hitlLevelOrdinal(tool.hitlLevel)) {
      await this.db
        .insert(featureFlagHitlOverrides)
        .values({ toolName, level: declaredLevel, approver: SYSTEM_APPROVER })
        .onConflictDoUpdate({
          target: featureFlagHitlOverrides.toolName,
          set: {
            level: declaredLevel,
            approver: SYSTEM_APPROVER,
            approvedAt: new Date(),
          },
        });
      this.logger.log(
        `Override de "${toolName}" a "${declaredLevel}" aplicado de inmediato (sube o iguala el nivel estático).`,
      );
      return;
    }

    const payload: FeatureFlagHitlOverridePayload = {
      targetTool: toolName,
      newLevel: declaredLevel,
    };
    await this.dualConfirmService.createPendingApproval({
      requestId: randomUUID(),
      toolName: FEATURE_FLAG_HITL_OVERRIDE_TOOL_NAME,
      level: 'dual-confirm',
      inputsHash: computeInputsHash(payload),
      planSummary: `Bajar hitlLevel de "${toolName}" a "${declaredLevel}" vía feature flag (config/feature-flags.yaml).`,
      payload,
      actor: 'system:feature-flags',
    });
    this.logger.warn(
      `Override de "${toolName}" a "${declaredLevel}" BAJA el nivel estático -- pendiente de aprobación dual-confirm, no vigente todavía.`,
    );
  }

  private async applyApprovedOverride(
    payload: FeatureFlagHitlOverridePayload,
  ): Promise<{ ok: true }> {
    await this.db
      .insert(featureFlagHitlOverrides)
      .values({
        toolName: payload.targetTool,
        level: payload.newLevel,
        approver: 'owner:dual-confirm',
      })
      .onConflictDoUpdate({
        target: featureFlagHitlOverrides.toolName,
        set: {
          level: payload.newLevel,
          approver: 'owner:dual-confirm',
          approvedAt: new Date(),
        },
      });
    return { ok: true };
  }

  /**
   * Ajusta la decisión ESTÁTICA de `classifyToolCall` (sin tocarla) si
   * existe un override vigente para esta tool -- vigente significa: hay
   * una fila en `feature_flag_hitl_overrides` cuyo `level` coincide
   * exactamente con lo que `config/feature-flags.yaml` declara AHORA.
   * Si el YAML bajó el nivel y todavía no hay aprobación, la fila no
   * existe (o tiene un valor distinto) -- se devuelve `baseline` intacto.
   */
  async resolveEffectiveLevel(baseline: HitlDecision): Promise<HitlDecision> {
    const declaredOverride = this.config.hitlOverrides[baseline.toolName];
    if (declaredOverride === undefined) return baseline;

    const [row] = await this.db
      .select()
      .from(featureFlagHitlOverrides)
      .where(eq(featureFlagHitlOverrides.toolName, baseline.toolName));
    if (!row || row.level !== declaredOverride) return baseline;

    const level = row.level;
    return {
      ...baseline,
      level,
      approvalsRequired:
        level === 'dual-confirm' ? 2 : level === 'confirm' ? 1 : 0,
      notifyAfterExecution: level === 'notify',
    };
  }
}
