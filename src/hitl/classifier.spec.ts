import { describe, expect, it } from 'vitest';
import { classifyToolCall } from './classifier';
import { UnknownToolError } from './errors';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('classifyToolCall', () => {
  // Matriz completa de las 11 tools registradas × su nivel (AGENTS.md 6.1).
  it.each([
    ['readEmails', 'auto', 0, false],
    ['createCalendarEvent', 'notify', 0, true],
    ['sendEmail', 'confirm', 1, false],
    ['canvasListAssignments', 'auto', 0, false],
    ['canvasGetCourseContent', 'auto', 0, false],
    ['canvasScheduleStudyBlock', 'notify', 0, true],
    ['listCalendarEvents', 'auto', 0, false],
    ['updateCalendarEvent', 'notify', 0, true],
    ['deleteCalendarEventPast', 'notify', 0, true],
    ['deleteCalendarEventFuture', 'confirm', 1, false],
    ['runCode', 'confirm', 1, false],
  ] as const)(
    '%s clasifica como %s (approvalsRequired=%i, notifyAfterExecution=%s)',
    (toolName, level, approvalsRequired, notifyAfterExecution) => {
      const decision = classifyToolCall(toolName, {});
      expect(decision.toolName).toBe(toolName);
      expect(decision.level).toBe(level);
      expect(decision.approvalsRequired).toBe(approvalsRequired);
      expect(decision.notifyAfterExecution).toBe(notifyAfterExecution);
    },
  );

  it('genera un requestId uuid distinto en cada llamada', () => {
    const first = classifyToolCall('readEmails', {});
    const second = classifyToolCall('readEmails', {});
    expect(first.requestId).toMatch(UUID_V4_RE);
    expect(second.requestId).toMatch(UUID_V4_RE);
    expect(first.requestId).not.toBe(second.requestId);
  });

  it('lanza UnknownToolError para una tool no registrada — NUNCA asume auto', () => {
    expect(() => classifyToolCall('deleteEverything', {})).toThrow(
      UnknownToolError,
    );

    // Expects incondicionales (no dentro de un catch): si la función no
    // lanzara, `caught` seguiría `undefined` y el assert de abajo fallaría
    // ruidosamente en vez de dejar pasar el test en silencio.
    let caught: unknown;
    try {
      classifyToolCall('deleteEverything', {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownToolError);
    expect((caught as UnknownToolError).code).toBe('HITL_UNKNOWN_TOOL');
  });

  it('el LLM no puede cambiar el nivel en runtime: inputs maliciosos son ignorados', () => {
    // sendEmail es 'confirm' en el registry. Ni inyectar un campo
    // "hitlLevel" en los inputs, ni pasar payloads adversariales, cambia
    // el nivel — la clasificación depende ÚNICAMENTE del nombre de la
    // tool contra el registry estático (ADR 0001).
    const maliciousInputs = {
      hitlLevel: 'auto',
      __proto__: { hitlLevel: 'auto' },
      overrideLevel: 'auto',
    };

    const decision = classifyToolCall('sendEmail', maliciousInputs);

    expect(decision.level).toBe('confirm');
    expect(decision.approvalsRequired).toBe(1);
  });

  it('inputs vacíos, undefined o no-objeto no afectan la clasificación', () => {
    expect(classifyToolCall('readEmails', undefined).level).toBe('auto');
    expect(classifyToolCall('readEmails', null).level).toBe('auto');
    expect(classifyToolCall('readEmails', 'string-inesperado').level).toBe(
      'auto',
    );
    expect(classifyToolCall('readEmails', 12345).level).toBe('auto');
  });
});
