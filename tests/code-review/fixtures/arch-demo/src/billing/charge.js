import { getUser } from '../users/service.js';
import { withTax } from './ledger/tax.js';
import { formatMoney } from './ledger/money.js';

export async function charge({ userId, amount }) {
  const user = await getUser(userId);
  const total = withTax(amount);
  return { user: user.id, total, label: formatMoney(total) };
}
