import { getUser } from '../users/service.js';
import { charge } from '../billing/charge.js';
import { bootEngine } from '../core/engine.js';
import { listOrders } from '../api/orders.js';
import { createRoutes } from './routes.js';
import { authGuard } from './middleware/auth.js';

export function createServer() {
  bootEngine();
  const routes = createRoutes({ getUser, charge, listOrders });
  return { routes, authGuard };
}
