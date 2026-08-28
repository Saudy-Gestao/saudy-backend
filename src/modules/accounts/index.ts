import { FastifyInstance } from 'fastify';
import doctorRoutes from './routes/doctors';
import patientRoutes from './routes/patients';
import medicalRecordRoutes from './routes/medical-records';
import internRoutes from './routes/interns';
import { swaggerComponents } from './lib/openapi';

function stripExamples(obj: any) {
  return JSON.parse(JSON.stringify(obj, (key, value) => (key === 'example' ? undefined : value)));
}

export default async function accountsModule(app: FastifyInstance) {
  const safeSchemas: Record<string, any> = {};
  for (const [key, schema] of Object.entries(swaggerComponents.schemas)) {
    safeSchemas[key] = stripExamples(schema as any);
  }

  for (const [id, schema] of Object.entries(safeSchemas)) {
    app.addSchema({ $id: id, ...(schema as object) });
  }

  app.register(doctorRoutes, { prefix: '/doctors' });
  app.register(patientRoutes, { prefix: '/patients' });
  app.register(medicalRecordRoutes, { prefix: '/medical-records' });
  app.register(internRoutes, { prefix: '/interns' });
}
