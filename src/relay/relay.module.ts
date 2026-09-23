import { Module } from '@nestjs/common';
import { RelayBotService } from './relay-bot.service';
import { RelayController } from './relay.controller';
import { RelayDashboardController } from './relay-dashboard.controller';
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
 * Dos controllers, dos fronteras de confianza distintas sobre el mismo
 * `RelayService`: `RelayController` (`/api/relay/*`, `RELAY_TOKEN` + bloqueado
 * del internet público) es el canal del CLI de la VM; `RelayDashboardController`
 * (`/api/bridge/*`, JWT global) es el canal del dashboard. Ninguno de los dos
 * gana privilegios de aprobación — la propiedad de aislamiento de arriba
 * sigue aplicando a ambos por igual.
 *
 * `DbModule` es global, así que `RelayStore` obtiene la conexión sin
 * importarlo.
 */
@Module({
  controllers: [RelayController, RelayDashboardController],
  providers: [RelayStore, RelayBotService, RelayService],
  exports: [RelayService],
})
export class RelayModule {}
