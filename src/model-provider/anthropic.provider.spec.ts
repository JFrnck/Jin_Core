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
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'hola desde Claude' }],
      usage: { input_tokens: 12, output_tokens: 34 },
      stop_reason: 'end_turn',
    });

    const provider = new AnthropicProvider(fakeConfigService);
    const result = await provider.complete('claude-sonnet-5', {
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 100,
      temperature: 0.2,
    });

    expect(result).toEqual({
      content: 'hola desde Claude',
      modelId: 'claude-sonnet-5',
      inputTokens: 12,
      outputTokens: 34,
      stopReason: 'end_turn',
    });
    expect(createMock).toHaveBeenCalledWith({
      model: 'claude-sonnet-5',
      max_tokens: 100,
      temperature: 0.2,
      system: undefined,
      messages: [{ role: 'user', content: 'hola' }],
    });
  });

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
