import { describe, expect, it } from 'vitest';
import {
  CreateSnapshotSchema,
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_MAX_TOTAL_BYTES,
  snapshotBytes,
} from './project-snapshot.logic';

const ok = { name: 'Reservas', files: { 'index.html': '<h1>x</h1>' } };
const messages = (input: unknown): string => {
  const result = CreateSnapshotSchema.safeParse(input);
  return result.success
    ? ''
    : result.error.issues.map((issue) => issue.message).join(' | ');
};

describe('CreateSnapshotSchema', () => {
  it('acepta un proyecto normal con su configuración (solo nombres de variables)', () => {
    const result = CreateSnapshotSchema.safeParse({
      ...ok,
      note: 'terminado',
      config: {
        template: 'node',
        database: 'sqlite',
        mailEgress: true,
        ttlSeconds: 14400,
        envNames: ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL'],
      },
    });
    expect(result.success).toBe(true);
  });

  it('rechaza valores de variables: la configuración es estricta', () => {
    expect(
      CreateSnapshotSchema.safeParse({
        ...ok,
        config: {
          template: 'node',
          mailEgress: false,
          ttlSeconds: 3600,
          envNames: [],
          env: { A: '1' },
        },
      }).success,
    ).toBe(false);
    expect(
      CreateSnapshotSchema.safeParse({
        ...ok,
        config: {
          template: 'node',
          mailEgress: false,
          ttlSeconds: 3600,
          envNames: ['minuscula'],
        },
      }).success,
    ).toBe(false);
  });

  it('rechaza archivos que parecen secretos nombrándolos, sin repetir su contenido', () => {
    const content = ['no', 'repetir', String(Math.random())].join('-');
    const message = messages({
      ...ok,
      files: { ...ok.files, '.env': content, 'k/server.key': content },
    });
    expect(message).toContain('.env');
    expect(message).toContain('k/server.key');
    expect(message).not.toContain(content);
  });

  it('valida rutas, cantidad y tamaño', () => {
    expect(messages({ ...ok, files: { '../x': 'a' } })).toContain(
      'Rutas no válidas',
    );
    expect(messages({ ...ok, files: { '/abs': 'a' } })).toContain(
      'Rutas no válidas',
    );
    expect(messages({ ...ok, files: {} })).toContain('entre 1 y');
    const many = Object.fromEntries(
      Array.from({ length: SNAPSHOT_MAX_FILES + 1 }, (_, i) => [
        `f${i}.txt`,
        'x',
      ]),
    );
    expect(messages({ ...ok, files: many })).toContain('entre 1 y');
    expect(
      messages({
        ...ok,
        files: { 'a.txt': 'x'.repeat(SNAPSHOT_MAX_TOTAL_BYTES + 1) },
      }),
    ).toContain('supera');
    expect(messages({ ...ok, name: '   ' })).not.toBe('');
  });

  it('cuenta bytes UTF-8, no caracteres', () => {
    expect(snapshotBytes({ 'a.txt': 'ñ' })).toBe(2);
  });
});
