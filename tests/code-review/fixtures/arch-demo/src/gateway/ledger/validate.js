export function validateId(value) {
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) throw new Error('invalid id');
  return id;
}

export function validateAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid amount');
  return amount;
}
