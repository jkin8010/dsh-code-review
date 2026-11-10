import { listOrders } from '../api/orders.js';

export function routeAudit(payload) {
  return listOrders({ audit: payload });
}
