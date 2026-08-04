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
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { OkResultDto } from '../common/dto/ok-result.dto';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { SESSION_COOKIE_NAME } from './jwt-auth.guard';

const LoginBodySchema = z.object({ password: z.string().min(1) });
class LoginDto extends createZodDto(LoginBodySchema) {}

const LoginResultSchema = z.object({ accessToken: z.string() });
class LoginResultDto extends createZodDto(LoginResultSchema) {}

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
  @ApiResponse({ status: 401, description: 'Contraseña incorrecta' })
  // `@ApiResponse({status:200, description})` manual sin schema para el
  // mismo código pisaría el schema que pone `@ZodResponse` (probado: el
  // contrato salía sin `content` en /api/auth/login hasta juntar los
  // dos en un solo decorador) — la descripción va acá, no aparte.
  @ZodResponse({
    status: 200,
    type: LoginResultDto,
    description:
      'Login correcto — setea cookie __Host-jin_session (Web) y devuelve el token en el body (CLI)',
  })
  async login(
    @Body() body: LoginDto,
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
  @ZodResponse({
    status: 200,
    type: OkResultDto,
    description: 'Cookie de sesión borrada',
  })
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  }
}
