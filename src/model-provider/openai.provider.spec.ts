import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config';
import { OpenAIProvider } from './openai.provider';

// AGENTS.md 6.3: mockear la API externa (el SDK de OpenAI), nunca la
// lógica propia. Mismo patrón que anthropic.provider.spec.ts/
// google.provider.spec.ts.
const createMock = vi.fn();

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

const fakeConfigService = {
  get: vi.fn().mockReturnValue('fake-openai-key'),
} as unknown as AppConfigService;

describe('OpenAIProvider.complete', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('mapea el texto de la respuesta y los tokens de uso', async () => {
    createMock.mockResolvedValue({
      model: 'gpt-5.1',
      choices: [
        {
          message: { content: 'hola desde GPT', tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    });

    const provider = new OpenAIProvider(fakeConfigService);
    const result = await provider.complete('gpt-5.1', {
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 100,
      temperature: 0.2,
    });

    expect(result).toEqual({
      content: 'hola desde GPT',
      modelId: 'gpt-5.1',
      inputTokens: 12,
      outputTokens: 34,
      stopReason: 'end_turn',
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.1',
        max_completion_tokens: 100,
        temperature: 0.2,
      }),
    );
  });

  it('sin ningún choice, devuelve content vacío y stopReason end_turn en vez de tirar', async () => {
    createMock.mockResolvedValue({
      model: 'gpt-5.1-mini',
      choices: [],
      usage: undefined,
    });

    const provider = new OpenAIProvider(fakeConfigService);
    const result = await provider.complete('gpt-5.1-mini', {
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 100,
      temperature: 0.2,
    });

    expect(result.content).toBe('');
    expect(result.stopReason).toBe('end_turn');
    expect(result.inputTokens).toBe(0);
  });

  it('parsea tool_calls de la respuesta y refleja stopReason tool_use', async () => {
    createMock.mockResolvedValue({
      model: 'gpt-5.1',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: {
                  name: 'listCalendarEvents',
                  arguments: '{"maxResults":5}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    const provider = new OpenAIProvider(fakeConfigService);
    const result = await provider.complete('gpt-5.1', {
      messages: [{ role: 'user', content: 'lista mis eventos' }],
      maxOutputTokens: 100,
      temperature: 0.2,
      tools: [
        {
          name: 'listCalendarEvents',
          description: 'Lista eventos',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([
      { id: 'call-1', name: 'listCalendarEvents', input: { maxResults: 5 } },
    ]);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          {
            type: 'function',
            function: {
              name: 'listCalendarEvents',
              description: 'Lista eventos',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      }),
    );
  });

  it('un tool_call con JSON inválido en arguments no tira: el input queda vacío', async () => {
    createMock.mockResolvedValue({
      model: 'gpt-5.1',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'someTool', arguments: '{not valid json' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    const provider = new OpenAIProvider(fakeConfigService);
    const result = await provider.complete('gpt-5.1', {
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
      temperature: 0.2,
    });

    expect(result.toolCalls).toEqual([
      { id: 'call-1', name: 'someTool', input: {} },
    ]);
  });

  it.each([
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
    ['stop', 'end_turn'],
  ] as const)(
    'finish_reason %s -> stopReason %s',
    async (finishReason, expected) => {
      createMock.mockResolvedValue({
        model: 'gpt-5.1',
        choices: [
          {
            message: { content: 'x', tool_calls: undefined },
            finish_reason: finishReason,
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });

      const provider = new OpenAIProvider(fakeConfigService);
      const result = await provider.complete('gpt-5.1', {
        messages: [{ role: 'user', content: 'x' }],
        maxOutputTokens: 100,
        temperature: 0.2,
      });

      expect(result.stopReason).toBe(expected);
    },
  );

  it('con effort: manda reasoning_effort y NO manda temperature (los modelos de razonamiento la rechazan)', async () => {
    createMock.mockResolvedValue({
      model: 'gpt-5.1',
      choices: [
        {
          message: { content: 'ok', tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await new OpenAIProvider(fakeConfigService).complete('gpt-5.1', {
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
      temperature: 0.7,
      effort: 'high',
    });

    const sent = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.reasoning_effort).toBe('high');
    expect(sent).not.toHaveProperty('temperature');
  });

  it('con effort Y tools: NO manda reasoning_effort ni temperature (Chat Completions da 400 con GPT-6)', async () => {
    createMock.mockResolvedValue({
      model: 'gpt-6-luna',
      choices: [
        {
          message: { content: 'ok', tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await new OpenAIProvider(fakeConfigService).complete('gpt-6-luna', {
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
      temperature: 0.7,
      effort: 'medium',
      tools: [
        {
          name: 'listPreviewServices',
          description: 'lista',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    const sent = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('reasoning_effort');
    expect(sent).not.toHaveProperty('temperature');
    expect(sent).toHaveProperty('tools');
  });

  it('sin effort: manda temperature y no manda reasoning_effort', async () => {
    createMock.mockResolvedValue({
      model: 'gpt-5.1',
      choices: [
        {
          message: { content: 'ok', tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await new OpenAIProvider(fakeConfigService).complete('gpt-5.1', {
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
      temperature: 0.7,
    });

    const sent = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.temperature).toBe(0.7);
    expect(sent).not.toHaveProperty('reasoning_effort');
  });

  it('incluye un mensaje system solo cuando systemPrompt está definido', async () => {
    createMock.mockResolvedValue({
      model: 'gpt-5.1',
      choices: [
        {
          message: { content: 'ok', tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await new OpenAIProvider(fakeConfigService).complete('gpt-5.1', {
      systemPrompt: 'sos un asistente académico',
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 100,
      temperature: 0.2,
    });

    const sent = createMock.mock.calls[0]?.[0] as { messages: unknown[] };
    expect(sent.messages[0]).toEqual({
      role: 'system',
      content: 'sos un asistente académico',
    });
  });

  it('un ModelMessage con bloques tool_use/tool_result se expande a mensajes de OpenAI (el tool_result es SU PROPIO mensaje role:tool)', async () => {
    createMock.mockResolvedValue({
      model: 'gpt-5.1',
      choices: [
        {
          message: { content: 'listo', tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await new OpenAIProvider(fakeConfigService).complete('gpt-5.1', {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'voy a mirar' },
            {
              type: 'tool_use',
              toolCall: { id: 'call-1', name: 'listCalendarEvents', input: {} },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'call-1',
              output: { events: [] },
            },
          ],
        },
      ],
      maxOutputTokens: 100,
      temperature: 0.2,
    });

    const sent = createMock.mock.calls[0]?.[0] as { messages: unknown[] };
    expect(sent.messages).toEqual([
      {
        role: 'assistant',
        content: 'voy a mirar',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'listCalendarEvents', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: JSON.stringify({ events: [] }),
      },
    ]);
  });
});
