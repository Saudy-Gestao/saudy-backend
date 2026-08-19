import { FastifyInstance } from 'fastify';
import procedureRoutes from './routes/procedures';
import insuranceRoutes from './routes/insurances';
import insuranceProcedureRoutes from './routes/insurance-procedures';
import medicalEquipmentRoutes from './routes/medical-equipments';
import procedureAnamnesisTemplateRoutes from './routes/procedure-anamnesis-templates';
import procedureNursingTemplateRoutes from './routes/procedure-nursing-templates';
import modalidadeRoutes from './routes/modalidades';
import especialidadeRoutes from './routes/especialidades';
import cboRoutes from './routes/cbos';

export default async function proceduresModule(app: FastifyInstance) {
  app.register(procedureRoutes, { prefix: '/procedures' });
  app.register(insuranceRoutes, { prefix: '/insurances' });
  app.register(insuranceProcedureRoutes, { prefix: '/insurances' });
  app.register(medicalEquipmentRoutes, { prefix: '/medical-equipments' });
  app.register(procedureAnamnesisTemplateRoutes, { prefix: '/anamnesis-templates' });
  app.register(procedureNursingTemplateRoutes, { prefix: '/nursing-templates' });
  app.register(modalidadeRoutes, { prefix: '/modalidades' });
  app.register(especialidadeRoutes, { prefix: '/especialidades' });
  app.register(cboRoutes, { prefix: '/cbos' });
}
