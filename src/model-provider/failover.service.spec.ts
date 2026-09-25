import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AllProvidersFailedError,
  StreamAlreadyPartiallyEmittedError,
} from './errors';
import { FailoverService } from './failover.service';

const CONTEXT = {
  taskProfile: 'coding_default',
  primaryModelId: 'claude-sonnet-5',
  fallbackModelId: 'gemini-3.5-flash',
};

describe('FailoverService.executeWithFailover', () => {
  let service: FailoverService;

  beforeEach(() => {
    service = new FailoverService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('devuelve el resultado del primary si funciona al primer intento', async () => {
    const callPrimary = vi.fn().mockResolvedValue('ok-primary');
    const callFallback = vi.fn();

    const result = await service.executeWithFailover(
      CONTEXT,
      callPrimary,
      callFallback,
    );

    expect(result).toBe('ok-primary');
    expect(callPrimary).toHaveBeenCalledTimes(1);
    expect(callFallback).not.toHaveBeenCalled();
  });

  it('reintenta 1 vez el primary antes de rendirse (docs/MODEL_ROUTING.md 2.3)', async () => {
    const callPrimary = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce('ok-en-el-reintento');
    const callFallback = vi.fn();

    const resultPromise = service.executeWithFailover(
      CONTEXT,
      callPrimary,
      callFallback,
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('ok-en-el-reintento');
    expect(callPrimary).toHaveBeenCalledTimes(2);
    expect(callFallback).not.toHaveBeenCalled();
  });

  it('cambia al fallback si el primary falla incluso tras el reintento', async () => {
    const callPrimary = vi.fn().mockRejectedValue(new Error('5xx'));
    const callFallback = vi.fn().mockResolvedValue('ok-fallback');

    const resultPromise = service.executeWithFailover(
      CONTEXT,
      callPrimary,
      callFallback,
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('ok-fallback');
    expect(callPrimary).toHaveBeenCalledTimes(2);
    expect(callFallback).toHaveBeenCalledTimes(1);
  });

  it('lanza AllProvidersFailedError si tanto el primary como el fallback fallan', async () => {
    const callPrimary = vi.fn().mockRejectedValue(new Error('primary caído'));
    const callFallback = vi.fn().mockRejectedValue(new Error('fallback caído'));

    const resultPromise = service.executeWithFailover(
      CONTEXT,
      callPrimary,
      callFallback,
    );
    // Marca la promesa como "manejada" de inmediato — de lo contrario
    // Vitest reporta un unhandled rejection porque rechaza durante
    // runAllTimersAsync(), antes de que el try/catch de abajo llegue a
    // hacerle await.
    resultPromise.catch(() => {});
    await vi.runAllTimersAsync();

    let caught: unknown;
    try {
      await resultPromise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AllProvidersFailedError);
    expect((caught as AllProvidersFailedError).code).toBe(
      'MODEL_PROVIDER_ALL_FAILED',
    );
  });
});

describe('FailoverService.executeWithFailoverStream', () => {
  let service: FailoverService;

  beforeEach(() => {
    service = new FailoverService();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('éxito directo del primary sin deltas antes de resolver: sin retry', async () => {
    const callPrimary = vi.fn().mockResolvedValue('ok-primary');
    const callFallback = vi.fn();
    const onDelta = vi.fn();

    const result = await service.executeWithFailoverStream(
      CONTEXT,
      callPrimary,
      callFallback,
      onDelta,
    );

    expect(result).toBe('ok-primary');
    expect(callPrimary).toHaveBeenCalledTimes(1);
    expect(callFallback).not.toHaveBeenCalled();
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('falla el primary ANTES de cualquier delta: reintenta una vez, luego cae al fallback si vuelve a fallar (comportamiento equivalente al atómico)', async () => {
    const callPrimary = vi.fn().mockRejectedValue(new Error('5xx'));
    const callFallback = vi
      .fn()
      .mockImplementation((onDelta: (d: string, s: string) => void) => {
        onDelta('ok', 'ok');
        return 'ok-fallback';
      });
    const onDelta = vi.fn();

    const resultPromise = service.executeWithFailoverStream(
      CONTEXT,
      callPrimary,
      callFallback,
      onDelta,
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('ok-fallback');
    expect(callPrimary).toHaveBeenCalledTimes(2);
    expect(callFallback).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledWith('ok', 'ok');
  });

  it('falla el primary DESPUÉS de emitir ≥1 delta: sin retry, sin fallback, StreamAlreadyPartiallyEmittedError', async () => {
    const callPrimary = vi
      .fn()
      .mockImplementation((onDelta: (d: string, s: string) => void) => {
        onDelta('Hola', 'Hola');
        throw new Error('conexión perdida a mitad de stream');
      });
    const callFallback = vi.fn();
    const onDelta = vi.fn();

    let caught: unknown;
    try {
      await service.executeWithFailoverStream(
        CONTEXT,
        callPrimary,
        callFallback,
        onDelta,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StreamAlreadyPartiallyEmittedError);
    expect((caught as StreamAlreadyPartiallyEmittedError).code).toBe(
      'MODEL_PROVIDER_STREAM_INTERRUPTED',
    );
    expect(callPrimary).toHaveBeenCalledTimes(1);
    expect(callFallback).not.toHaveBeenCalled();
    expect(onDelta).toHaveBeenCalledWith('Hola', 'Hola');
  });

  it('el fallback también emite deltas correctamente cuando se activa antes de cualquier delta del primary', async () => {
    const callPrimary = vi.fn().mockRejectedValue(new Error('caído'));
    const callFallback = vi
      .fn()
      .mockImplementation((onDelta: (d: string, s: string) => void) => {
        onDelta('a', 'a');
        onDelta('b', 'ab');
        return 'listo';
      });
    const onDelta = vi.fn();

    const resultPromise = service.executeWithFailoverStream(
      CONTEXT,
      callPrimary,
      callFallback,
      onDelta,
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('listo');
    expect(onDelta.mock.calls).toEqual([
      ['a', 'a'],
      ['b', 'ab'],
    ]);
  });
});
