import { routeAudit } from './router.js';

export function bootEngine() {
  routeAudit({ boot: true });
  return { started: true };
}
