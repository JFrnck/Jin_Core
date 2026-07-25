import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../config';
import { EmbeddingProvider } from './embedding-provider';
import { EmbeddingProviderError } from './errors';

// AGENTS.md 6.3: mockear la API externa (el SDK de OpenAI).
const createMock = vi.fn();

vi.mock('openai', () => ({
  default: class {
    embeddings = { create: createMock };
  },
}));

const fakeConfigService = {
  get: vi.fn().mockReturnValue('fake-openai-key'),
} as unknown as AppConfigService;

describe('EmbeddingProvider.embed', () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it('llama a la API con el modelo y dimensiones fijos, devuelve el vector', async () => {
    const fakeVector = Array.from({ length: 1024 }, (_, i) => i / 1024);
    createMock.mockResolvedValue({
      data: [{ embedding: fakeVector, index: 0, object: 'embedding' }],
      model: 'text-embedding-3-large',
      object: 'list',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    });

    const provider = new EmbeddingProvider(fakeConfigService);
    const result = await provider.embed('hola mundo');

    expect(result).toEqual(fakeVector);
    expect(createMock).toHaveBeenCalledWith({
      model: 'text-embedding-3-large',
      input: 'hola mundo',
      dimensions: 1024,
    });
  });

  it('lanza EmbeddingProviderError si la API no devuelve ningún embedding', async () => {
    createMock.mockResolvedValue({ data: [] });

    const provider = new EmbeddingProvider(fakeConfigService);

    await expect(provider.embed('texto')).rejects.toThrow(
      EmbeddingProviderError,
    );
  });

  it('envuelve un error de red/API en EmbeddingProviderError', async () => {
    createMock.mockRejectedValue(new Error('rate limit exceeded'));

    const provider = new EmbeddingProvider(fakeConfigService);

    await expect(provider.embed('texto')).rejects.toThrow(
      EmbeddingProviderError,
    );
  });
});
