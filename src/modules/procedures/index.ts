import { FastifyInstance } from 'fastify';
import procedureRoutes from './routes/procedures';
import insuranceRoutes from './routes/insurances';
import medicalEquipmentRoutes from './routes/medical-equipments';
import procedureAnamnesisTemplateRoutes from './routes/procedure-anamnesis-templates';
import procedureNursingTemplateRoutes from './routes/procedure-nursing-templates';

export default async function proceduresModule(app: FastifyInstance) {
  app.register(procedureRoutes, { prefix: '/procedures' });
  app.register(insuranceRoutes, { prefix: '/insurances' });
  app.register(medicalEquipmentRoutes, { prefix: '/medical-equipments' });
  app.register(procedureAnamnesisTemplateRoutes, { prefix: '/anamnesis-templates' });
  app.register(procedureNursingTemplateRoutes, { prefix: '/nursing-templates' });
}
