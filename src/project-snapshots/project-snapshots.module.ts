import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ProjectSnapshotsController } from './project-snapshots.controller';
import { ProjectSnapshotsService } from './project-snapshots.service';
import { ProjectSnapshotsStore } from './project-snapshots.store';

/** Respaldos de proyectos del editor (ADR 0021). `DbModule` es global. */
@Module({
  imports: [AuditModule],
  controllers: [ProjectSnapshotsController],
  providers: [ProjectSnapshotsStore, ProjectSnapshotsService],
})
export class ProjectSnapshotsModule {}
