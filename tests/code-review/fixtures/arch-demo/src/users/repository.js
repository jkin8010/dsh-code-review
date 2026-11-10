const USERS = new Map();

export async function findUser(id) {
  return USERS.get(id) ?? null;
}

export async function saveUser(user) {
  USERS.set(user.id, user);
  return user;
}
