import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSecrets } from './secrets-loader';

const loginMock = vi.fn();
const listSecretsMock = vi.fn();

// Fase 8.1: mockear el SDK externo (AGENTS.md 6.3), mismo criterio que
// embedding-provider.spec.ts con el SDK de OpenAI.
vi.mock('@infisical/sdk', () => ({
  InfisicalSDK: class {
    auth() {
      return { universalAuth: { login: loginMock } };
    }
    secrets() {
      return { listSecrets: listSecretsMock };
    }
  },
}));

const ALL_REAL_SECRETS = {
  ANTHROPIC_API_KEY: 'anthropic-real',
  GEMINI_API_KEY: 'gemini-real',
  OPENAI_API_KEY: 'openai-real',
  CANVAS_BASE_URL: 'https://canvas.real',
  CANVAS_API_TOKEN: 'canvas-real',
  TELEGRAM_BOT_TOKEN: 'telegram-real',
  TELEGRAM_OWNER_CHAT_ID: '12345',
  TELEGRAM_WEBHOOK_SECRET: 'webhook-real',
  GOOGLE_CLIENT_ID: 'google-id-real',
  GOOGLE_CLIENT_SECRET: 'google-secret-real',
  GOOGLE_REFRESH_TOKEN: 'google-refresh-real',
  OWNER_PASSWORD_HASH: 'owner-hash-real',
  JWT_SECRET: 'jwt-secret-real',
};

function secretsFrom(values: Record<string, string>) {
  return Object.entries(values).map(([secretKey, secretValue]) => ({
    secretKey,
    secretValue,
  }));
}

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    INFISICAL_ENABLED: 'true',
    INFISICAL_CLIENT_ID: 'client-id',
    INFISICAL_CLIENT_SECRET: 'client-secret',
    INFISICAL_PROJECT_ID: 'project-id',
    INFISICAL_ENVIRONMENT: 'prod',
    ...overrides,
  };
}

describe('loadSecrets', () => {
  beforeEach(() => {
    loginMock.mockReset();
    listSecretsMock.mockReset();
  });

  it('es un no-op si INFISICAL_ENABLED no es "true": no llama al SDK ni toca el env', async () => {
    const env = { INFISICAL_ENABLED: 'false' };

    await loadSecrets(env);

    expect(loginMock).not.toHaveBeenCalled();
    expect(listSecretsMock).not.toHaveBeenCalled();
    expect(env).toEqual({ INFISICAL_ENABLED: 'false' });
  });

  it('con el set completo de secretos, los vuelca a env y no lanza', async () => {
    loginMock.mockResolvedValue(undefined);
    listSecretsMock.mockResolvedValue({
      secrets: secretsFrom(ALL_REAL_SECRETS),
    });
    const env = baseEnv();

    await loadSecrets(env);

    expect(loginMock).toHaveBeenCalledWith({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    });
    expect(listSecretsMock).toHaveBeenCalledWith({
      projectId: 'project-id',
      environment: 'prod',
    });
    for (const [key, value] of Object.entries(ALL_REAL_SECRETS)) {
      expect(env[key]).toBe(value);
    }
  });

  it('propaga el error si el login contra Infisical falla (no lo traga)', async () => {
    loginMock.mockRejectedValue(new Error('Infisical unreachable'));

    await expect(loadSecrets(baseEnv())).rejects.toThrow(
      'Infisical unreachable',
    );
    expect(listSecretsMock).not.toHaveBeenCalled();
  });

  it('lanza mencionando la clave exacta si Infisical devuelve un subconjunto incompleto', async () => {
    loginMock.mockResolvedValue(undefined);
    const { JWT_SECRET: _omit, ...incomplete } = ALL_REAL_SECRETS;
    listSecretsMock.mockResolvedValue({ secrets: secretsFrom(incomplete) });

    await expect(loadSecrets(baseEnv())).rejects.toThrow('JWT_SECRET');
  });
});
