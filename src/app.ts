import fastify, { FastifyReply, FastifyRequest } from 'fastify';
import 'dotenv/config';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import authModule from './modules/auth';
import accountsModule from './modules/accounts';
import adminModule from './modules/admin';
import careModule from './modules/care';
import whatsappWebhookRoutes from './modules/care/routes/whatsapp-webhook';
import proceduresModule from './modules/procedures';
import dicomModule from './modules/dicom';
import dicomWebProxyModule from './modules/dicom-web-proxy';
import { startOrthancPoller } from './modules/dicom/orthanc';
import { MwlScp } from './modules/dicom/mwl';
import { startTemporaryDicomStudyCleanup } from './modules/dicom/temporary-prior-studies';

const app = fastify();

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error('JWT_SECRET is not set in environment variables');
}

const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.register(cors, {
  origin: corsOrigins.length > 0 ? corsOrigins : false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'Access-Control-Request-Headers', 'Access-Control-Request-Method'],
  exposedHeaders: ['Access-Control-Allow-Origin', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Methods'],
  credentials: true,
});

app.register(jwt, {
  secret: jwtSecret,
  sign: { expiresIn: '8h' },
});

app.register(swagger as any, {
  openapi: {
    info: {
      title: 'Saudy Monolith API',
      description: 'API monolítica consolidando auth, accounts, admin, care e procedures',
      version: '1.0.0',
    },
    servers: [{ url: `http://localhost:${process.env.PORT || 3000}` }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
});

app.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: true,
  },
});

app.get('/health', async (_request: FastifyRequest, _reply: FastifyReply) => {
  return { status: 'ok' };
});

app.get('/', async () => ({
  message: 'Saudy Monolith API',
  docs: '/docs',
  modules: ['/auth', '/accounts', '/admin', '/care', '/dicom', '/procedures'],
}));  

app.register(authModule, { prefix: '/auth' });
app.register(accountsModule, { prefix: '/accounts' });
app.register(adminModule, { prefix: '/admin' });
app.register(whatsappWebhookRoutes, { prefix: '/' });
app.register(careModule, { prefix: '/care' });
app.register(dicomModule, { prefix: '/dicom' });
app.register(dicomWebProxyModule, { prefix: '/dicom-web' });
app.register(proceduresModule, { prefix: '/procedures' });

// start Orthanc poller (if configured)
//startOrthancPoller();
startTemporaryDicomStudyCleanup();

// start DICOM MWL SCP
const mwlScp = new MwlScp();
mwlScp.start();

export default app;
