import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { DualConfirmService } from '../hitl/dual-confirm.service';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { OwnerTerminalService } from './owner-terminal.service';
import type { TerminalExecutorClient } from './terminal-executor.client';
import { TerminalUpstreamError } from './terminal.errors';
import { FsWriteSchema } from './terminal.schemas';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

interface AuditCall {
  toolName: string;
  planSummary?: string;
  inputsHash: string;
}

function setup() {
  const order: string[] = [];
  const executor = {
    fsList: vi.fn(() => {
      order.push('executor.list');
      return Promise.resolve({ entries: [], truncated: false });
    }),
    fsRead: vi.fn(() => {
      order.push('executor.read');
      return Promise.resolve({
        content: 'x',
        size: 1,
        mtimeMs: 1,
        sha256: 'a',
      });
    }),
    fsWrite: vi.fn(() => {
      order.push('executor.write');
      return Promise.resolve({ sha256: 'b', size: 1, mtimeMs: 1 });
    }),
    fsMkdir: vi.fn(() => {
      order.push('executor.mkdir');
      return Promise.resolve();
    }),
    fsDelete: vi.fn(() => {
      order.push('executor.delete');
      return Promise.resolve();
    }),
  };
  const recordToolCall = vi.fn((input: AuditCall) => {
    order.push(`audit:${input.toolName}:${input.planSummary ?? ''}`);
    return Promise.resolve({});
  });
  const service = new OwnerTerminalService(
    {} as DualConfirmService,
    new ToolExecutorRegistry(),
    executor as unknown as TerminalExecutorClient,
    { recordToolCall } as unknown as AuditService,
  );
  return { service, executor, recordToolCall, order };
}

describe('OwnerTerminalService — explorador de archivos del pod', () => {
  it('leer y listar NO se auditan y van directo al Executor', async () => {
    const { service, executor, recordToolCall } = setup();
    await service.fsList(WORKSPACE, '.');
    await service.fsRead(WORKSPACE, 'src/App.jsx');
    expect(executor.fsList).toHaveBeenCalledWith(WORKSPACE, '.');
    expect(executor.fsRead).toHaveBeenCalledWith(WORKSPACE, 'src/App.jsx');
    expect(recordToolCall).not.toHaveBeenCalled();
  });

  it.each([
    [
      'guardar',
      (s: OwnerTerminalService) =>
        s.fsWrite(WORKSPACE, {
          path: 'src/App.jsx',
          content: 'x',
          force: false,
        }),
      'audit:writeTerminalFile:terminal: guardar src/App.jsx',
      'executor.write',
    ],
    [
      'guardar sobrescribiendo',
      (s: OwnerTerminalService) =>
        s.fsWrite(WORKSPACE, { path: 'a.txt', content: 'x', force: true }),
      'audit:writeTerminalFile:terminal: guardar a.txt (sobrescribir)',
      'executor.write',
    ],
    [
      'crear carpeta',
      (s: OwnerTerminalService) => s.fsMkdir(WORKSPACE, 'src/nuevo'),
      'audit:makeTerminalDir:terminal: crear carpeta src/nuevo',
      'executor.mkdir',
    ],
    [
      'borrar',
      (s: OwnerTerminalService) => s.fsDelete(WORKSPACE, 'viejo.txt'),
      'audit:deleteTerminalEntry:terminal: borrar viejo.txt',
      'executor.delete',
    ],
  ])(
    '%s: el audit va ANTES de tocar el pod',
    async (_name, action, audited, executed) => {
      const { service, order } = setup();
      await action(service);
      expect(order).toEqual([audited, executed]);
    },
  );

  it.each([
    [
      'guardar',
      (s: OwnerTerminalService) =>
        s.fsWrite(WORKSPACE, { path: 'a', content: 'x', force: false }),
      'fsWrite',
    ],
    [
      'crear carpeta',
      (s: OwnerTerminalService) => s.fsMkdir(WORKSPACE, 'a'),
      'fsMkdir',
    ],
    [
      'borrar',
      (s: OwnerTerminalService) => s.fsDelete(WORKSPACE, 'a'),
      'fsDelete',
    ],
  ] as const)(
    '%s: si el audit falla NO se toca el pod (fail-closed)',
    async (_name, action, method) => {
      const { service, executor, recordToolCall } = setup();
      recordToolCall.mockRejectedValueOnce(new Error('audit caído'));
      await expect(action(service)).rejects.toThrow('audit caído');
      expect(executor[method]).not.toHaveBeenCalled();
    },
  );

  it('el audit lleva la ruta pero NUNCA el contenido del archivo', async () => {
    const { service, recordToolCall } = setup();
    const secret = 'CONTENIDO-SENSIBLE-DEL-ARCHIVO';
    await service.fsWrite(WORKSPACE, {
      path: 'config.js',
      content: secret,
      force: false,
    });

    const call = recordToolCall.mock.calls[0]?.[0] as AuditCall;
    expect(JSON.stringify(call)).not.toContain(secret);
    expect(call.planSummary).toContain('config.js');
  });

  it('el hash del audit cambia con la ruta (dos archivos distintos no se confunden)', async () => {
    const { service, recordToolCall } = setup();
    await service.fsWrite(WORKSPACE, {
      path: 'a.js',
      content: 'x',
      force: false,
    });
    await service.fsWrite(WORKSPACE, {
      path: 'b.js',
      content: 'x',
      force: false,
    });
    const [first, second] = recordToolCall.mock.calls.map(
      (c) => c[0].inputsHash,
    );
    expect(first).not.toBe(second);
  });

  it('un error del Executor (conflicto) llega sin tragarse, después de auditar el intento', async () => {
    const { service, executor, order } = setup();
    executor.fsWrite.mockRejectedValueOnce(
      new TerminalUpstreamError(
        409,
        'el archivo cambió en el pod',
        'TERMINAL_FS_CONFLICT',
      ),
    );
    await expect(
      service.fsWrite(WORKSPACE, {
        path: 'a.js',
        content: 'x',
        expectedSha256: 'a'.repeat(64),
        force: false,
      }),
    ).rejects.toMatchObject({ code: 'TERMINAL_FS_CONFLICT', httpStatus: 409 });
    expect(order[0]).toContain('audit:writeTerminalFile');
  });
});

