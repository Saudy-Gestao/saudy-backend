import { FastifyInstance } from 'fastify';
import companyRoutes from './routes/companies';
import branchRoutes from './routes/branches';
import branchSettingsRoutes from './routes/branch-settings';
import sectorRoutes from './routes/sectors';
import accessRoutes from './routes/accesses';
import moduleRoutes from './routes/modules';
import userRoutes from './routes/users';
import authRoutes from './routes/auth';
import patientPortalRoutes from './routes/patient-portal';
import { registerSchemas } from './lib/openapi';

export default async function authModule(app: FastifyInstance) {
  registerSchemas(app);

  app.register(companyRoutes);
  app.register(branchRoutes);
  app.register(branchSettingsRoutes);
  app.register(sectorRoutes);
  app.register(accessRoutes);
  app.register(userRoutes);
  app.register(authRoutes);
  app.register(patientPortalRoutes);
  app.register(moduleRoutes);
}
