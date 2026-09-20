import { describe, expect, it } from 'vitest';
import {
  formatMorningAlert,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from './morning-alert.format';

describe('formatMorningAlert (Fase 9.4)', () => {
  it('summary: incluye el resumen real', () => {
    const text = formatMorningAlert({
      kind: 'summary',
      ranAt: '2026-09-20T05:00:00.000Z',
      summaryMarkdown: '- Lab 1 vence hoy',
    });
    expect(text).toContain('prioridades de hoy');
    expect(text).toContain('- Lab 1 vence hoy');
  });

  it('failed: dice explícitamente que falló y por qué (nunca un resumen vacío)', () => {
    const text = formatMorningAlert({
      kind: 'failed',
      ranAt: '2026-09-20T05:00:00.000Z',
      error: 'canvas 503',
    });
    expect(text).toContain('FALLÓ');
    expect(text).toContain('canvas 503');
    expect(text).not.toContain('prioridades de hoy (análisis');
  });

  it('missing: dice explícitamente que no se ejecutó', () => {
    const text = formatMorningAlert({ kind: 'missing' });
    expect(text).toContain('NO se ejecutó');
  });

  it('trunca al límite de Telegram sin perder el aviso de truncado', () => {
    const text = formatMorningAlert({
      kind: 'summary',
      ranAt: '2026-09-20T05:00:00.000Z',
      summaryMarkdown: 'a'.repeat(10_000),
    });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(text.endsWith('(resumen truncado)')).toBe(true);
  });

  it('no altera un resumen corto', () => {
    const text = formatMorningAlert({
      kind: 'summary',
      ranAt: '2026-09-20T05:00:00.000Z',
      summaryMarkdown: 'corto',
    });
    expect(text).not.toContain('truncado');
  });
});
