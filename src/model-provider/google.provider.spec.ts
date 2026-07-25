import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config';
import { GoogleProvider } from './google.provider';

// AGENTS.md 6.3: mockear la API externa (el SDK de Google GenAI).
const generateContentMock = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock };
  },
  FunctionCallingConfigMode: { AUTO: 'AUTO' },
}));

const fakeConfigService = {
  get: vi.fn().mockReturnValue('fake-gemini-key'),
} as unknown as AppConfigService;

describe('GoogleProvider.complete', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it('mapea .text y usageMetadata a la forma común de ModelCompletionResponse', async () => {
    generateContentMock.mockResolvedValue({
      text: 'hola desde Gemini',
      modelVersion: 'gemini-3.1-pro-001',
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 21 },
    });

    const provider = new GoogleProvider(fakeConfigService);
    const result = await provider.complete('gemini-3.1-pro', {
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 100,
      temperature: 0.4,
    });

    expect(result).toEqual({
      content: 'hola desde Gemini',
      modelId: 'gemini-3.1-pro-001',
      inputTokens: 7,
      outputTokens: 21,
      stopReason: 'end_turn',
    });
    expect(generateContentMock).toHaveBeenCalledWith({
      model: 'gemini-3.1-pro',
      contents: [{ role: 'user', parts: [{ text: 'hola' }] }],
      config: {
        systemInstruction: undefined,
        maxOutputTokens: 100,
        temperature: 0.4,
      },
    });
  });

  it('convierte el rol "assistant" a "model" (convención de Gemini)', async () => {
    generateContentMock.mockResolvedValue({
      text: 'ok',
      modelVersion: 'gemini-3.1-pro-001',
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });

    const provider = new GoogleProvider(fakeConfigService);
    await provider.complete('gemini-3.1-pro', {
      messages: [
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: 'hola de vuelta' },
      ],
      maxOutputTokens: 100,
      temperature: 0.4,
    });

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: [
          { role: 'user', parts: [{ text: 'hola' }] },
          { role: 'model', parts: [{ text: 'hola de vuelta' }] },
        ],
      }),
    );
  });

  it('usa 0 como default de tokens si la respuesta no trae usageMetadata', async () => {
    generateContentMock.mockResolvedValue({
      text: 'ok',
      modelVersion: undefined,
    });

    const provider = new GoogleProvider(fakeConfigService);
    const result = await provider.complete('gemini-3.1-pro', {
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 100,
      temperature: 0.4,
    });

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.modelId).toBe('gemini-3.1-pro');
  });

  it('incluye systemInstruction solo cuando systemPrompt está definido', async () => {
    generateContentMock.mockResolvedValue({
      text: 'ok',
      modelVersion: 'gemini-3.1-pro-001',
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });

    const provider = new GoogleProvider(fakeConfigService);
    await provider.complete('gemini-3.1-pro', {
      systemPrompt: 'sos un asistente académico',
      messages: [{ role: 'user', content: 'hola' }],
      maxOutputTokens: 100,
      temperature: 0.4,
    });

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          systemInstruction: 'sos un asistente académico',
          maxOutputTokens: 100,
          temperature: 0.4,
        },
      }),
    );
  });

  it('declara tools como functionDeclarations con parametersJsonSchema', async () => {
    generateContentMock.mockResolvedValue({
      text: '',
      modelVersion: 'gemini-3.1-pro-001',
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      functionCalls: [
        { id: 'call-1', name: 'listCalendarEvents', args: { maxResults: 5 } },
      ],
      candidates: [{ finishReason: 'STOP' }],
    });

    const provider = new GoogleProvider(fakeConfigService);
    const result = await provider.complete('gemini-3.1-pro', {
      messages: [{ role: 'user', content: 'lista mis eventos' }],
      maxOutputTokens: 100,
      temperature: 0.4,
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
    const callArgs = generateContentMock.mock.calls[0] as unknown as [
      { config: { tools: unknown } },
    ];
    expect(callArgs[0].config.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'listCalendarEvents',
            description: 'Lista eventos',
            parametersJsonSchema: { type: 'object', properties: {} },
          },
        ],
      },
    ]);
  });

  it('genera un id propio si Gemini no devuelve id en el functionCall', async () => {
    generateContentMock.mockResolvedValue({
      text: '',
      modelVersion: 'gemini-3.1-pro-001',
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      functionCalls: [{ name: 'listCalendarEvents', args: {} }],
      candidates: [{ finishReason: 'STOP' }],
    });

    const provider = new GoogleProvider(fakeConfigService);
    const result = await provider.complete('gemini-3.1-pro', {
      messages: [{ role: 'user', content: 'lista mis eventos' }],
      maxOutputTokens: 100,
      temperature: 0.4,
    });

    expect(result.toolCalls?.[0]?.id).toEqual(expect.any(String));
    expect(result.toolCalls?.[0]?.id.length).toBeGreaterThan(0);
  });

  it('reconstruye el name de un tool_result desde el tool_use previo del mismo request', async () => {
    generateContentMock.mockResolvedValue({
      text: 'listo',
      modelVersion: 'gemini-3.1-pro-001',
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      candidates: [{ finishReason: 'STOP' }],
    });

    const provider = new GoogleProvider(fakeConfigService);
    await provider.complete('gemini-3.1-pro', {
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
      temperature: 0.4,
    });

    expect(generateContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'listCalendarEvents',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call-1',
                  name: 'listCalendarEvents',
                  response: { output: { events: [] } },
                },
              },
            ],
          },
        ],
      }),
    );
  });
});
