import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/public.decorator';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Liveness básico (K8s, curl manual) — sin datos sensibles, no tiene
  // sentido exigir JWT acá (Fase 6.1: todo lo demás sí lo exige).
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
