const { exec } = require('child_process');

function runCheckColumns(options = {}) {
  const execFn = options.exec || exec;
  const logger = options.logger || console;
  const env = options.env || process.env;

  execFn(
    'psql -U postgres -d saudy_db -h localhost -c "\\d branches"',
    { env: { ...env, PGPASSWORD: 'postgres' } },
    (error, stdout, stderr) => {
      if (error) {
        logger.error('Erro:', error.message);
        return;
      }
      if (stderr) {
        logger.error('Stderr:', stderr);
        return;
      }
      logger.log('📋 Colunas da tabela branches:');
      logger.log(stdout);
    },
  );
}

module.exports = { runCheckColumns };

/* c8 ignore next 3 */
if (require.main === module) {
  runCheckColumns();
}
