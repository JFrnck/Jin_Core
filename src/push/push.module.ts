import { Module } from '@nestjs/common';
import { OrchestratorModule } from '../agent/orchestrator.module';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { PushStore } from './push.store';

/**
 * Notificaciones push de la app iOS (ADR 0014). Apagado sin claves APNs.
 *
 * Solo escucha eventos y avisa. No importa `HitlModule` ni `AuditModule`:
 * desde una notificación no se puede aprobar nada, y acá no vive el código
 * que podría hacerlo. `OrchestratorModule` aporta `LedgerRepository` (lectura
 * del run para la Live Activity). `DbModule` es global.
 */
@Module({
  imports: [OrchestratorModule],
  controllers: [PushController],
  providers: [PushStore, PushService],
})
export class PushModule {}
