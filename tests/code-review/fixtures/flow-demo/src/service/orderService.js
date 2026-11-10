import { db } from '../db/index.js';
import { fetchJson } from '../client/upstream.js';

export async function createOrder(input) {
  const result = await db.run(
    'INSERT INTO orders (user_id, amount, status) VALUES (?, ?, ?)',
    [input.userId, input.amount, 'pending'],
  );
  const receipt = await fetchJson(result.lastID);
  return { id: result.lastID, receipt };
}
