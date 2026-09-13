import { describe, expect, it } from 'vitest';
import { classifyToolCall } from '../../hitl/classifier';
import { GOLDEN_SET } from './corpus';

// Tools reales `confirm` del registry (src/tools/registry.ts) -- se usa
// más de una para no depender de que el hallazgo sea específico a una
// sola tool.
const CONFIRM_TOOLS = [
  'sendEmail',
  'deleteCalendarEventFuture',
  'mergeAgentBranch',
] as const;

const HITL_ESCALATION_ENTRIES = GOLDEN_SET.filter(
  (e) => e.category === 'hitl-escalation',
);

describe('golden set — classifyToolCall es inmune a contenido hostil en los inputs', () => {
  // classifyToolCall (src/hitl/classifier.ts) deriva el hitlLevel SOLO
  // del registry -- el parámetro de inputs ni se lee. Este test prueba
  // eso como contrato verificado, no solo como comentario en el código.
  for (const tool of CONFIRM_TOOLS) {
    describe(`tool "${tool}"`, () => {
      it.each(HITL_ESCALATION_ENTRIES.map((e) => [e.id, e.payload] as const))(
        '%s: el nivel sigue siendo confirm sin importar el payload',
        (_id, payload) => {
          const decision = classifyToolCall(tool, {
            body: payload,
            hitlLevel: 'auto', // intento directo de override en el input
          });

          expect(decision.level).toBe('confirm');
          expect(decision.approvalsRequired).toBe(1);
        },
      );
    });
  }

  it('un input completamente vacío o el payload como input directo (no anidado) no cambian el nivel', () => {
    for (const tool of CONFIRM_TOOLS) {
      expect(classifyToolCall(tool, {}).level).toBe('confirm');
      expect(
        classifyToolCall(tool, HITL_ESCALATION_ENTRIES[0]?.payload).level,
      ).toBe('confirm');
    }
  });
});
