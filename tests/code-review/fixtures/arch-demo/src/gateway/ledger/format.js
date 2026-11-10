export function formatOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    label: order.name,
    amount: Number(order.amount || 0).toFixed(2),
  };
}

export function formatUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name };
}
