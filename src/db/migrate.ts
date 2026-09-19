import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { validateMigrationEnv } from '../config/env.schema';

async function main(): Promise<void> {
  const env = validateMigrationEnv(process.env);
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    console.log('Migraciones aplicadas.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Fallo al aplicar migraciones:', error);
  process.exit(1);
});
