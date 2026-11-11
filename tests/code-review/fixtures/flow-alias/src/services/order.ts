import { db } from '@/db/client';

export async function createOrder(input: unknown) {
  return db.insert('orders', input);
}
