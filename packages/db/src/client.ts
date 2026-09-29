import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type AssistantDb = ReturnType<typeof createDb>;

export interface DbOptions {
  connectionString: string;
  /** Small by default: this is a single-user desktop app, not a web service. */
  maxConnections?: number;
}

export function createDb(options: DbOptions) {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return drizzle(pool, { schema });
}

/** Verifies connectivity and that pgvector is present before the app starts. */
export async function assertDatabaseReady(db: AssistantDb): Promise<void> {
  const { rows } = await db.$client.query<{ installed: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed",
  );

  if (rows[0]?.installed !== true) {
    throw new Error(
      'The pgvector extension is not enabled on this database. ' +
        'Run: psql -d assistant -c "CREATE EXTENSION vector;"',
    );
  }
}
