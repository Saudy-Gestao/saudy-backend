import { FastifyInstance } from 'fastify';
import inventoryRoutes from './routes/inventory';
import financeRoutes from './routes/finance';
import invoiceRoutes from './routes/invoices';
import deliveryRoutes from './routes/deliveries';
import { openapiSchemas } from './lib/openapi';

export default async function adminModule(app: FastifyInstance) {
  for (const [id, schema] of Object.entries(openapiSchemas)) {
    app.addSchema({ $id: id, ...(schema as object) });
  }

  app.register(inventoryRoutes, { prefix: '/inventory' });
  app.register(financeRoutes, { prefix: '/finance' });
  app.register(invoiceRoutes, { prefix: '/invoices' });
  app.register(deliveryRoutes, { prefix: '/deliveries' });
}
