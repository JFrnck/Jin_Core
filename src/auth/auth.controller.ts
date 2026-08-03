import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { SESSION_COOKIE_NAME } from './jwt-auth.guard';

const LoginBodySchema = z.object({ password: z.string().min(1) });
type LoginBody = z.infer<typeof LoginBodySchema>;

// 7 días — igual al expiry del JWT firmado en `AuthService.login()`.
const SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  // Único vector real de fuerza bruta (una sola contraseña) — límite más
  // estricto que el default global de RateLimitModule (ADR 0007 #4).
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login single-user con la contraseña del owner' })
  @ApiResponse({
    status: 200,
    description:
      'Login correcto — setea cookie __Host-jin_session (Web) y devuelve el token en el body (CLI)',
  })
  @ApiResponse({ status: 401, description: 'Contraseña incorrecta' })
  async login(
    @Body(new ZodValidationPipe(LoginBodySchema)) body: LoginBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const { accessToken } = await this.authService.login(body.password);

    // __Host- exige Secure + Path=/ + sin Domain (BLUEPRINT 5.2) — el
    // navegador nunca la adjunta a peticiones cross-site, incluidas las
    // que origina cualquier app generada bajo jinserver.com.
    res.cookie(SESSION_COOKIE_NAME, accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });

    return { accessToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Logout — borra la cookie del cliente. Sin blocklist: un Bearer token capturado sigue válido hasta expirar (ver ADR 0007).',
  })
  @ApiResponse({ status: 200, description: 'Cookie de sesión borrada' })
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  }
}
