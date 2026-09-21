import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * La garantía central del puente (ADR 0012): una sesión de Claude Code puede
 * hablarle al owner, pero NO puede aprobar, rechazar ni tocar una acción
 * pendiente de Jin.
 *
 * Esto no se prueba con un caso de uso: se prueba estructuralmente. Si el
 * código que resuelve aprobaciones no está importado acá, no hay forma de
 * invocarlo — ni por error, ni por una inyección de prompt, ni porque alguien
 * añada un endpoint sin pensarlo. Este test falla en cuanto alguien cruza esa
 * línea, que es justo cuando hay que discutirlo.
 */

const RELAY_DIR = join(__dirname);

/** Módulos que le darían al puente poder sobre acciones reales. */
const FORBIDDEN_IMPORTS = [
  '../hitl/',
  '../hitl-policy/',
  '../agent/',
  '../audit/',
  '../executor-client/',
  '../integrations/',
  '../tools/',
];

function relaySourceFiles(): string[] {
  return readdirSync(RELAY_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map((file) => join(RELAY_DIR, file));
}

/**
 * Quita comentarios antes de comprobar nada. Sin esto el test mide la PROSA y
 * no el código: la primera versión falló porque el comentario del módulo
 * explica justamente que no importa `HitlModule`. Un test de seguridad que se
 * dispara con una palabra en un comentario entrena a ignorarlo.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf-8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '');
}

describe('aislamiento del puente Claude↔owner (ADR 0012)', () => {
  it('ningún archivo del módulo importa código que pueda aprobar acciones', () => {
    const offenders: string[] = [];

    for (const file of relaySourceFiles()) {
      const source = codeOf(file);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        if (source.includes(`from '${forbidden}`)) {
          offenders.push(`${file.split('/').pop()} → ${forbidden}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('el módulo no declara ninguna dependencia hacia HITL', () => {
    const moduleSource = codeOf(join(RELAY_DIR, 'relay.module.ts'));

    expect(moduleSource).not.toContain('HitlModule');
    expect(moduleSource).not.toContain('ApprovalExecutionService');
    expect(moduleSource).not.toContain('DualConfirmService');
    expect(moduleSource).not.toContain('AuditModule');
  });

  it('el controller no expone ninguna ruta de aprobación', () => {
    const controller = codeOf(join(RELAY_DIR, 'relay.controller.ts'));

    expect(controller).not.toMatch(/approve|reject|pending-approval/i);
    // Todo el controller vive bajo /api/relay: no puede montar otra ruta.
    expect(controller).toContain("@Controller('api/relay')");
  });

  it('el módulo se lee sin credenciales del owner: nunca toca el JWT ni la cookie de sesión', () => {
    for (const file of relaySourceFiles()) {
      const source = codeOf(file);
      expect(source).not.toContain('JwtService');
      expect(source).not.toContain('__Host-jin_session');
      expect(source).not.toContain('OWNER_PASSWORD_HASH');
    }
  });
});
