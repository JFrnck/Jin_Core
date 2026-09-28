import { describe, expect, it } from 'vitest';
import {
  ExecTerminalSchema,
  ExposeTerminalSchema,
  ImportTerminalSchema,
  StartTerminalSchema,
  WorkspaceIdSchema,
} from './terminal.schemas';

describe('schemas de la terminal', () => {
  it('abrir: TTL entre 5 min y 4 h, sin campos extra, archivos opcionales', () => {
    expect(StartTerminalSchema.safeParse({ ttlSeconds: 3600 }).success).toBe(
      true,
    );
    expect(StartTerminalSchema.safeParse({ ttlSeconds: 299 }).success).toBe(
      false,
    );
    expect(
      StartTerminalSchema.safeParse({ ttlSeconds: 4 * 3600 + 1 }).success,
    ).toBe(false);
    expect(
      StartTerminalSchema.safeParse({ ttlSeconds: 3600, extra: 1 }).success,
    ).toBe(false);
  });

  it('abrir e importar: 50 archivos, 256 KB y rutas seguras', () => {
    const many = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`f${i}`, 'x']),
    );
    expect(
      StartTerminalSchema.safeParse({ ttlSeconds: 3600, files: many }).success,
    ).toBe(false);
    expect(
      ImportTerminalSchema.safeParse({
        files: { 'a.txt': 'x'.repeat(256 * 1024) },
      }).success,
    ).toBe(false);
    for (const path of ['../x', '/etc/passwd', 'a/../../b']) {
      expect(
        ImportTerminalSchema.safeParse({ files: { [path]: 'x' } }).success,
      ).toBe(false);
    }
  });

  it('comando: entre 1 y 4096 caracteres, timeout hasta 600 s', () => {
    expect(ExecTerminalSchema.safeParse({ command: 'ls' }).success).toBe(true);
    expect(ExecTerminalSchema.safeParse({ command: '' }).success).toBe(false);
    expect(
      ExecTerminalSchema.safeParse({ command: 'x'.repeat(4097) }).success,
    ).toBe(false);
    expect(
      ExecTerminalSchema.safeParse({ command: 'ls', timeoutSeconds: 601 })
        .success,
    ).toBe(false);
  });

  it('publicar: dist por defecto y un directorio que no escapa', () => {
    expect(ExposeTerminalSchema.parse({}).dir).toBe('dist');
    expect(ExposeTerminalSchema.safeParse({ dir: '../etc' }).success).toBe(
      false,
    );
  });

  it('id de proyecto: un UUID cualquiera, normalizado a minúsculas; cualquier otra cosa se rechaza', () => {
    const upper = '11111111-1111-4111-8111-111111111111'.toUpperCase();
    expect(WorkspaceIdSchema.parse(upper)).toBe(upper.toLowerCase());
    for (const bad of ['no-es-un-uuid', '../etc/passwd', '', '12345']) {
      expect(WorkspaceIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});
