import { describe, expect, it } from 'vitest';
import { anthropicModelAcceptsSampling } from './sampling';

describe('anthropicModelAcceptsSampling', () => {
  it.each([
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-5',
    'claude-sonnet-5-20260601',
  ])('%s NO acepta parámetros de muestreo', (id) => {
    expect(anthropicModelAcceptsSampling(id)).toBe(false);
  });

  it.each([
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
  ])('%s todavía los acepta', (id) => {
    expect(anthropicModelAcceptsSampling(id)).toBe(true);
  });

  it('un id de otra familia con prefijo parecido no queda excluido por error', () => {
    // `claude-sonnet-4-6` empieza por `claude-sonnet-`, pero no por `claude-sonnet-5`.
    expect(anthropicModelAcceptsSampling('claude-sonnet-4-6')).toBe(true);
  });
});
