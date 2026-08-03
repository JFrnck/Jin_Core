import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  startTestDb,
  type TestDb,
} from '../../test/support/postgres-testcontainer';
import { DB_CONNECTION } from '../db/db.module';
import { auditLog } from '../db/schema';
import { AuditService } from './audit.service';
import { ChainVerificationService } from './chain-verification.service';
import { GENESIS_HASH, verifyChain } from './hash-chain';

describe('AuditService + ChainVerificationService (integración, Postgres real)', () => {
  let testDb: TestDb;
  let auditService: AuditService;
  let chainVerification: ChainVerificationService;

  beforeAll(async () => {
    testDb = await startTestDb();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        ChainVerificationService,
        { provide: DB_CONNECTION, useValue: testDb.db },
      ],
    }).compile();

    auditService = moduleRef.get(AuditService);
    chainVerification = moduleRef.get(ChainVerificationService);
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.delete(auditLog);
    chainVerification.unlock();
  });

  it('recordToolCall inserta la primera fila con prevHash = GENESIS_HASH', async () => {
    const row = await auditService.recordToolCall({
      requestId: 'a1111111-1111-4111-8111-111111111111',
      actor: 'agent:test',
      toolName: 'readEmails',
      inputsHash: 'hash1',
      approvalStatus: 'auto',
    });

    expect(row.prevHash).toBe(GENESIS_HASH);
    expect(row.currentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('encadena correctamente filas sucesivas (prevHash = currentHash de la anterior)', async () => {
    const row1 = await auditService.recordToolCall({
      requestId: '11111111-1111-4111-8111-111111111111',
      actor: 'agent',
      toolName: 'sendEmail',
      inputsHash: 'h1',
      approvalStatus: 'pending',
    });
    const row2 = await auditService.recordApproval({
      requestId: '11111111-1111-4111-8111-111111111111',
      approver: 'owner',
      toolName: 'sendEmail',
      inputsHash: 'h1',
    });

    expect(row2.prevHash).toBe(row1.currentHash);
    expect(row2.requestId).toBe(row1.requestId);
  });

  it('recordRejection encadena una fila "rejected" con actor "user"', async () => {
    const row1 = await auditService.recordToolCall({
      requestId: '11111111-1111-4111-8111-111111111111',
      actor: 'agent',
      toolName: 'sendEmail',
      inputsHash: 'h1',
      approvalStatus: 'pending',
    });
    const row2 = await auditService.recordRejection({
      requestId: '11111111-1111-4111-8111-111111111111',
      approver: 'owner',
      toolName: 'sendEmail',
      inputsHash: 'h1',
    });

    expect(row2.prevHash).toBe(row1.currentHash);
    expect(row2.actionType).toBe('rejection');
    expect(row2.approvalStatus).toBe('rejected');
    expect(row2.approver).toBe('owner');
  });

  it('la cadena completa verifica OK tras varias inserciones', async () => {
    await auditService.recordToolCall({
      requestId: '11111111-1111-4111-8111-111111111111',
      actor: 'agent',
      toolName: 'readEmails',
      inputsHash: 'h1',
      approvalStatus: 'auto',
    });
    await auditService.recordToolCall({
      requestId: '22222222-2222-4222-8222-222222222222',
      actor: 'agent',
      toolName: 'sendEmail',
      inputsHash: 'h2',
      approvalStatus: 'pending',
    });
    await auditService.recordApproval({
      requestId: '22222222-2222-4222-8222-222222222222',
      approver: 'owner',
      toolName: 'sendEmail',
      inputsHash: 'h2',
    });

    const result = await chainVerification.verifyDaily();
    expect(result.valid).toBe(true);
  });

  it('MUTACIÓN: un UPDATE directo a una fila histórica es detectado', async () => {
    const row1 = await auditService.recordToolCall({
      requestId: '11111111-1111-4111-8111-111111111111',
      actor: 'agent',
      toolName: 'readEmails',
      inputsHash: 'h1',
      approvalStatus: 'auto',
    });
    await auditService.recordToolCall({
      requestId: '22222222-2222-4222-8222-222222222222',
      actor: 'agent',
      toolName: 'readEmails',
      inputsHash: 'h2',
      approvalStatus: 'auto',
    });

    // Ataque directo a SQL, saltándose el servicio por completo — simula
    // un acceso directo a la base de datos, no solo un bug del código.
    await testDb.pool.query(
      'UPDATE audit_log SET approval_status = $1 WHERE id = $2',
      ['approved', row1.id],
    );

    const result = await chainVerification.verifyDaily();
    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(row1.id);
    expect(chainVerification.isLocked()).toBe(true);
  });

  it('MUTACIÓN: un DELETE de una fila histórica es detectado', async () => {
    const row1 = await auditService.recordToolCall({
      requestId: '11111111-1111-4111-8111-111111111111',
      actor: 'agent',
      toolName: 'readEmails',
      inputsHash: 'h1',
      approvalStatus: 'auto',
    });
    const row2 = await auditService.recordToolCall({
      requestId: '22222222-2222-4222-8222-222222222222',
      actor: 'agent',
      toolName: 'readEmails',
      inputsHash: 'h2',
      approvalStatus: 'auto',
    });

    await testDb.pool.query('DELETE FROM audit_log WHERE id = $1', [row1.id]);

    const result = await chainVerification.verifyDaily();
    expect(result.valid).toBe(false);
    expect(result.brokenAtId).toBe(row2.id);
  });

  it('appendRow se rechaza con AuditChainLockedError tras detectar corrupción', async () => {
    const row1 = await auditService.recordToolCall({
      requestId: '11111111-1111-4111-8111-111111111111',
      actor: 'agent',
      toolName: 'readEmails',
      inputsHash: 'h1',
      approvalStatus: 'auto',
    });
    await testDb.pool.query(
      'UPDATE audit_log SET approval_status = $1 WHERE id = $2',
      ['approved', row1.id],
    );
    await chainVerification.verifyDaily(); // detecta la corrupción y bloquea

    await expect(
      auditService.recordToolCall({
        requestId: '22222222-2222-4222-8222-222222222222',
        actor: 'agent',
        toolName: 'readEmails',
        inputsHash: 'h2',
        approvalStatus: 'auto',
      }),
    ).rejects.toThrow('bloqueado');
  });

  it('escrituras concurrentes no rompen la cadena (advisory lock serializa los appends)', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        auditService.recordToolCall({
          requestId: `cccccccc-cccc-4ccc-8ccc-${i.toString().padStart(12, '0')}`,
          actor: 'agent',
          toolName: 'readEmails',
          inputsHash: `h${i}`,
          approvalStatus: 'auto',
        }),
      ),
    );

    const rows = await testDb.db.select().from(auditLog).orderBy(auditLog.id);
    expect(rows).toHaveLength(10);
    expect(verifyChain(rows).valid).toBe(true);
  });

  describe('listRecent', () => {
    async function seed(count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        await auditService.recordToolCall({
          requestId: `dddddddd-dddd-4ddd-8ddd-${i.toString().padStart(12, '0')}`,
          actor: 'agent',
          toolName: 'readEmails',
          inputsHash: `h${i}`,
          approvalStatus: 'auto',
        });
      }
    }

    it('devuelve las filas más recientes primero, sin cursor', async () => {
      await seed(3);

      const result = await auditService.listRecent({
        limit: 10,
        cursor: undefined,
      });

      expect(result.items).toHaveLength(3);
      expect(result.items[0]?.inputsHash).toBe('h2');
      expect(result.items[2]?.inputsHash).toBe('h0');
      expect(result.nextCursor).toBeNull();
    });

    it('pagina con nextCursor cuando hay más filas que el límite', async () => {
      await seed(5);

      const page1 = await auditService.listRecent({
        limit: 2,
        cursor: undefined,
      });
      expect(page1.items).toHaveLength(2);
      expect(page1.items[0]?.inputsHash).toBe('h4');
      expect(page1.items[1]?.inputsHash).toBe('h3');
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await auditService.listRecent({
        limit: 2,
        cursor: page1.nextCursor ?? undefined,
      });
      expect(page2.items).toHaveLength(2);
      expect(page2.items[0]?.inputsHash).toBe('h2');
      expect(page2.items[1]?.inputsHash).toBe('h1');
      expect(page2.nextCursor).not.toBeNull();

      const page3 = await auditService.listRecent({
        limit: 2,
        cursor: page2.nextCursor ?? undefined,
      });
      expect(page3.items).toHaveLength(1);
      expect(page3.items[0]?.inputsHash).toBe('h0');
      expect(page3.nextCursor).toBeNull();
    });
  });
});
