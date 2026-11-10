import { formatOrder } from '../ledger/format.js';
import { validateId } from '../ledger/validate.js';

const TABLE = 'payments';
const PAGE_SIZE = 50;

export async function listPayments(req, res) {
  const query = req.query ?? {};
  const limit = Number(query.limit ?? PAGE_SIZE);
  const rows = await selectRows(limit);
  res.json({ ok: true, rows: rows.map(formatOrder) });
}

export async function detailPayments(req, res) {
  const id = validateId(req.params.id);
  const row = await selectRow(id);
  res.json({ ok: true, row: row ? formatOrder(row) : null });
}

export async function createPayments(req, res) {
  const body = req.body ?? {};
  const created = await insertRow(body);
  res.status(201).json({ ok: true, created });
}

export async function patchPayments(req, res) {
  const id = validateId(req.params.id);
  const body = req.body ?? {};
  const updated = await updateRow(id, body);
  res.json({ ok: true, updated });
}

export async function removePayments(req, res) {
  const id = validateId(req.params.id);
  const removed = await deleteRow(id);
  res.json({ ok: removed });
}

async function selectRows(limit) {
  const rows = [];
  for (let index = 0; index < limit; index += 1) {
    rows.push({ id: index, name: TABLE + '-' + index, amount: index * 10 });
  }
  return rows;
}

async function selectRow(id) {
  const rows = await selectRows(1);
  return rows.find((row) => row.id === id) ?? null;
}

async function insertRow(body) {
  const rows = await selectRows(1);
  return { id: rows.length, table: TABLE, body };
}

async function updateRow(id, body) {
  const row = await selectRow(id);
  return row ? { ...row, ...body } : null;
}

async function deleteRow(id) {
  const row = await selectRow(id);
  return Boolean(row);
}

function describePayments(row) {
  if (!row) return 'missing';
  return TABLE + ':' + row.id;
}

function summarizePayments(rows) {
  let total = 0;
  for (const row of rows) total += Number(row.amount || 0);
  return { count: rows.length, total, label: describePayments(rows[0]) };
}

export function healthPayments() {
  return { table: TABLE, warm: true };
}
