import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { EnvVaultService } from './env-vault.service';

// Construido en ejecución (nada con forma de credencial en el repo).
const VALUE = `h${'1029384756'.repeat(3)}`;
const ENV = { MI_CLAVE: VALUE };

describe('EnvVaultService', () => {
  it('take lee y BORRA: los valores salen una sola vez', () => {
    const vault = new EnvVaultService();
    vault.put('r1', ENV);

    expect(vault.has('r1')).toBe(true);
    expect(vault.take('r1')).toEqual(ENV);
    expect(vault.take('r1')).toBeUndefined();
    expect(vault.has('r1')).toBe(false);
  });

  it('lo que sale es una copia: modificarla no cambia lo guardado, y lo entregado no se puede alterar desde fuera', () => {
    const vault = new EnvVaultService();
    const original = { A: '1' };
    vault.put('r1', original);
    original.A = 'cambiado';

    expect(vault.take('r1')).toEqual({ A: '1' });
  });

  it('un valor vencido ya no se entrega (aprobación expirada)', () => {
    const vault = new EnvVaultService();
    const now = 1_000_000;
    vault.put('r1', ENV, 60_000, now);

    expect(vault.has('r1', now + 59_000)).toBe(true);
    expect(vault.take('r1', now + 61_000)).toBeUndefined();
  });

  it('una requestId desconocida (p. ej. tras un reinicio de Core) devuelve undefined', () => {
    expect(new EnvVaultService().take('nunca-existio')).toBeUndefined();
  });

  it('tiene tope: demasiadas pendientes a la vez se rechazan; las vencidas se limpian solas', () => {
    const vault = new EnvVaultService();
    const now = 5_000_000;
    for (let i = 0; i < 50; i++) vault.put(`r${i}`, ENV, 1_000, now);
    expect(() => vault.put('extra', ENV, 1_000, now)).toThrow(/demasiadas/);
    // Pasado el vencimiento se purga y vuelve a caber.
    expect(() => vault.put('extra', ENV, 1_000, now + 2_000)).not.toThrow();
  });

  it('NUNCA muestra valores: ni al serializarlo, ni al imprimirlo, ni al inspeccionarlo', () => {
    const vault = new EnvVaultService();
    vault.put('r1', ENV);

    expect(JSON.stringify(vault)).toBe('{}');
    expect(JSON.stringify({ vault })).not.toContain(VALUE);
    expect(inspect(vault, { depth: 10, showHidden: true })).not.toContain(
      VALUE,
    );
    expect(String(inspect(vault))).toContain('valores ocultos');
  });

  it('discard borra sin leer', () => {
    const vault = new EnvVaultService();
    vault.put('r1', ENV);
    vault.discard('r1');
    expect(vault.has('r1')).toBe(false);
  });
});
