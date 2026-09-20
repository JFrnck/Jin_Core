import { Module } from '@nestjs/common';
import { AutonomyModule } from '../autonomy/autonomy.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { HitlPolicyService } from './hitl-policy.service';

// Módulo propio (no dentro de HitlModule): FeatureFlagsModule y AutonomyModule
// ya importan HitlModule, así que ponerlo ahí crearía un ciclo de módulos.
@Module({
  imports: [FeatureFlagsModule, AutonomyModule],
  providers: [HitlPolicyService],
  exports: [HitlPolicyService],
})
export class HitlPolicyModule {}
