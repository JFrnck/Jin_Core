import { Module } from '@nestjs/common';
import { RelayBotService } from './relay-bot.service';
import { RelayController } from './relay.controller';
import { RelayService } from './relay.service';
import { RelayStore } from './relay.store';

/**
 * Puente Claude Code ↔ owner (ADR 0012).
 *
 * **Lo que este módulo NO importa es tan importante como lo que importa:**
 * no trae `HitlModule`, `AuditModule` ni ningún servicio de aprobación. Un
 * mensaje del puente no puede convertirse en una acción aprobada de Jin
 * porque acá no vive el código que podría hacerlo. Hay un test que lo fija
 * (`relay.isolation.spec.ts`): si alguien añade esa dependencia, falla.
 *
 * `DbModule` es global, así que `RelayStore` obtiene la conexión sin
 * importarlo.
 */
@Module({
  controllers: [RelayController],
  providers: [RelayStore, RelayBotService, RelayService],
  exports: [RelayService],
})
export class RelayModule {}
