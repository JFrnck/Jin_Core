import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../config/env.schema';
import { DB_CONNECTION } from '../../db/db.module';
import { googleOAuthTokenState } from '../../db/schema';
import {
  startTestDb,
  type TestDb,
} from '../../../test/support/postgres-testcontainer';
import { GoogleOAuthService } from './oauth.service';

describe('GoogleOAuthService (integración, Postgres real)', () => {
  let testDb: TestDb;
  let service: GoogleOAuthService;

  beforeAll(async () => {
    testDb = await startTestDb();

    const mockConfigService: Partial<ConfigService<Env, true>> = {
      get: (key: keyof Env) => {
        if (key === 'GOOGLE_CLIENT_ID') return 'mock-client-id';
        if (key === 'GOOGLE_CLIENT_SECRET') return 'mock-client-secret';
        if (key === 'GOOGLE_REDIRECT_URI')
          return 'http://localhost:3000/google/oauth/callback';
        if (key === 'GOOGLE_REFRESH_TOKEN') return 'mock-refresh-token';
        return undefined;
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleOAuthService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DB_CONNECTION, useValue: testDb.db },
      ],
    }).compile();

    service = moduleRef.get(GoogleOAuthService);
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.delete(googleOAuthTokenState);
  });

  it('onModuleInit debe inicializar la fila singleton id=1 en Postgres si no existe', async () => {
    const beforeRows = await testDb.db.select().from(googleOAuthTokenState);
    expect(beforeRows.length).toBe(0);

    await service.onModuleInit();

    const afterRows = await testDb.db.select().from(googleOAuthTokenState);
    expect(afterRows.length).toBe(1);
    expect(afterRows[0]?.id).toBe(1);
    expect(afterRows[0]?.lastRefreshedAt).toBeInstanceOf(Date);
  });

  it('updateLastRefreshedAt debe actualizar la fecha mediante upsert y sobrevivir entre reinstancias', async () => {
    await service.onModuleInit();

    const customDate = new Date('2026-06-15T12:00:00Z');
    await service.updateLastRefreshedAt(customDate);

    const fetchedDate = await service.getLastRefreshedAt();
    expect(fetchedDate.toISOString()).toBe(customDate.toISOString());

    // Verificar que sobrevive la recreación del servicio contra la misma BD
    const mockConfigService: Partial<ConfigService<Env, true>> = {
      get: (key: keyof Env) => {
        if (key === 'GOOGLE_CLIENT_ID') return 'mock-client-id';
        if (key === 'GOOGLE_CLIENT_SECRET') return 'mock-client-secret';
        if (key === 'GOOGLE_REDIRECT_URI')
          return 'http://localhost:3000/google/oauth/callback';
        if (key === 'GOOGLE_REFRESH_TOKEN') return 'mock-refresh-token';
        return undefined;
      },
    };

    const freshModuleRef: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleOAuthService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DB_CONNECTION, useValue: testDb.db },
      ],
    }).compile();

    const freshService = freshModuleRef.get(GoogleOAuthService);
    const dateFromFresh = await freshService.getLastRefreshedAt();
    expect(dateFromFresh.toISOString()).toBe(customDate.toISOString());
  });
});
