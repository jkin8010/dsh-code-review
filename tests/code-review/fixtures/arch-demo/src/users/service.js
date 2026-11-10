import { charge } from '../billing/charge.js';
import { findUser } from './repository.js';

export async function getUser(id) {
  const user = await findUser(id);
  if (!user) throw new Error('user not found');
  return user;
}

export async function purchase(userId, amount) {
  const user = await getUser(userId);
  return charge({ userId: user.id, amount });
}
