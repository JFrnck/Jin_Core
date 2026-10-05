import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { computeInputsHash } from '../agent/agent.logic';
import { AuditService } from '../audit/audit.service';
import type { ProjectSnapshotRow } from '../db/schema';
import {
  CreateSnapshotSchema,
  SNAPSHOT_MAX_COUNT,
  snapshotBytes,
} from './project-snapshot.logic';
import {
  ProjectSnapshotsStore,
  type ProjectSnapshotSummaryRow,
} from './project-snapshots.store';

const OWNER_ACTOR = 'owner:api';

/**
 * Respaldos de proyectos del editor (ADR 0021). Es dato propio del owner en su propia base, sin
 * efectos fuera de Jin: no pasa por HITL (como `exportPreviewFiles`), pero cada acción queda en el
 * audit (nombre, cantidad y hash; nunca el contenido de los archivos).
 */
@Injectable()
export class ProjectSnapshotsService {
  constructor(
    private readonly store: ProjectSnapshotsStore,
    private readonly audit: AuditService,
  ) {}

  async create(body: unknown): Promise<ProjectSnapshotRow> {
    const parsed = CreateSnapshotSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((issue) => issue.message).join(' '),
      );
    }
    const { name, note, files, config } = parsed.data;
    if ((await this.store.count()) >= SNAPSHOT_MAX_COUNT) {
      throw new ConflictException(
        `Ya hay ${SNAPSHOT_MAX_COUNT} respaldos: borra alguno antes de guardar otro.`,
      );
    }
    const totalBytes = snapshotBytes(files);
    const fileCount = Object.keys(files).length;
    const row = await this.store.insert({
      name,
      note: note ?? null,
      files,
      config: config ?? {},
      fileCount,
      totalBytes,
    });
    await this.audit.recordToolCall({
      requestId: randomUUID(),
      actor: OWNER_ACTOR,
      toolName: 'saveProjectSnapshot',
      inputsHash: computeInputsHash({
        id: row.id,
        name,
        fileCount,
        totalBytes,
      }),
      planSummary: `Respaldar el proyecto «${name}» (${fileCount} archivo${fileCount === 1 ? '' : 's'}, ${totalBytes} bytes)`,
      approvalStatus: 'auto',
    });
    return row;
  }

  list(): Promise<ProjectSnapshotSummaryRow[]> {
    return this.store.list();
  }

  async get(id: string): Promise<ProjectSnapshotRow> {
    const row = await this.store.get(id);
    if (!row) throw new NotFoundException('Respaldo no encontrado.');
    await this.audit.recordToolCall({
      requestId: randomUUID(),
      actor: OWNER_ACTOR,
      toolName: 'restoreProjectSnapshot',
      inputsHash: computeInputsHash({ id }),
      planSummary: `Restaurar el respaldo «${row.name}» al editor`,
      approvalStatus: 'auto',
    });
    return row;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.store.get(id);
    if (!existing || !(await this.store.delete(id))) {
      throw new NotFoundException('Respaldo no encontrado.');
    }
    await this.audit.recordToolCall({
      requestId: randomUUID(),
      actor: OWNER_ACTOR,
      toolName: 'deleteProjectSnapshot',
      inputsHash: computeInputsHash({ id }),
      planSummary: `Borrar el respaldo «${existing.name}»`,
      approvalStatus: 'auto',
    });
  }
}
