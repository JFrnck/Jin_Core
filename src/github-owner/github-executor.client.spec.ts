import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubExecutorClient } from './github-executor.client';
import { GithubUnavailableError, GithubUpstreamError } from './github.errors';

const client = () =>
  new GithubExecutorClient(
    new ConfigService({ EXECUTOR_BASE_URL: 'http://executor.test/' }) as never,
  );

afterEach(() => vi.unstubAllGlobals());

describe('GithubExecutorClient', () => {
  it('llama a /github del Executor con el cuerpo JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ branch: 'main' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await client().checkout('ws-1', { branch: 'main' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://executor.test/github/workspaces/ws-1/checkout');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ branch: 'main' });
  });

  it('un rechazo conocido del Executor conserva su estado y su mensaje', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ message: 'La carpeta ya tiene archivos.' }),
            { status: 409 },
          ),
        ),
    );
    const error = await client()
      .clone('ws-1', { repo: 'a/b' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubUpstreamError);
    expect(error).toMatchObject({ message: 'La carpeta ya tiene archivos.' });
    expect((error as GithubUpstreamError).httpStatus).toBe(409);
  });

  it('GitHub apagado en el Executor (503) llega como 503; un fallo raro, como 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ message: 'GitHub no está configurado' }),
            { status: 503 },
          ),
        )
        .mockResolvedValueOnce(new Response('boom', { status: 500 })),
    );
    expect(
      (
        (await client()
          .repos()
          .catch((e: unknown) => e)) as GithubUpstreamError
      ).httpStatus,
    ).toBe(503);
    expect(
      (
        (await client()
          .repos()
          .catch((e: unknown) => e)) as GithubUpstreamError
      ).httpStatus,
    ).toBe(502);
  });

  it('Executor inalcanzable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );
    await expect(client().repos()).rejects.toThrow(GithubUnavailableError);
  });
});
