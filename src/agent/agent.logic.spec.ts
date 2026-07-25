import { describe, expect, it } from 'vitest';
import {
  buildToolCallKey,
  computeInputsHash,
  declarePlan,
  stringifyToolResult,
  updatePlanStep,
} from './agent.logic';
import { AgentPlanStepOutOfBoundsError } from './errors';

describe('declarePlan', () => {
  it('convierte una lista de strings en pasos "pending"', () => {
    const plan = declarePlan(['paso 1', 'paso 2']);
    expect(plan).toEqual({
      steps: [
        { description: 'paso 1', status: 'pending' },
        { description: 'paso 2', status: 'pending' },
      ],
    });
  });

  it('un plan vacío es válido (objetivo trivial, sin pasos)', () => {
    expect(declarePlan([])).toEqual({ steps: [] });
  });
});

describe('updatePlanStep', () => {
  const plan = declarePlan(['paso 1', 'paso 2']);

  it('actualiza el status del paso indicado, deja los demás intactos', () => {
    const updated = updatePlanStep(plan, 0, 'done');
    expect(updated.steps[0]).toEqual({ description: 'paso 1', status: 'done' });
    expect(updated.steps[1]).toEqual({
      description: 'paso 2',
      status: 'pending',
    });
  });

  it('agrega la nota cuando se provee (ej. motivo de un fallo)', () => {
    const updated = updatePlanStep(plan, 1, 'failed', 'la API devolvió 500');
    expect(updated.steps[1]).toEqual({
      description: 'paso 2',
      status: 'failed',
      note: 'la API devolvió 500',
    });
  });

  it('no muta el plan original (inmutable)', () => {
    updatePlanStep(plan, 0, 'done');
    expect(plan.steps[0]?.status).toBe('pending');
  });

  it('lanza AgentPlanStepOutOfBoundsError para un índice fuera de rango', () => {
    expect(() => updatePlanStep(plan, 5, 'done')).toThrow(
      AgentPlanStepOutOfBoundsError,
    );
    expect(() => updatePlanStep(plan, -1, 'done')).toThrow(
      AgentPlanStepOutOfBoundsError,
    );
  });
});

describe('buildToolCallKey', () => {
  it('la misma tool con los mismos args produce la misma clave', () => {
    expect(buildToolCallKey('listCalendarEvents', { maxResults: 5 })).toBe(
      buildToolCallKey('listCalendarEvents', { maxResults: 5 }),
    );
  });

  it('args distintos producen claves distintas (no se confunden reintentos con llamadas nuevas)', () => {
    expect(buildToolCallKey('listCalendarEvents', { maxResults: 5 })).not.toBe(
      buildToolCallKey('listCalendarEvents', { maxResults: 10 }),
    );
  });

  it('tools distintas con los mismos args producen claves distintas', () => {
    expect(buildToolCallKey('toolA', { x: 1 })).not.toBe(
      buildToolCallKey('toolB', { x: 1 }),
    );
  });
});

describe('computeInputsHash', () => {
  it('es determinístico para el mismo input', () => {
    expect(computeInputsHash({ a: 1 })).toBe(computeInputsHash({ a: 1 }));
  });

  it('no lanza con undefined/null', () => {
    expect(() => computeInputsHash(undefined)).not.toThrow();
    expect(() => computeInputsHash(null)).not.toThrow();
  });
});

describe('stringifyToolResult', () => {
  it('devuelve un string tal cual, sin volver a serializarlo', () => {
    expect(stringifyToolResult('ya es texto')).toBe('ya es texto');
  });

  it('serializa a JSON cualquier otro tipo', () => {
    expect(stringifyToolResult({ events: [] })).toBe('{"events":[]}');
    expect(stringifyToolResult(42)).toBe('42');
  });
});
