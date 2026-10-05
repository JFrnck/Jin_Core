import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { ProjectSnapshotRow } from '../db/schema';
import { SNAPSHOT_MAX_COUNT } from './project-snapshot.logic';
import { ProjectSnapshotsService } from './project-snapshots.service';
import type { ProjectSnapshotsStore } from './project-snapshots.store';

function fakeStore() {
  const rows = new Map<string, ProjectSnapshotRow>();
  let seq = 0;
  const store = {
    insert: vi.fn((input: Omit<ProjectSnapshotRow, 'id' | 'createdAt'>) => {
      const row = {
        ...input,
        id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
        createdAt: new Date(),
      };
      rows.set(row.id, row);
      return Promise.resolve(row);
    }),
    list: vi.fn(() => Promise.resolve([...rows.values()])),
    get: vi.fn((id: string) => Promise.resolve(rows.get(id))),
    delete: vi.fn((id: string) => Promise.resolve(rows.delete(id))),
    count: vi.fn(() => Promise.resolve(rows.size)),
  };
  return { store, rows };
}

describe('ProjectSnapshotsService', () => {
  let recorded: Array<Record<string, unknown>>;
  let audit: AuditService;
  let fake: ReturnType<typeof fakeStore>;
  let service: ProjectSnapshotsService;

  beforeEach(() => {
    recorded = [];
    audit = {
      recordToolCall: vi.fn((input: Record<string, unknown>) => {
        recorded.push(input);
        return Promise.resolve({});
      }),
    } as unknown as AuditService;
    fake = fakeStore();
    service = new ProjectSnapshotsService(
      fake.store as unknown as ProjectSnapshotsStore,
      audit,
    );
  });

  const body = {
    name: 'Reservas',
    files: { 'index.html': 'hola', 'server/start.mjs': 'x' },
  };

  it('guarda, audita sin el contenido de los archivos y devuelve el respaldo', async () => {
    const content = ['contenido', 'privado', String(Math.random())].join('-');
    const row = await service.create({
      ...body,
      files: { 'index.html': content },
    });
    expect(row.fileCount).toBe(1);
    expect(row.totalBytes).toBe(Buffer.byteLength(content));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actor: 'owner:api',
      toolName: 'saveProjectSnapshot',
      approvalStatus: 'auto',
    });
    expect(JSON.stringify(recorded)).not.toContain(content);
  });

  it('un archivo secreto da 400 y no guarda ni audita nada', async () => {
    await expect(
      service.create({ ...body, files: { ...body.files, '.env': 'A=1' } }),
    ).rejects.toThrow(BadRequestException);
    expect(fake.store.insert).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it('tope de respaldos: 409 al llegar al máximo', async () => {
    fake.store.count.mockResolvedValueOnce(SNAPSHOT_MAX_COUNT);
    await expect(service.create(body)).rejects.toThrow(ConflictException);
    expect(fake.store.insert).not.toHaveBeenCalled();
  });

  it('get devuelve los archivos y audita la restauración; id inexistente = 404', async () => {
    const row = await service.create(body);
    recorded.length = 0;
    expect((await service.get(row.id)).files).toEqual(body.files);
    expect(recorded[0]).toMatchObject({ toolName: 'restoreProjectSnapshot' });
    await expect(
      service.get('00000000-0000-4000-8000-ffffffffffff'),
    ).rejects.toThrow(NotFoundException);
  });

  it('delete borra y audita; borrar dos veces = 404', async () => {
    const row = await service.create(body);
    recorded.length = 0;
    await service.delete(row.id);
    expect(recorded[0]).toMatchObject({ toolName: 'deleteProjectSnapshot' });
    await expect(service.delete(row.id)).rejects.toThrow(NotFoundException);
  });
});
