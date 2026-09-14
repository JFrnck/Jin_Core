import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { Pool } from 'pg';
import * as schema from '../../src/db/schema';

// Pinneado (nunca `latest`) -- mismo tag que producción y
// docker-compose.dev.yaml (BLUEPRINT 3.3). Antes usaba el postgres:16
// genérico (HITL/audit no tocan pgvector), pero desde Fase 9.3
// (src/corpus/) `CREATE EXTENSION vector` necesita el binario de la
// extensión, que el postgres genérico no trae -- pgvector/pgvector es
// un superset estricto de la imagen oficial de Postgres 16, no debería
// romper ningún test existente.
const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.5-pg16';

export interface TestDb {
  pool: Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
  container: StartedPostgreSqlContainer;
  stop: () => Promise<void>;
}

/**
 * Levanta un Postgres real (testcontainers, AGENTS.md 6.2), aplica las
 * migraciones de Drizzle, y devuelve un cliente listo para usar.
 * Pensado para `beforeAll` en specs de integración.
 */
export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const db = drizzle(pool, { schema });

  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, '../../drizzle'),
  });

  return {
    pool,
    db,
    container,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
