import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, PoolClient } from 'pg';

const DEFAULT_SCHEMA = 'public';

export function createPrismaAdapter() {
  const dbUrl = process.env.DATABASE_URL || '';
  const isSslEnabled = process.env.DATABASE_SSL === 'true';
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: isSslEnabled ? { rejectUnauthorized: false } : undefined,
  });

  pool.on('connect', (client: PoolClient) => {
    client.query(`SET search_path TO "${DEFAULT_SCHEMA}"`);
  });

  return new PrismaPg(pool);
}
