import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { AppConfigService } from '../config';
import { EmbeddingProviderError } from './errors';

// Fijo, no ruteado por TaskProfile (a diferencia de src/model-provider/):
// un solo consumidor (src/memory/), sin necesidad de fallback cross-vendor
// ni de variación por entorno. Truncado a 1024 dims (soportado por
// text-embedding-3-large vía el param `dimensions`) — balance
// calidad/tamaño para un store ≤100k vectores (BLUEPRINT 3.3.1).
const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 1024;

/** Guardado como `modelo_embedding` en cada entrada (BLUEPRINT 3.3.1) — permite migrar de modelo sin adivinar qué generó cada vector. */
export const EMBEDDING_MODEL_ID = `${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS}`;

@Injectable()
export class EmbeddingProvider {
  private readonly client: OpenAI;

  constructor(@Inject(ConfigService) configService: AppConfigService) {
    this.client = new OpenAI({ apiKey: configService.get('OPENAI_API_KEY') });
  }

  async embed(text: string): Promise<readonly number[]> {
    try {
      const response = await this.client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: text,
        dimensions: EMBEDDING_DIMENSIONS,
      });

      const embedding = response.data[0]?.embedding;
      if (!embedding) {
        throw new EmbeddingProviderError(
          'La API de OpenAI no devolvió ningún embedding',
        );
      }
      return embedding;
    } catch (err: unknown) {
      if (err instanceof EmbeddingProviderError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new EmbeddingProviderError(msg, err);
    }
  }
}
