import { getUser } from '../users/service.js';

export async function describeUser(id) {
  const user = await getUser(id);
  return { id, name: user.id };
}
