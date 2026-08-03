require('dotenv/config');
import { defineConfig } from 'prisma/config';

// Migrations need a direct (non-pooled) connection — pgbouncer transaction mode
// doesn't support the advisory locks / DDL Prisma Migrate relies on.
const migrateUrl =
  process.env.DIRECT_URL ||
  process.env.DATABASE_URL ||
  'postgresql://saudy_user:saudy_password@localhost:5432/saudy_db';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: migrateUrl,
  },
});
