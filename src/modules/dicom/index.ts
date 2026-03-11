import { FastifyInstance } from 'fastify';
import dicomRoutes from './routes';

export default async function dicomModule(app: FastifyInstance) {
  app.register(dicomRoutes, { prefix: '/' });
}
