import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Env } from '../config/env.schema';
import { RelayDisabledError } from './errors';

/** Comparación en tiempo constante: no filtra el token por cuánto tarda. */
function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  // `timingSafeEqual` exige la misma longitud; comparar la longitud aparte
  // solo revela eso, no el contenido.
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Cierra `/api/relay/*` con un token PROPIO (`RELAY_TOKEN`), no con el JWT del
 * owner (ADR 0012).
 *
 * Es la diferencia entre "Claude puede hablarte" y "Claude es vos": si este
 * token se filtra, quien lo tenga solo puede mandarte mensajes por el chat del
 * puente. No puede aprobar una acción HITL, ni leer tu correo, ni chatear como
 * vos — esas puertas siguen pidiendo el JWT, que el puente nunca ve.
 */
@Injectable()
export class RelayTokenGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('RELAY_TOKEN', {
      infer: true,
    });
    if (!expected) {
      throw new RelayDisabledError();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    const provided = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : undefined;

    if (!provided || !safeEquals(provided, expected)) {
      throw new UnauthorizedException('Token del puente inválido o ausente.');
    }

    return true;
  }
}
