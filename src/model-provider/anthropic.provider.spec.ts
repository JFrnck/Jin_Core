import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config';
import { AnthropicProvider } from './anthropic.provider';

// AGENTS.md 6.3: mockear la API externa (el SDK de Anthropic), nunca la
// lógica propia. Vitest sube `vi.mock` por encima de los imports
// automáticamente, así que el mock aplica antes de que AnthropicProvider
// construya el cliente real.
const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock };
  },
}));

const fakeConfigService = {
  get: vi.fn().mockReturnValue('fake-anthropic-key'),
} as unknown as AppConfigService;

describe('AnthropicProvider.complete', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('mapea el primer bloque de texto de la respuesta y los tokens de uso', async () => {
    createMock.mockResolvedValue({
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'hola desde Claude' }],
      usage: { input_tokens: 12, output_tokens: 34 },
      stop_reason: 'end_turn',
    });

    const provider = new AnthropicProvider(fakeConfigService);
    const result = await provider.complete('claude-haiku-4-5', {
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 100,
      temperature: 0.2,
    });

    expect(result).toEqual({
      content: 'hola desde Claude',
      modelId: 'claude-haiku-4-5',
      inputTokens: 12,
      outputTokens: 34,
      stopReason: 'end_turn',
    });
    expect(createMock).toHaveBeenCalledWith({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      temperature: 0.2,
      system: undefined,
      messages: [{ role: 'user', content: 'hola' }],
    });
  });

  // Regresión (2026-09-21): el chat de Telegram fallaba en el primer mensaje.
  // La API responde 400 "`temperature` is deprecated for this model" a Sonnet 5,
  // Opus 5/4.8/4.7 y Fable 5, y el provider lo mandaba siempre, así que el chat
  // caía al fallback en cada turno y `reasoning_heavy` (Opus 4.8) ni arrancaba.
  it.each([
    'claude-sonnet-5',
    'claude-sonnet-5-20260601',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-fable-5',
    'claude-fable-5-1',
  ])(
    'NO manda temperature a %s (la API lo rechaza con 400)',
    async (modelId) => {
      createMock.mockResolvedValue({
        model: modelId,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await new AnthropicProvider(fakeConfigService).complete(modelId, {
        messages: [{ role: 'user', content: 'hola' }],
        maxOutputTokens: 100,
        temperature: 0.7,
      });

      const sent = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sent).not.toHaveProperty('temperature');
      expect(sent).toHaveProperty('max_tokens', 100);
    },
  );

  it.each(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-6'])(
    'SÍ manda temperature a %s (todavía lo acepta)',
    async (modelId) => {
      createMock.mockResolvedValue({
        model: modelId,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await new AnthropicProvider(fakeConfigService).complete(modelId, {
        messages: [{ role: 'user', content: 'hola' }],
        maxOutputTokens: 100,
        temperature: 0.7,
      });

      expect(createMock.mock.calls[0]?.[0]).toHaveProperty('temperature', 0.7);
    },
  );

  it('devuelve string vacío si la respuesta no trae ningún bloque de texto', async () => {
    createMock.mockResolvedValue({
      model: 'claude-sonnet-5',
      content: [{ type: 'tool_use', id: 't1', name: 'someTool', input: {} }],
      usage: { input_tokens: 5, output_tokens: 0 },
      stop_reason: 'tool_use',
    });

    const provider = new AnthropicProvider(fakeConfigService);
    const result = await provider.complete('claude-sonnet-5', {
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 100,
      temperature: 0.2,
    });

    expect(result.content).toBe('');
  });

  it('parsea bloques tool_use de la respuesta en toolCalls y refleja stopReason tool_use', async () => {
    createMock.mockResolvedValue({
      model: 'claude-sonnet-5',
      content: [
        { type: 'text', text: 'voy a listar tus eventos' },
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'listCalendarEvents',
          input: { maxResults: 5 },
        },
      ],
      usage: { input_tokens: 20, output_tokens: 10 },
      stop_reason: 'tool_use',
    });

    const provider = new AnthropicProvider(fakeConfigService);
    const result = await provider.complete('claude-sonnet-5', {
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
            name: 'listCalendarEvents',
            description: 'Lista eventos',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      }),
    );
  });

  it('mapea bloques de contenido tool_use/tool_result en los mensajes salientes', async () => {
    createMock.mockResolvedValue({
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'listo' }],
      usage: { input_tokens: 3, output_tokens: 2 },
      stop_reason: 'end_turn',
    });

    const provider = new AnthropicProvider(fakeConfigService);
    await provider.complete('claude-sonnet-5', {
      messages: [
        {
          role: 'assistant',
          content: [
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

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-1',
                name: 'listCalendarEvents',
                input: {},
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-1',
                content: JSON.stringify({ events: [] }),
              },
            ],
          },
        ],
      }),
    );
  });

  // Regresión (2026-09-24): un refusal del clasificador de seguridad de
  // Anthropic (content vacío, stop_reason: 'refusal') se mapeaba a
  // 'end_turn' porque ModelStopReason no lo distinguía — AgentService no
  // tenía forma de saber que no era una respuesta normal, y reenviaba el
  // string vacío al owner tal cual.
  it('refleja stopReason "refusal" en vez de colapsarlo a "end_turn"', async () => {
    createMock.mockResolvedValue({
      model: 'claude-sonnet-5',
      content: [],
      usage: { input_tokens: 8, output_tokens: 0 },
      stop_reason: 'refusal',
    });

    const provider = new AnthropicProvider(fakeConfigService);
    const result = await provider.complete('claude-sonnet-5', {
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 100,
      temperature: 0.2,
    });

    expect(result.stopReason).toBe('refusal');
    expect(result.content).toBe('');
  });

  it('incluye system solo cuando systemPrompt está definido', async () => {
    createMock.mockResolvedValue({
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const provider = new AnthropicProvider(fakeConfigService);
    await provider.complete('claude-sonnet-5', {
      systemPrompt: 'sos un asistente académico',
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 100,
      temperature: 0.2,
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'sos un asistente académico' }),
    );
  });
});
