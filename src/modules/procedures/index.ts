import { FastifyInstance } from 'fastify';
import procedureRoutes from './routes/procedures';
import insuranceRoutes from './routes/insurances';

export default async function proceduresModule(app: FastifyInstance) {
  app.register(procedureRoutes, { prefix: '/procedures' });
  app.register(insuranceRoutes, { prefix: '/insurances' });
}
