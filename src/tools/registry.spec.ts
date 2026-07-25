import { describe, expect, it } from 'vitest';
import {
  getToolDefinition,
  listRegisteredTools,
  type ToolDefinition,
} from './registry';

describe('registry', () => {
  it('lista las 10 tools registradas (Fase 2.2 + Fase 3.1 Canvas + Fase 4.2 Calendar) con su nivel correcto', () => {
    const tools = listRegisteredTools();
    expect(tools).toHaveLength(10);
    expect(tools.find((t) => t.name === 'readEmails')?.hitlLevel).toBe('auto');
    expect(tools.find((t) => t.name === 'createCalendarEvent')?.hitlLevel).toBe(
      'notify',
    );
    expect(tools.find((t) => t.name === 'sendEmail')?.hitlLevel).toBe(
      'confirm',
    );
    expect(
      tools.find((t) => t.name === 'canvasListAssignments')?.hitlLevel,
    ).toBe('auto');
    expect(
      tools.find((t) => t.name === 'canvasGetCourseContent')?.hitlLevel,
    ).toBe('auto');
    expect(
      tools.find((t) => t.name === 'canvasScheduleStudyBlock')?.hitlLevel,
    ).toBe('notify');
    expect(tools.find((t) => t.name === 'listCalendarEvents')?.hitlLevel).toBe(
      'auto',
    );
    expect(tools.find((t) => t.name === 'updateCalendarEvent')?.hitlLevel).toBe(
      'notify',
    );
    expect(
      tools.find((t) => t.name === 'deleteCalendarEventPast')?.hitlLevel,
    ).toBe('notify');
    expect(
      tools.find((t) => t.name === 'deleteCalendarEventFuture')?.hitlLevel,
    ).toBe('confirm');
  });

  it('las 10 tools traen un inputSchema tipo objeto (Fase 5.1: requerido para tool-use)', () => {
    const tools = listRegisteredTools();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeTypeOf('object');
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('getToolDefinition devuelve undefined para una tool no registrada', () => {
    expect(getToolDefinition('deleteEverything')).toBeUndefined();
  });

  it('el registry está Object.freeze()-ado: mutar en runtime lanza TypeError', () => {
    // Cast explícito y documentado (no un `any` a ciegas): el tipo público
    // es readonly por diseño; este test verifica que además está
    // realmente congelado en runtime, no solo tipado como tal.
    const tools = listRegisteredTools() as ToolDefinition[];
    expect(() =>
      tools.push({
        name: 'x',
        hitlLevel: 'auto',
        description: '',
        inputSchema: { type: 'object', properties: {} },
      }),
    ).toThrow(TypeError);
  });
});
