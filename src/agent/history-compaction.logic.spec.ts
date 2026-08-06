import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '../model-provider/model-provider.types';
import {
  estimateMessagesTokens,
  findTurnStartIndices,
  planHistoryCompaction,
  renderMessagesAsTranscript,
} from './history-compaction.logic';

function turn(userText: string, assistantText: string): ModelMessage[] {
  return [
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText },
  ];
}

function toolLoopTurn(userText: string, assistantText: string): ModelMessage[] {
  // Mismo shape que produce AgentService.runTurn dentro de una tanda con
  // tool calls: el `tool_result` intermedio también llega con
  // `role:'user'`, pero `content` es un array, no un objective nuevo.
  return [
    { role: 'user', content: userText },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          toolCall: { id: 't1', name: 'readEmails', input: {} },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: 't1', output: 'ok' }],
    },
    { role: 'assistant', content: assistantText },
  ];
}

describe('findTurnStartIndices', () => {
  it('cuenta solo los role:user con content string como inicio de turno', () => {
    const messages = toolLoopTurn('primer objective', 'respuesta 1').concat(
      turn('segundo objective', 'respuesta 2'),
    );

    // índice 0 (primer objective) y índice 4 (segundo objective) — el
    // tool_result intermedio en índice 2 (role:user, content array) NO
    // cuenta como un tercer turno.
    expect(findTurnStartIndices(messages)).toEqual([0, 4]);
  });

  it('array vacío si no hay ningún mensaje', () => {
    expect(findTurnStartIndices([])).toEqual([]);
  });
});

describe('estimateMessagesTokens', () => {
  it('suma la estimación de cada mensaje, sea content string o bloques', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'a'.repeat(40) }, // ~10 tokens
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'b'.repeat(40) }],
      }, // JSON.stringify agrega overhead, pero > 0
    ];

    expect(estimateMessagesTokens(messages)).toBeGreaterThan(10);
  });

  it('cero para un array vacío', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});

describe('planHistoryCompaction', () => {
  it('undefined si el historial está bajo el umbral de tokens, sin importar cuántos turnos haya', () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      turn(`objective ${i}`, `respuesta ${i}`),
    ).flat();

    const plan = planHistoryCompaction(messages, {
      maxHistoryTokens: 1_000_000,
      preserveLastTurns: 2,
    });

    expect(plan).toBeUndefined();
  });

  it('undefined si supera el umbral pero no hay más turnos que preserveLastTurns — nada que comprimir sin violar el piso', () => {
    const messages = Array.from({ length: 3 }, (_, i) =>
      turn(`objective ${i} `.repeat(500), `respuesta ${i}`.repeat(500)),
    ).flat();

    const plan = planHistoryCompaction(messages, {
      maxHistoryTokens: 10,
      preserveLastTurns: 5,
    });

    expect(plan).toBeUndefined();
  });

  it('comprime todo lo anterior al piso de preserveLastTurns cuando se supera el umbral', () => {
    const bigTurn = (i: number) =>
      turn(
        `objective largo ${i} `.repeat(200),
        `respuesta larga ${i}`.repeat(200),
      );
    const messages = Array.from({ length: 8 }, (_, i) => bigTurn(i)).flat();

    const plan = planHistoryCompaction(messages, {
      maxHistoryTokens: 10,
      preserveLastTurns: 3,
    });

    expect(plan).toBeDefined();
    // Los últimos 3 turnos (6 mensajes: user+assistant × 3) quedan intactos.
    expect(plan?.toPreserve).toHaveLength(6);
    expect(plan?.toPreserve).toEqual(messages.slice(-6));
    // Todo lo anterior (5 turnos = 10 mensajes) va al tramo a comprimir.
    expect(plan?.toCompact).toHaveLength(10);
    expect(plan?.toCompact).toEqual(messages.slice(0, 10));
  });

  it('el turno actual (con tool calls) nunca queda en el tramo a comprimir cuando preserveLastTurns >= 1', () => {
    const oldTurns = Array.from({ length: 6 }, (_, i) =>
      turn(`viejo ${i} `.repeat(300), `respuesta vieja ${i}`.repeat(300)),
    ).flat();
    const currentTurn = toolLoopTurn(
      'objective actual con tool calls',
      'respuesta final del turno actual',
    );
    const messages = [...oldTurns, ...currentTurn];

    const plan = planHistoryCompaction(messages, {
      maxHistoryTokens: 10,
      preserveLastTurns: 1,
    });

    expect(plan).toBeDefined();
    expect(plan?.toPreserve).toEqual(currentTurn);
    expect(plan?.toCompact).toEqual(oldTurns);
  });
});

describe('renderMessagesAsTranscript', () => {
  it('formatea mensajes de texto plano como "Rol: contenido"', () => {
    const messages = turn('¿qué hora es?', 'Son las 10am.');

    expect(renderMessagesAsTranscript(messages)).toBe(
      'Usuario: ¿qué hora es?\nJin: Son las 10am.',
    );
  });

  it('aplana bloques tool_use/tool_result a una línea descriptiva', () => {
    const messages = toolLoopTurn('leé mis correos', 'Tenés 2 correos nuevos.');

    const transcript = renderMessagesAsTranscript(messages);

    expect(transcript).toContain('Usuario: leé mis correos');
    expect(transcript).toContain('[llamó a la tool readEmails]');
    expect(transcript).toContain('[resultado de tool: ok]');
    expect(transcript).toContain('Jin: Tenés 2 correos nuevos.');
  });
});
