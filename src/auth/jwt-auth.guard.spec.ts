import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it } from 'vitest';
import { JwtAuthGuard, SESSION_COOKIE_NAME } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';

const SECRET = 'a'.repeat(32);

function buildContext(options: {
  isPublic?: boolean;
  path?: string;
  cookies?: Record<string, string>;
  authorization?: string;
}): ExecutionContext {
  const request = {
    path: options.path ?? '/api/hitl/pending',
    cookies: options.cookies,
    headers: { authorization: options.authorization },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => (options.isPublic ? markPublic : (): void => {}),
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function markPublic(): void {
  /* marker function, decorated below via Reflect */
}
Reflect.defineMetadata(IS_PUBLIC_KEY, true, markPublic);

describe('JwtAuthGuard', () => {
  let jwtService: JwtService;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jwtService = new JwtService({ secret: SECRET });
    guard = new JwtAuthGuard(new Reflector(), jwtService);
  });

  it('rechaza sin token', async () => {
    const context = buildContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un token inválido', async () => {
    const context = buildContext({ authorization: 'Bearer no-es-un-jwt' });
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rechaza un token expirado', async () => {
    const expired = await jwtService.signAsync(
      { sub: 'owner' },
      { expiresIn: '-1s' },
    );
    const context = buildContext({ authorization: `Bearer ${expired}` });
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('@Public() bypassa la validación', async () => {
    const context = buildContext({ isPublic: true });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('acepta un token válido vía cookie', async () => {
    const token = await jwtService.signAsync({ sub: 'owner' });
    const context = buildContext({
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('acepta un token válido vía header Authorization: Bearer', async () => {
    const token = await jwtService.signAsync({ sub: 'owner' });
    const context = buildContext({ authorization: `Bearer ${token}` });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('permite /metrics sin token (código de terceros sin @Public())', async () => {
    const context = buildContext({ path: '/metrics' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
