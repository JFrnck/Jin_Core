import { describe, expect, it } from 'vitest';
import type { HitlDecision, HitlLevel } from '../hitl/types';
import { HITL_LEVELS } from '../hitl/types';
import { listRegisteredTools } from '../tools/registry';
import { clampHours, parseModeCommand, relaxDecision } from './autonomy.logic';
import { AUTONOMY_MODES, requiresDualConfirm } from './autonomy.types';

function decisionAt(level: HitlLevel): HitlDecision {
  return {
    requestId: 'req-1',
    toolName: 'x',
    level,
    approvalsRequired:
      level === 'dual-confirm' ? 2 : level === 'confirm' ? 1 : 0,
    notifyAfterExecution: level === 'notify',
  };
}

describe('relaxDecision — matriz nivel × modo × marca (ADR 0010, BLUEPRINT §9.3)', () => {
  const PLAIN = {};
  const GUARDED = { guardedInSemiAuto: true };
  const HUMAN = { humanDecision: true };

  it('supervised: NUNCA cambia nada, sea cual sea el nivel o la marca', () => {
    for (const level of HITL_LEVELS) {
      for (const tool of [PLAIN, GUARDED, HUMAN, undefined]) {
        const d = decisionAt(level);
        expect(relaxDecision(d, 'supervised', tool)).toEqual({ decision: d });
      }
    }
  });

  it('dual-confirm NO se relaja en NINGÚN modo ni con ninguna marca (piso de seguridad, reglas #4 y #7)', () => {
    for (const mode of AUTONOMY_MODES) {
      for (const tool of [PLAIN, GUARDED, HUMAN, undefined]) {
        const d = decisionAt('dual-confirm');
        const r = relaxDecision(d, mode, tool);
        expect(r.decision.level).toBe('dual-confirm');
        expect(r.decision.approvalsRequired).toBe(2);
        expect(r.relaxedBy).toBeUndefined();
      }
    }
  });

  it('auto y notify ya son laxos: quedan idénticos en todos los modos', () => {
    for (const mode of AUTONOMY_MODES) {
      for (const level of ['auto', 'notify'] as const) {
        const d = decisionAt(level);
        expect(relaxDecision(d, mode, PLAIN)).toEqual({ decision: d });
      }
    }
  });

  it('humanDecision jamás se relaja, ni en modo automático', () => {
    for (const mode of AUTONOMY_MODES) {
      const d = decisionAt('confirm');
      const r = relaxDecision(d, mode, HUMAN);
      expect(r.decision.level).toBe('confirm');
      expect(r.relaxedBy).toBeUndefined();
    }
  });

  it('semi-auto: confirm normal pasa a notify (se ejecuta y avisa)', () => {
    const r = relaxDecision(decisionAt('confirm'), 'semi-auto', PLAIN);
    expect(r.decision).toMatchObject({
      level: 'notify',
      approvalsRequired: 0,
      notifyAfterExecution: true,
      relaxedBy: 'autonomy:semi-auto',
    });
    expect(r.relaxedBy).toBe('autonomy:semi-auto');
  });

  it('semi-auto: una tool guardedInSemiAuto CONSERVA confirm', () => {
    const r = relaxDecision(decisionAt('confirm'), 'semi-auto', GUARDED);
    expect(r.decision.level).toBe('confirm');
    expect(r.relaxedBy).toBeUndefined();
  });

  it('auto: TODO confirm pasa a notify, incluso lo guardedInSemiAuto (decisión del owner: el piso es dual-confirm)', () => {
    for (const tool of [PLAIN, GUARDED]) {
      const r = relaxDecision(decisionAt('confirm'), 'auto', tool);
      expect(r.decision.level).toBe('notify');
      expect(r.relaxedBy).toBe('autonomy:auto');
    }
  });

  it('nunca produce un nivel MÁS restrictivo ni mueve un dual-confirm: solo confirm -> notify', () => {
    for (const mode of AUTONOMY_MODES) {
      for (const level of HITL_LEVELS) {
        const out = relaxDecision(decisionAt(level), mode, PLAIN).decision
          .level;
        const changed = out !== level;
        expect(!changed || (level === 'confirm' && out === 'notify')).toBe(
          true,
        );
      }
    }
  });
});