describe('TerminalUpstreamError — códigos del explorador', () => {
  it('deja pasar solo los TERMINAL_FS_*; el resto sigue genérico', () => {
    expect(
      new TerminalUpstreamError(409, 'x', 'TERMINAL_FS_CONFLICT').code,
    ).toBe('TERMINAL_FS_CONFLICT');
    expect(
      new TerminalUpstreamError(404, 'x', 'TERMINAL_FS_NOT_FOUND').code,
    ).toBe('TERMINAL_FS_NOT_FOUND');
    expect(new TerminalUpstreamError(409, 'x', 'TERMINAL_BUSY').code).toBe(
      'TERMINAL_UPSTREAM_ERROR',
    );
    expect(new TerminalUpstreamError(409, 'x').code).toBe(
      'TERMINAL_UPSTREAM_ERROR',
    );
  });

  it('un 413 del explorador (archivo grande) se conserva; otro 413 sigue siendo 502', () => {
    expect(
      new TerminalUpstreamError(413, 'x', 'TERMINAL_FS_TOO_LARGE').httpStatus,
    ).toBe(413);
    expect(new TerminalUpstreamError(413, 'x').httpStatus).toBe(502);
  });

  it('lee el código del cuerpo de error del Executor', async () => {
    const response = new Response(
      JSON.stringify({
        statusCode: 409,
        code: 'TERMINAL_FS_CONFLICT',
        message: 'cambió',
      }),
      { status: 409 },
    );
    const error = await TerminalUpstreamError.fromResponse(response);
    expect(error.code).toBe('TERMINAL_FS_CONFLICT');
    expect(error.message).toBe('cambió');
    expect(error.httpStatus).toBe(409);
  });
});

describe('FsWriteSchema', () => {
  const valid = { path: 'src/App.jsx', content: 'x' };

  it('acepta un guardado normal y pone force=false por defecto', () => {
    expect(FsWriteSchema.parse(valid)).toEqual({ ...valid, force: false });
  });

  it.each(['../fuera', '/etc/passwd', 'a/../../b', 'a\\b', ''])(
    'rechaza la ruta %j',
    (path) => {
      expect(FsWriteSchema.safeParse({ ...valid, path }).success).toBe(false);
    },
  );

  it('rechaza más de 512 KB y un sha256 mal formado, y campos de más', () => {
    expect(
      FsWriteSchema.safeParse({ ...valid, content: 'x'.repeat(512 * 1024 + 1) })
        .success,
    ).toBe(false);
    expect(
      FsWriteSchema.safeParse({ ...valid, content: 'x'.repeat(512 * 1024) })
        .success,
    ).toBe(true);
    expect(
      FsWriteSchema.safeParse({ ...valid, expectedSha256: 'no-es-un-hash' })
        .success,
    ).toBe(false);
    expect(FsWriteSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it('el límite de 512 KB es en BYTES, no en caracteres', () => {
    expect(
      FsWriteSchema.safeParse({ ...valid, content: 'ñ'.repeat(300 * 1024) })
        .success,
    ).toBe(false);
  });
});
