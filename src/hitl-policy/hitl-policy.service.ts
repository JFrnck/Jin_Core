import { Injectable } from '@nestjs/common';
import { AutonomyService } from '../autonomy/autonomy.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { classifyToolCall } from '../hitl/classifier';
import type { HitlDecision } from '../hitl/types';
import { getToolDefinition } from '../tools/registry';

/**
 * ÚNICA puerta por la que se decide el nivel HITL efectivo de una llamada a
 * tool (ADR 0010). Antes había 4 sitios que clasificaban por su cuenta y solo
 * `AgentService` consultaba los overrides de la Fase 9.5 -- un modo global
 * habría sido imposible de garantizar.
 *
 * Capas, en este orden (cada una solo puede ajustar lo que la anterior dejó):
 * 1. `classifyToolCall`: el nivel ESTÁTICO del registry -- la única fuente
 *    del nivel base (regla de oro #4). Lanza `UnknownToolError` si la tool no
 *    existe: por eso el LLM no puede invocar tools virtuales como
 *    `autonomyModeChange`.
 * 2. Overrides de `config/feature-flags.yaml` (Fase 9.5): decisión explícita
 *    del owner. **Si un override cambió el nivel, GANA y el modo de autonomía
 *    no lo toca**: un `hitlOverride` que endurece una tool es una orden
 *    específica y no debe deshacerla un interruptor general.
 * 3. Modo de autonomía: relaja `confirm` -> `notify` según el modo vigente.
 */
@Injectable()
export class HitlPolicyService {
  constructor(
    private readonly featureFlagsService: FeatureFlagsService,
    private readonly autonomyService: AutonomyService,
  ) {}

  async decide(toolName: string, inputs: unknown): Promise<HitlDecision> {
    const staticDecision = classifyToolCall(toolName, inputs);
    const flagged =
      await this.featureFlagsService.resolveEffectiveLevel(staticDecision);
    if (flagged.level !== staticDecision.level) {
      return flagged;
    }
    return this.autonomyService.relax(flagged, getToolDefinition(toolName));
  }
}
