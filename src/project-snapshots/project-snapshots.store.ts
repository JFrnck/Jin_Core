import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { projectSnapshots, type ProjectSnapshotRow } from '../db/schema';

export type ProjectSnapshotSummaryRow = Omit<ProjectSnapshotRow, 'files'>;

/** Único punto que toca `project_snapshots` (ADR 0021). */
@Injectable()
export class ProjectSnapshotsStore {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  async insert(input: {
    name: string;
    note: string | null;
    files: Record<string, string>;
    config: Record<string, unknown>;
    fileCount: number;
    totalBytes: number;
  }): Promise<ProjectSnapshotRow> {
    const [row] = await this.db
      .insert(projectSnapshots)
      .values(input)
      .returning();
    if (!row) throw new Error('No se pudo guardar el respaldo.');
    return row;
  }

  /** Sin `files`: la lista no debe arrastrar el contenido de todos los respaldos. */
  async list(): Promise<ProjectSnapshotSummaryRow[]> {
    return this.db
      .select({
        id: projectSnapshots.id,
        name: projectSnapshots.name,
        note: projectSnapshots.note,
        createdAt: projectSnapshots.createdAt,
        fileCount: projectSnapshots.fileCount,
        totalBytes: projectSnapshots.totalBytes,
        config: projectSnapshots.config,
      })
      .from(projectSnapshots)
      .orderBy(desc(projectSnapshots.createdAt));
  }

  async get(id: string): Promise<ProjectSnapshotRow | undefined> {
    const [row] = await this.db
      .select()
      .from(projectSnapshots)
      .where(eq(projectSnapshots.id, id));
    return row;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(projectSnapshots)
      .where(eq(projectSnapshots.id, id))
      .returning({ id: projectSnapshots.id });
    return deleted.length > 0;
  }

  async count(): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(projectSnapshots);
    return row?.total ?? 0;
  }
}
