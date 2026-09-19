import { describe, expect, it } from 'vitest';
import {
  sanitizeForIndexing,
  wrapUntrustedContent,
} from '../injection-sanitizer';
import { GOLDEN_SET } from './corpus';

// Nonce de sesión "real" usado en la mayoría de los casos. Para
// `fake-nonce` se corre una segunda vez con NONCE_B (ver abajo) — la
// garantía no depende de que el atacante desconozca el nonce, depende
// del escapado (ADR 0004, Consecuencia #1).
const NONCE_A = '0123456789abcdef';
const NONCE_B = 'fedcba9876543210';

// hitl-escalation y fake-approval no pasan por el sanitizer -- viven en
// corpus-classifier.spec.ts y agent-pipeline.spec.ts respectivamente.
const SANITIZER_ENTRIES = GOLDEN_SET.filter(
  (e) => e.category !== 'hitl-escalation' && e.category !== 'fake-approval',
);

// Invariante estructural, verificable sin importar el contenido del
// payload: el interior (entre el tag de apertura real y el de cierre
// real) nunca contiene un `<`/`>` ASCII crudo, y el cierre real aparece
// exactamente una vez, al final. Si el payload intentó fabricar su
// propio cierre, ese intento quedó escapado y no genera una segunda
// aparición literal.
describe('golden set — wrapUntrustedContent nunca deja escapar un cierre real', () => {
  it.each(SANITIZER_ENTRIES.map((e) => [e.id, e.payload] as const))(
    '%s',
    (_id, payload) => {
      const wrapped = wrapUntrustedContent(payload, 'test-source', NONCE_A);
      const closeTag = `</untrusted_content_${NONCE_A}>`;
      const openTagEnd = wrapped.indexOf('>') + 1;
      const interior = wrapped.slice(
        openTagEnd,
        wrapped.length - closeTag.length,
      );

      expect(wrapped.startsWith(`<untrusted_content_${NONCE_A} source="`)).toBe(
        true,
      );
      expect(wrapped.endsWith(closeTag)).toBe(true);
      expect(interior).not.toMatch(/[<>]/);
      expect(wrapped.indexOf(closeTag)).toBe(wrapped.lastIndexOf(closeTag));
    },
  );

  // fake-nonce en particular: repetir con un nonce DISTINTO al que el
  // payload intenta adivinar/fabricar, para dejar explícito que la
  // garantía no depende de qué nonce elija el atacante (ADR 0004,
  // Consecuencia #1: el escape HTML por sí solo ya neutraliza el ataque).
  const fakeNonceEntries = SANITIZER_ENTRIES.filter(
    (e) => e.category === 'fake-nonce',
  );
  it.each(fakeNonceEntries.map((e) => [e.id, e.payload] as const))(
    '%s (con un segundo nonce de sesión distinto)',
    (_id, payload) => {
      const wrapped = wrapUntrustedContent(payload, 'test-source', NONCE_B);
      const closeTag = `</untrusted_content_${NONCE_B}>`;
      const openTagEnd = wrapped.indexOf('>') + 1;
      const interior = wrapped.slice(
        openTagEnd,
        wrapped.length - closeTag.length,
      );

      expect(wrapped.startsWith(`<untrusted_content_${NONCE_B} source="`)).toBe(
        true,
      );
      expect(wrapped.endsWith(closeTag)).toBe(true);
      expect(interior).not.toMatch(/[<>]/);
      expect(wrapped.indexOf(closeTag)).toBe(wrapped.lastIndexOf(closeTag));
    },
  );
});

// Consumidor real: src/memory/memory.service.ts. El output nunca
// contiene un `<`/`>` ASCII crudo, sin importar cuántos tuviera el
// payload original.
describe('golden set — sanitizeForIndexing nunca deja un `<`/`>` crudo', () => {
  it.each(SANITIZER_ENTRIES.map((e) => [e.id, e.payload] as const))(
    '%s',
    (_id, payload) => {
      expect(sanitizeForIndexing(payload)).not.toMatch(/[<>]/);
    },
  );
});

describe('golden set — cobertura del corpus', () => {
  it('tiene ~50 entradas y ninguna categoría vacía', () => {
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(48);
    const categories = new Set(GOLDEN_SET.map((e) => e.category));
    expect(categories.size).toBe(8);
  });

  it('todos los ids son únicos', () => {
    const ids = GOLDEN_SET.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
