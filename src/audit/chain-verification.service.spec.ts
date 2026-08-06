import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.module';
import { ChainVerificationService } from './chain-verification.service';

// Aísla la lógica de ORQUESTACIÓN del servicio (cuándo persiste el lock)
// de la lógica de verificación en sí (`verifyChain`, ya cubierta a fondo
// en hash-chain.spec.ts) — mismo criterio que separar *.logic.ts de
// *.service.ts en el resto del repo. `vi.hoisted` porque `vi.mock` se
// hoistea sobre los imports, que es donde `chain-verification.service.ts`
// importa `verifyChain`.
const { verifyChainMock } = vi.hoisted(() => ({ verifyChainMock: vi.fn() }));
vi.mock('./hash-chain', async () => {
  const actual =
    await vi.importActual<typeof import('./hash-chain')>('./hash-chain');
  return { ...actual, verifyChain: verifyChainMock };
});

describe('ChainVerificationService', () => {
  let insertedValues: unknown[];
  let mockDb: {
    select: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  };
  let service: ChainVerificationService;

  let lockRows: unknown[];

  beforeEach(() => {
    verifyChainMock.mockReset();
    insertedValues = [];
    lockRows = [];
    // `isLocked()` encadena `.where(...)`, `verifyDaily()` encadena
    // `.orderBy(...)` sobre una tabla distinta — el mock de `from()`
    // soporta ambas formas, cada una resolviendo su propio dataset.
    mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => Promise.resolve(lockRows)),
          orderBy: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((v: unknown) => {
          insertedValues.push(v);
          return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    service = new ChainVerificationService(mockDb as unknown as Db);
  });

  it('isLocked() es false cuando no hay fila (nunca se detectó corrupción)', async () => {
    await expect(service.isLocked()).resolves.toBe(false);
  });

  it('isLocked() lee la fila persistida (docs/RECOMENDACIONES.md #12)', async () => {
    lockRows = [{ id: 1, locked: true }];

    await expect(service.isLocked()).resolves.toBe(true);
  });

  it('verifyDaily() con cadena válida no toca el lock', async () => {
    verifyChainMock.mockReturnValue({ valid: true });

    await service.verifyDaily();

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('verifyDaily() con cadena corrupta persiste locked:true + reason con el id de la fila rota', async () => {
    verifyChainMock.mockReturnValue({ valid: false, brokenAtId: 42n });

    await service.verifyDaily();

    expect(mockDb.insert).toHaveBeenCalled();
    const upserted = insertedValues[0] as {
      id: number;
      locked: boolean;
      lockedAt: Date | null;
      reason: string | null;
    };
    expect(upserted.locked).toBe(true);
    expect(upserted.lockedAt).toBeInstanceOf(Date);
    expect(upserted.reason).toContain('42');
  });

  it('unlock() persiste locked:false, lockedAt:null, reason:null', async () => {
    await service.unlock();

    expect(insertedValues[0]).toEqual({
      id: 1,
      locked: false,
      lockedAt: null,
      reason: null,
    });
  });
});
