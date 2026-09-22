import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.schema';
import { RelayDisabledError } from './errors';
import { RelayTokenGuard } from './relay-token.guard';

const VALID = 'r'.repeat(64);

function contextWith(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: authorization ? { authorization } : {} }),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(relayToken: string | undefined): RelayTokenGuard {
  const configService = {
    get: vi.fn().mockReturnValue(relayToken),
  } as unknown as ConfigService<Env, true>;
  return new RelayTokenGuard(configService);
}

describe('RelayTokenGuard', () => {
  it('acepta el token correcto', () => {
    expect(guardWith(VALID).canActivate(contextWith(`Bearer ${VALID}`))).toBe(
      true,
    );
  });

  it('rechaza sin cabecera Authorization', () => {
    expect(() => guardWith(VALID).canActivate(contextWith())).toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un token ajeno de la misma longitud', () => {
    expect(() =>
      guardWith(VALID).canActivate(contextWith(`Bearer ${'x'.repeat(64)}`)),
    ).toThrow(UnauthorizedException);
  });

  it('rechaza un token que es prefijo del correcto (no compara parcialmente)', () => {
    expect(() =>
      guardWith(VALID).canActivate(contextWith(`Bearer ${VALID.slice(0, 32)}`)),
    ).toThrow(UnauthorizedException);
  });

  it('rechaza el esquema equivocado (el JWT del owner no sirve acá)', () => {
    // Son credenciales distintas a propósito: el token del puente no abre la
    // API de Jin y el JWT del owner no abre el puente.
    expect(() =>
      guardWith(VALID).canActivate(contextWith(`Basic ${VALID}`)),
    ).toThrow(UnauthorizedException);
  });

  it('sin RELAY_TOKEN configurado responde 503 (no configurado), no 401 (token malo)', () => {
    // Distinguirlos importa para quien depura: "no lo montaste" y "tu token
    // está mal" son dos problemas muy distintos.
    expect(() =>
      guardWith(undefined).canActivate(contextWith(`Bearer ${VALID}`)),
    ).toThrow(RelayDisabledError);
  });
});
