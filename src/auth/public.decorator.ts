import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Allowlist explícito para `JwtAuthGuard` (global vía `APP_GUARD`, Fase
 * 6.1: todo está protegido por default). Usar en cualquier endpoint que
 * deba responder sin token — hoy solo `POST /api/auth/login` y el
 * webhook de Telegram (autenticado por su propio secret header, no JWT).
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
