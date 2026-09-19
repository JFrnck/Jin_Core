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
