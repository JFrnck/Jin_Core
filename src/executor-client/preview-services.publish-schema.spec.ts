import { describe, expect, it } from 'vitest';
import { PublishPreviewSchema } from './preview-services.controller';

// Valores de ejemplo construidos en ejecución (nada con forma de credencial en el repo).
const VALUE = `p${'3141592653'.repeat(3)}`;
const BASE = {
  files: { 'index.html': '<h1>hola</h1>' },
  ttlSeconds: 3600,
};

describe('PublishPreviewSchema (POST /api/preview-services)', () => {
  it('acepta las opciones de un backend: template node, db, mailEgress, secrets y env', () => {
    const result = PublishPreviewSchema.safeParse({
      ...BASE,
      template: 'node',
      db: 'postgres',
      mailEgress: true,
      secrets: ['brevo'],
      env: { MI_CLAVE: VALUE },
    });
    expect(result.success).toBe(true);
  });

  it('sin las opciones nuevas sigue valiendo (template static, como siempre)', () => {
    expect(
      PublishPreviewSchema.safeParse({ ...BASE, template: 'static' }).success,
    ).toBe(true);
  });

  it('rechaza db desconocida, template desconocido y secretos con nombre inválido', () => {
    expect(
      PublishPreviewSchema.safeParse({ ...BASE, db: 'mysql' }).success,
    ).toBe(false);
    expect(
      PublishPreviewSchema.safeParse({ ...BASE, template: 'vite' }).success,
    ).toBe(false);
    expect(
      PublishPreviewSchema.safeParse({ ...BASE, secrets: ['Brevo!'] }).success,
    ).toBe(false);
  });

  it('env: nombres reservados o mal formados se rechazan y el error NO contiene el valor', () => {
    const result = PublishPreviewSchema.safeParse({
      ...BASE,
      env: { PORT: VALUE, malo: VALUE, OK_NAME: VALUE },
    });

    expect(result.success).toBe(false);
    const text = JSON.stringify(result.error?.issues);
    expect(text).toContain('PORT');
    expect(text).toContain('malo');
    expect(text).not.toContain(VALUE);
  });

  it('env: un valor que no es texto se rechaza sin repetirlo', () => {
    const result = PublishPreviewSchema.safeParse({
      ...BASE,
      env: { MI_CLAVE: { x: VALUE } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(VALUE);
  });

  it('el esquema sigue siendo estricto: un campo desconocido se rechaza', () => {
    expect(PublishPreviewSchema.safeParse({ ...BASE, rm: true }).success).toBe(
      false,
    );
  });
});
