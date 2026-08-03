import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';

export const SESSION_COOKIE_NAME = '__Host-jin_session';

/**
 * Rutas de código de terceros que no podemos decorar con `@Public()` —
 * `@willsoto/nestjs-prometheus` registra su propio controller para
 * `/metrics` sin exponer ningún hook para aplicarle metadata nuestra.
 * Allowlist explícito por path, no por falta de auth real (Prometheus no
 * expone secretos, solo contadores).
 */
const PUBLIC_PATH_ALLOWLIST = new Set(['/metrics']);

/**
 * Guard global (`APP_GUARD`, Fase 6.1): todo endpoint requiere JWT válido
 * salvo `@Public()` explícito. Acepta la cookie `__Host-jin_session`
 * (Web) o `Authorization: Bearer` (CLI), en ese orden — mismo token,
 * firmado por `AuthService.login()`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (PUBLIC_PATH_ALLOWLIST.has(request.path)) {
      return true;
    }

    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Falta token de autenticación.');
    }

    try {
      await this.jwtService.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado.');
    }

    return true;
  }

  private extractToken(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, string> | undefined;
    const cookieToken = cookies?.[SESSION_COOKIE_NAME];
    if (cookieToken) {
      return cookieToken;
    }

    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice('Bearer '.length);
    }

    return undefined;
  }
}
