import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { AppConfigService } from '../config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: AppConfigService) => ({
        secret: configService.get('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  // `JwtModule` se reexporta: `RealtimeModule` (Fase 6.1) necesita
  // `JwtService` para validar el JWT en el handshake del WebSocket sin
  // duplicar la config de `JwtModule.registerAsync`.
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
