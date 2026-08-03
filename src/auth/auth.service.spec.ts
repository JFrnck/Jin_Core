import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../config';
import { AuthService } from './auth.service';
import { InvalidCredentialsError } from './errors';

describe('AuthService', () => {
  const PASSWORD = 'correct horse battery staple';
  let service: AuthService;

  beforeAll(async () => {
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const configService = {
      get: (key: string) => {
        if (key === 'OWNER_PASSWORD_HASH') return hash;
        throw new Error(`clave inesperada: ${key}`);
      },
    } as unknown as AppConfigService;
    const jwtService = new JwtService({ secret: 'a'.repeat(32) });
    service = new AuthService(configService, jwtService);
  });

  it('devuelve un JWT válido con la contraseña correcta', async () => {
    const { accessToken } = await service.login(PASSWORD);
    expect(typeof accessToken).toBe('string');
    expect(accessToken.split('.')).toHaveLength(3);
  });

  it('lanza InvalidCredentialsError con la contraseña incorrecta', async () => {
    await expect(service.login('contraseña equivocada')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });
});
