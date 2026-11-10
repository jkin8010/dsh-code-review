import { db } from '../db/index.js';

export async function getUser(id) {
  const user = await db.get('SELECT id, name, email FROM users WHERE id = ?', [id]);
  return user ?? null;
}
