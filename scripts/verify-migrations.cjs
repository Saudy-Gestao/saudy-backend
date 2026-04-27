#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function verifyMigrations(options = {}) {
  const fsMod = options.fs || fs;
  const pathMod = options.path || path;
  const spawnSyncFn = options.spawnSync || spawnSync;
  const logger = options.logger || console;
  const root = options.root || process.cwd();
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const migrationsDir = pathMod.join(root, 'prisma', 'migrations');

  if (!fsMod.existsSync(migrationsDir)) {
    logger.error('prisma/migrations directory not found.');
    return 1;
  }

  const migrationDirs = fsMod
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const missingSql = migrationDirs.filter((dirName) => {
    const sqlFile = pathMod.join(migrationsDir, dirName, 'migration.sql');
    return !fsMod.existsSync(sqlFile);
  });

  if (missingSql.length > 0) {
    logger.error('Found migration directories without migration.sql:');
    for (const dirName of missingSql) {
      logger.error(`- prisma/migrations/${dirName}`);
    }
    return 1;
  }

  if (!databaseUrl) {
    logger.log('DATABASE_URL not set. Folder integrity verified; skipping prisma migrate status.');
    return 0;
  }

  const migrateStatus = spawnSyncFn(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'status', '--schema', 'prisma/schema.prisma'],
    { stdio: 'inherit', cwd: root },
  );

  if (migrateStatus.status !== 0) {
    return migrateStatus.status || 1;
  }

  logger.log('Migrations verification passed.');
  return 0;
}

module.exports = {
  verifyMigrations,
};

/* c8 ignore next 5 */
if (require.main === module) {
  const exitCode = verifyMigrations();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
