import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { validateMigrationEnv } from '../config/env.schema';

interface JournalEntry {
  tag: string;
  when: number;
}
interface Journal {
  entries: JournalEntry[];
}

/**
 * Revierte la migración más reciente aplicando su `<tag>.down.sql`
 * hermano (AGENTS.md 1.2: "migraciones de DB siempre con up y down").
 * drizzle-kit no genera rollbacks — el down.sql se mantiene a mano junto
 * a cada migración generada.
 */
async function main(): Promise<void> {
  const env = validateMigrationEnv(process.env);
  const migrationsDir = path.resolve(process.cwd(), 'drizzle');
  const journal = JSON.parse(
    readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf-8'),
  ) as Journal;

  const last = journal.entries.at(-1);
  if (!last) {
    console.log('No hay migraciones registradas — nada que revertir.');
    return;
  }

  const downSql = readFileSync(
    path.join(migrationsDir, `${last.tag}.down.sql`),
    'utf-8',
  );

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    await pool.query('BEGIN');
    await pool.query(downSql);
    await pool.query(
      'DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1',
      [last.when],
    );
    await pool.query('COMMIT');
    console.log(`Rollback aplicado: ${last.tag}`);
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Fallo al revertir la migración:', error);
  process.exit(1);
});
