import { parsePayload } from './ugly.js';

export function parseLeft(input) {
  const parsed = parsePayload(input);
  const rows = [];
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',');
    if (parts.length < 3) continue;
    rows.push({ id: parts[0], name: parts[1], value: parts[2] });
  }
  return rows;
}

export function parseRight(input) {
  const rows = [];
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',');
    if (parts.length < 3) continue;
    rows.push({ id: parts[0], name: parts[1], value: parts[2] });
  }
  return rows;
}
