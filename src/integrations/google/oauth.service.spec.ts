import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env.schema';
import type { Db } from '../../db/db.module';
import { GoogleOAuthService } from './oauth.service';

describe('GoogleOAuthService', () => {
  let service: GoogleOAuthService;
  let mockConfigService: Partial<ConfigService<Env, true>>;
  let mockDb: Partial<Db>;

  beforeEach(() => {
    mockConfigService = {
      get: (key: keyof Env) => {
        if (key === 'GOOGLE_CLIENT_ID') return 'mock-client-id';
        if (key === 'GOOGLE_CLIENT_SECRET') return 'mock-client-secret';
        if (key === 'GOOGLE_REDIRECT_URI')
          return 'http://localhost:3000/google/oauth/callback';
        if (key === 'GOOGLE_REFRESH_TOKEN') return 'mock-refresh-token';
        return undefined;
      },
    };

    mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };

    service = new GoogleOAuthService(
      mockConfigService as ConfigService<Env, true>,
      mockDb as Db,
    );
  });

  it('debe inicializar la fila de estado en BD al arrancar si no existe', async () => {
    await service.onModuleInit();
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('debe retornar un OAuth2Client configurado', () => {
    const client = service.getOAuth2Client();
    expect(client).toBeDefined();
  });

  it('debe actualizar lastRefreshedAt en la base de datos', async () => {
    const testDate = new Date();
    await service.updateLastRefreshedAt(testDate);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('debe emitir log de advertencia en el cron si pasaron >= 6 días', async () => {
    const oldDate = new Date(Date.now() - 6.5 * 24 * 60 * 60 * 1000);
    const spy = vi
      .spyOn(service, 'getLastRefreshedAt')
      .mockResolvedValue(oldDate);

    await service.checkOAuthTokenStatus();
    expect(spy).toHaveBeenCalled();
  });
});
