const TAX_RATE = 0.06;

export function withTax(amount) {
  const base = Number(amount) || 0;
  return Math.round(base * (1 + TAX_RATE) * 100) / 100;
}

export function taxOf(amount) {
  return withTax(amount) - Number(amount || 0);
}
