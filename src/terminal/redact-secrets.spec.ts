import { describe, expect, it } from 'vitest';
import { auditPreview, redactSecrets } from './redact-secrets';

const TOKEN = 'sk-ant-oat01-AbCdEf0123456789_-xyzXYZ0123456789';

describe('redactSecrets', () => {
  it('reemplaza un token de Anthropic donde esté', () => {
    expect(redactSecrets(`echo ${TOKEN}`)).toBe('echo sk-ant-[omitido]');
    expect(redactSecrets(`a ${TOKEN} b ${TOKEN} c`)).toBe(
      'a sk-ant-[omitido] b sk-ant-[omitido] c',
    );
  });

  it.each([
    [
      `export CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`,
      'export CLAUDE_CODE_OAUTH_TOKEN=[omitido]',
    ],
    [
      `CLAUDE_CODE_OAUTH_TOKEN="${TOKEN}" claude`,
      'CLAUDE_CODE_OAUTH_TOKEN=[omitido] claude',
    ],
    [`ANTHROPIC_API_KEY='${TOKEN}'`, 'ANTHROPIC_API_KEY=[omitido]'],
    [
      'export ANTHROPIC_AUTH_TOKEN = un-valor-cualquiera',
      'export ANTHROPIC_AUTH_TOKEN = [omitido]',
    ],
  ])(
    'redacta la asignación de una variable de credenciales: %s',
    (input, expected) => {
      expect(redactSecrets(input)).toBe(expected);
    },
  );

  it('no toca texto normal ni variables que no son credenciales', () => {
    for (const text of [
      'npm install',
      'export PATH=/usr/bin',
      'echo sk-ant',
      'ls -la',
      'echo TOKEN',
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

describe('auditPreview', () => {
  it('redacta ANTES de cortar: un token que atraviesa el límite no queda a medias y legible', () => {
    const padding = 'x'.repeat(100);
    const line = `${padding} ${TOKEN}`;
    // Sin redactar primero, los 120 primeros caracteres tendrían 19 del token.
    expect(line.slice(0, 120)).toContain('sk-ant-oat01-');
    const preview = auditPreview(line, 120);
    expect(preview).not.toContain('sk-ant-oat');
    expect(preview).not.toContain('AbCdEf');
    expect(preview.length).toBeLessThanOrEqual(120);
  });

  it('normaliza espacios, recorta y respeta el largo', () => {
    expect(auditPreview('  npm   run\n\tdev  ', 120)).toBe('npm run dev');
    expect(auditPreview('a'.repeat(300), 120)).toHaveLength(120);
  });
});
