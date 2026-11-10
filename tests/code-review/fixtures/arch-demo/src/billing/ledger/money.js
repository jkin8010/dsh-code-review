export function formatMoney(amount) {
  const cents = Math.round(Number(amount) * 100);
  return `${(cents / 100).toFixed(2)} CNY`;
}

export function parseMoney(text) {
  const value = Number(String(text).replace(/[^\d.]/g, ''));
  return Number.isFinite(value) ? value : 0;
}
