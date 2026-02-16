import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, PoolClient } from 'pg';

const DEFAULT_SCHEMA = 'public';

export function createPrismaAdapter() {
  const dbUrl = process.env.DATABASE_URL || '';
  const pool = new Pool({ connectionString: dbUrl });

  pool.on('connect', (client: PoolClient) => {
    client.query(`SET search_path TO "${DEFAULT_SCHEMA}"`);
  });

  return new PrismaPg(pool);
}
