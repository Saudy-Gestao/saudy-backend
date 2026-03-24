import { FastifyInstance } from 'fastify';
import procedureRoutes from './routes/procedures';
import insuranceRoutes from './routes/insurances';
import medicalEquipmentRoutes from './routes/medical-equipments';

export default async function proceduresModule(app: FastifyInstance) {
  app.register(procedureRoutes, { prefix: '/procedures' });
  app.register(insuranceRoutes, { prefix: '/insurances' });
  app.register(medicalEquipmentRoutes, { prefix: '/medical-equipments' });
}
