import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { AppConfigService } from '../config';
import { InvalidCredentialsError } from './errors';

// Sin blocklist de logout (ADR 0007, decisión #2 aceptada explícitamente
// para v1 single-user): expiry corto acota el riesgo de un token robado.
const JWT_EXPIRES_IN = '7d';
const JWT_SUBJECT = 'owner';

export interface AuthTokenResult {
  readonly accessToken: string;
}

/**
 * Auth single-user (Fase 6.1, BLUEPRINT 5.2) — no hay registro ni roles,
 * solo la contraseña del owner hasheada con Argon2id
 * (`scripts/hash-password.ts`) comparada contra `OWNER_PASSWORD_HASH`.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(ConfigService) private readonly configService: AppConfigService,
    private readonly jwtService: JwtService,
  ) {}

  async login(password: string): Promise<AuthTokenResult> {
    // `ConfigService.get()` solo tipa fuerte por contexto (su overload
    // por defecto es `get<T = any>(...)`) — sin la anotación explícita
    // acá, `hash` quedaría `any` sin que `tsc` avise.
    const hash: string = this.configService.get('OWNER_PASSWORD_HASH');

    const isValid = await argon2.verify(hash, password).catch(() => false);
    if (!isValid) {
      throw new InvalidCredentialsError();
    }

    const accessToken = await this.jwtService.signAsync(
      { sub: JWT_SUBJECT },
      { expiresIn: JWT_EXPIRES_IN },
    );
    return { accessToken };
  }
}
