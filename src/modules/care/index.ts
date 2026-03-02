import { FastifyInstance } from 'fastify';
import preAttendanceRoutes from './routes/pre-attendances';
import appointmentRoutes from './routes/appointments';
import consultationRoutes from './routes/consultations';
import reportRoutes from './routes/reports';
import envelopmentRoutes from './routes/envelopments';
import documentRoutes from './routes/documents';
import teaProfilesRoutes from './routes/tea-profiles';
import teaPreReservationsRoutes from './routes/tea-pre-reservations';

export default async function careModule(app: FastifyInstance) {
  app.register(preAttendanceRoutes, { prefix: '/pre-attendances' });
  app.register(appointmentRoutes, { prefix: '/appointments' });
  app.register(consultationRoutes, { prefix: '/consultations' });
  app.register(reportRoutes, { prefix: '/reports' });
  app.register(envelopmentRoutes, { prefix: '/envelopments' });
  app.register(documentRoutes, { prefix: '/documents' });
  app.register(teaProfilesRoutes, { prefix: '/tea-profiles' });
  app.register(teaPreReservationsRoutes, { prefix: '/tea-pre-reservations' });
}
