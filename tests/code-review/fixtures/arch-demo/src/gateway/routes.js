import { formatOrder } from './ledger/format.js';
import { validateId } from './ledger/validate.js';

export function createRoutes({ getUser, charge, listOrders }) {
  return {
    getUser,
    charge,
    listOrders,
    render: (order) => formatOrder(order),
    check: (id) => validateId(id),
  };
}
