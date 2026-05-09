import { FastifyInstance } from 'fastify';
import inventoryRoutes from './routes/inventory';
import financeRoutes from './routes/finance';
import invoiceRoutes from './routes/invoices';
import deliveryRoutes from './routes/deliveries';
import leadRoutes from './routes/leads';
import ticketRoutes from './routes/tickets';
import tissBatchRoutes from './routes/tiss-batches';
import biRoutes from './routes/bi';
import { openapiSchemas } from './lib/openapi';

export default async function adminModule(app: FastifyInstance) {
  for (const [id, schema] of Object.entries(openapiSchemas)) {
    app.addSchema({ $id: id, ...(schema as object) });
  }

  app.register(inventoryRoutes, { prefix: '/inventory' });
  app.register(financeRoutes, { prefix: '/finance' });
  app.register(invoiceRoutes, { prefix: '/invoices' });
  app.register(deliveryRoutes, { prefix: '/deliveries' });
  app.register(leadRoutes, { prefix: '/leads' });
  app.register(ticketRoutes, { prefix: '/tickets' });
  app.register(tissBatchRoutes, { prefix: '/tiss-batches' });
  app.register(biRoutes, { prefix: '/bi' });
}
