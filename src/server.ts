import app from './app';
import prisma from './lib/prisma';

const start = async () => {
  const port = Number(process.env.PORT) || 3000;

  try {
    await prisma.$connect();

    app.log.info('✅ Databases connected');

    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`Server listening on http://0.0.0.0:${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

const shutdown = async () => {
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
