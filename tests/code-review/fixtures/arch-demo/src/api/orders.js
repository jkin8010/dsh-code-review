import { routeAudit } from '../core/router.js';
import { getUser } from '../users/service.js';
import { charge } from '../billing/charge.js';

export function listOrders(filter) {
  return { filter, owner: getUser };
}

export function auditOrder(payload) {
  routeAudit(payload);
  return { ok: true, payload };
}

export function chargeOrder(payload) {
  return charge(payload);
}
