import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startTestDb,
  type TestDb,
} from '../../test/support/postgres-testcontainer';
import { ProjectSnapshotsStore } from './project-snapshots.store';

describe('ProjectSnapshotsStore (integración, Postgres real, ADR 0021)', () => {
  let testDb: TestDb;
  let store: ProjectSnapshotsStore;

  beforeAll(async () => {
    testDb = await startTestDb();
    store = new ProjectSnapshotsStore(testDb.db);
  }, 90_000);

  afterAll(async () => {
    await testDb.stop();
  });

  it('inserta, lista sin archivos, obtiene con archivos y borra', async () => {
    const files = { 'index.html': '<h1>ñ</h1>', 'server/start.mjs': 'x' };
    const config = {
      template: 'node',
      mailEgress: true,
      ttlSeconds: 3600,
      envNames: ['BREVO_API_KEY'],
    };
    const row = await store.insert({
      name: 'Reservas',
      note: null,
      files,
      config,
      fileCount: 2,
      totalBytes: 14,
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.count()).toBe(1);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('files');
    expect(list[0]?.config).toEqual(config);

    expect((await store.get(row.id))?.files).toEqual(files);
    expect(
      await store.get('00000000-0000-4000-8000-000000000000'),
    ).toBeUndefined();

    expect(await store.delete(row.id)).toBe(true);
    expect(await store.delete(row.id)).toBe(false);
    expect(await store.count()).toBe(0);
  });

  it('los CHECK de la tabla rechazan más de 50 archivos y más de 256 KB', async () => {
    const base = { name: 'x', note: null, files: {}, config: {} };
    await expect(
      store.insert({ ...base, fileCount: 51, totalBytes: 1 }),
    ).rejects.toThrow();
    await expect(
      store.insert({ ...base, fileCount: 1, totalBytes: 262145 }),
    ).rejects.toThrow();
  });
});