describe('relaxDecision sobre el registry REAL (tool × modo) — tabla esperada explícita', () => {
  const byName = (name: string) =>
    listRegisteredTools().find((t) => t.name === name);

  function effective(
    name: string,
    mode: 'supervised' | 'semi-auto' | 'auto',
  ): HitlLevel {
    const tool = byName(name);
    if (!tool) throw new Error(`tool ${name} no registrada`);
    return relaxDecision(decisionAt(tool.hitlLevel), mode, tool).decision.level;
  }

  // [tool, supervised, semi-auto, auto] — la decisión del owner (2026-09-19)
  // escrita a mano, no derivada de las marcas: si alguien cambia una marca del
  // registry, este test falla y obliga a revisarlo.
  const EXPECTED: ReadonlyArray<
    readonly [string, HitlLevel, HitlLevel, HitlLevel]
  > = [
    // git / merges, correos, borrar eventos futuros: siguen pidiendo en semi-auto
    ['mergeAgentBranch', 'confirm', 'confirm', 'notify'],
    ['sendEmail', 'confirm', 'confirm', 'notify'],
    ['deleteCalendarEventFuture', 'confirm', 'confirm', 'notify'],
    // el resto de los confirm: se ejecutan y avisan en semi-auto y auto
    ['runCode', 'confirm', 'notify', 'notify'],
    ['startPreviewService', 'confirm', 'notify', 'notify'],
    // decisión humana: jamás
    ['resolveAgentConflict', 'confirm', 'confirm', 'confirm'],
    // ya laxos: sin cambios
    ['readEmails', 'auto', 'auto', 'auto'],
    ['createCalendarEvent', 'notify', 'notify', 'notify'],
    ['searchCorpus', 'auto', 'auto', 'auto'],
  ];

  it.each(EXPECTED)(
    '%s -> supervised=%s · semi-auto=%s · auto=%s',
    (name, sup, semi, auto) => {
      expect(effective(name, 'supervised')).toBe(sup);
      expect(effective(name, 'semi-auto')).toBe(semi);
      expect(effective(name, 'auto')).toBe(auto);
    },
  );

  it('cualquier tool dual-confirm (hoy ninguna en el registry; mañana git force-push) no cambia en ningún modo', () => {
    // Se ejerce con decisiones dual-confirm SINTÉTICAS sobre cada tool real:
    // el barrido sobre `hitlLevel === 'dual-confirm'` sería hoy un bucle vacío.
    for (const tool of listRegisteredTools()) {
      for (const mode of AUTONOMY_MODES) {
        const out = relaxDecision(decisionAt('dual-confirm'), mode, tool)
          .decision.level;
        expect(out).toBe('dual-confirm');
      }
    }
  });
});

describe('requiresDualConfirm', () => {
  it.each([
    ['supervised', 'supervised', false],
    ['supervised', 'semi-auto', true],
    ['supervised', 'auto', true],
    ['semi-auto', 'supervised', false],
    ['semi-auto', 'semi-auto', true], // RENOVAR también baja la protección por más tiempo
    ['semi-auto', 'auto', true],
    ['auto', 'supervised', false],
    ['auto', 'semi-auto', false], // más restrictivo: inmediato
    ['auto', 'auto', true],
  ] as const)('%s -> %s : dual-confirm=%s', (current, target, expected) => {
    expect(requiresDualConfirm(current, target)).toBe(expected);
  });
});

describe('clampHours', () => {
  const limits = { defaultHours: 4, maxHours: 24 };
  it('usa el default si no se pide nada', () =>
    expect(clampHours(undefined, limits)).toBe(4));
  it('respeta un valor dentro del rango', () =>
    expect(clampHours(10, limits)).toBe(10));
  it('acota al máximo', () => expect(clampHours(999, limits)).toBe(24));
  it('acota el mínimo a 1 h', () => expect(clampHours(0, limits)).toBe(1));
});

describe('parseModeCommand (/mode de Telegram)', () => {
  it('sin argumentos = estado', () =>
    expect(parseModeCommand('')).toEqual({ kind: 'status' }));
  it('undefined = estado', () =>
    expect(parseModeCommand(undefined)).toEqual({ kind: 'status' }));
  it.each([
    ['safe', 'supervised'],
    ['seguro', 'supervised'],
    ['semi', 'semi-auto'],
    ['semi-auto', 'semi-auto'],
    ['auto', 'auto'],
    ['AUTOMÁTICO', 'auto'],
  ])('"%s" -> %s', (arg, mode) => {
    expect(parseModeCommand(arg)).toEqual({ kind: 'change', mode });
  });
  it('acepta horas', () => {
    expect(parseModeCommand('auto 2')).toEqual({
      kind: 'change',
      mode: 'auto',
      hours: 2,
    });
  });
  it.each([
    'banana',
    'auto abc',
    'auto 0',
    'auto -3',
    'auto 1.5',
    'auto 2 extra',
    'semi 4 6',
  ])('entrada inválida "%s" -> invalid (nunca adivina un cambio)', (arg) => {
    expect(parseModeCommand(arg)).toEqual({ kind: 'invalid' });
  });
});
