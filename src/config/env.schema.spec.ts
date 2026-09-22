import { describe, expect, it } from 'vitest';
import { validateEnv, validateMigrationEnv } from './env.schema';

describe('validateMigrationEnv', () => {
  it('acepta un entorno con SOLO DATABASE_URL (el Job de migración de K8s no recibe secretos de Infisical)', () => {
    const env = validateMigrationEnv({
      DATABASE_URL: 'postgres://u:p@db:5432/jin',
    });
    expect(env.DATABASE_URL).toBe('postgres://u:p@db:5432/jin');
  });

  it('rechaza DATABASE_URL ausente o vacía, con mensaje claro', () => {
    expect(() => validateMigrationEnv({})).toThrow(/DATABASE_URL/);
    expect(() => validateMigrationEnv({ DATABASE_URL: '' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('no filtra ni exige el resto del entorno: ignora variables ajenas', () => {
    const env = validateMigrationEnv({
      DATABASE_URL: 'postgres://u:p@db:5432/jin',
      ANTHROPIC_API_KEY: 'no-debe-aparecer',
    });
    expect(Object.keys(env)).toEqual(['DATABASE_URL']);
  });
});

describe('validateEnv (contrato del servidor, sin cambios)', () => {
  it('sigue exigiendo el entorno completo: DATABASE_URL sola NO alcanza para arrancar jin-core', () => {
    expect(() =>
      validateEnv({ DATABASE_URL: 'postgres://u:p@db:5432/jin' }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });
});

/** Entorno mínimo válido, sin el puente. */
const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@db:5432/jin',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  GEMINI_API_KEY: 'gemini-test',
  CANVAS_BASE_URL: 'https://canvas.instructure.com',
  CANVAS_API_TOKEN: 'canvas-test',
  TELEGRAM_BOT_TOKEN: '1:jin-test',
  TELEGRAM_OWNER_CHAT_ID: '4242',
  TELEGRAM_WEBHOOK_SECRET: 'webhook-test',
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GOOGLE_REFRESH_TOKEN: 'google-refresh',
  OPENAI_API_KEY: 'sk-openai-test',
  EXECUTOR_BASE_URL: 'http://jin-executor:3000',
  OWNER_PASSWORD_HASH: '$argon2id$fake',
  JWT_SECRET: 'j'.repeat(32),
  REDIS_URL: 'redis://redis:6379',
} as const;

describe('puente Claude↔owner: TELEGRAM_RELAY_BOT_TOKEN + RELAY_TOKEN', () => {
  it('sin ninguna de las dos, Jin arranca con el puente apagado', () => {
    const env = validateEnv({ ...BASE_ENV });

    expect(env.TELEGRAM_RELAY_BOT_TOKEN).toBeUndefined();
    expect(env.RELAY_TOKEN).toBeUndefined();
  });

  it('con las dos, el puente queda configurado', () => {
    const env = validateEnv({
      ...BASE_ENV,
      TELEGRAM_RELAY_BOT_TOKEN: '2:relay-test',
      RELAY_TOKEN: 'r'.repeat(64),
    });

    expect(env.RELAY_TOKEN).toBe('r'.repeat(64));
  });

  it('rechaza media configuración: bot sin token de API', () => {
    // Media configuración es peor que ninguna: el puente escucharía en
    // Telegram y nadie podría hablarle desde la VM.
    expect(() =>
      validateEnv({ ...BASE_ENV, TELEGRAM_RELAY_BOT_TOKEN: '2:relay-test' }),
    ).toThrow(/juntas, o ninguna/);
  });

  it('rechaza media configuración: token de API sin bot', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, RELAY_TOKEN: 'r'.repeat(64) }),
    ).toThrow(/juntas, o ninguna/);
  });

  it('exige un RELAY_TOKEN largo: no vale una contraseña corta', () => {
    expect(() =>
      validateEnv({
        ...BASE_ENV,
        TELEGRAM_RELAY_BOT_TOKEN: '2:relay-test',
        RELAY_TOKEN: 'corto',
      }),
    ).toThrow(/RELAY_TOKEN/);
  });

  it('el schema del migrador sigue pudiendo hacer .pick() pese al refine', () => {
    // Regresión: al colgar el `.refine()` del mismo schema del que
    // `MigrationEnvSchema` hace `.pick()`, zod lanzaba al IMPORTAR el módulo.
    // Ni `tsc` ni los tests del relay lo veían, pero Core moría al arrancar.
    expect(() =>
      validateMigrationEnv({ DATABASE_URL: 'postgres://u:p@db:5432/jin' }),
    ).not.toThrow();
  });
});
