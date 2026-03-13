import { FastifyInstance } from 'fastify';
import preAttendanceRoutes from './routes/pre-attendances';
import appointmentRoutes from './routes/appointments';
import consultationRoutes from './routes/consultations';
import reportRoutes from './routes/reports';
import reportWorklistRoutes from './routes/report-worklist';
import reportTemplateRoutes from './routes/report-templates';
import reportPhraseRoutes from './routes/report-phrases';
import reportConfigRoutes from './routes/report-config';
import reportAddendumRoutes from './routes/report-addendums';
import envelopmentRoutes from './routes/envelopments';
import documentRoutes from './routes/documents';
import teaProfilesRoutes from './routes/tea-profiles';
import teaPreReservationsRoutes from './routes/tea-pre-reservations';
import convenioAuthorizationRoutes from './routes/convenio-authorizations';
import teaEvolutionTemplateRoutes from './routes/tea-evolution-templates';

export default async function careModule(app: FastifyInstance) {
  app.register(preAttendanceRoutes, { prefix: '/pre-attendances' });
  app.register(appointmentRoutes, { prefix: '/appointments' });
  app.register(consultationRoutes, { prefix: '/consultations' });
  app.register(reportRoutes, { prefix: '/reports' });
  app.register(reportWorklistRoutes, { prefix: '/report-worklist' });
  app.register(reportTemplateRoutes, { prefix: '/report-templates' });
  app.register(reportPhraseRoutes, { prefix: '/report-phrases' });
  app.register(reportConfigRoutes, { prefix: '/report-config' });
  app.register(reportAddendumRoutes, { prefix: '/report-addendums' });
  app.register(envelopmentRoutes, { prefix: '/envelopments' });
  app.register(documentRoutes, { prefix: '/documents' });
  app.register(teaProfilesRoutes, { prefix: '/tea-profiles' });
  app.register(teaPreReservationsRoutes, { prefix: '/tea-pre-reservations' });
  app.register(teaEvolutionTemplateRoutes, { prefix: '/tea-evolution-templates' });
  app.register(convenioAuthorizationRoutes, { prefix: '/convenio-authorizations' });
}
