import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Small shared vocabulary for every producer/consumer of review data.
 * Field shapes are owned by docs/CODE-REVIEW-CONTRACT.md.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const CATEGORIES = [
  'bug', 'security', 'performance', 'maintainability',
  'test', 'style', 'documentation', 'other',
];

const SEVERITY_RANK = new Map(SEVERITIES.map((severity, index) => [severity, index]));
const SEVERITY_ALIASES = new Map([
  ['blocker', 'critical'], ['fatal', 'critical'], ['error', 'high'], ['major', 'high'],
  ['moderate', 'medium'], ['warning', 'medium'], ['warn', 'medium'],
  ['minor', 'low'], ['info', 'low'], ['trivial', 'low'], ['nit', 'low'], ['suggestion', 'low'],
]);
const CATEGORY_ALIASES = new Map([
  ['correctness', 'bug'], ['defect', 'bug'], ['logic', 'bug'],
  ['sec', 'security'], ['vulnerability', 'security'],
  ['perf', 'performance'],
  ['maint', 'maintainability'], ['quality', 'maintainability'], ['refactor', 'maintainability'],
  ['testing', 'test'], ['tests', 'test'],
  ['docs', 'documentation'], ['doc', 'documentation'],
  ['style', 'style'], ['format', 'style'],
]);

export function nowIso() {
  return new Date().toISOString();
}

export function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return String(error.message ?? error.stack ?? error);
}

export function hash(text, length = 12) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, length);
}

export function slug(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'x';
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** Local-timezone calendar day key, matching how a developer reads commits. */
export function dateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(key, amount) {
  const [year, month, day] = String(key).split('-').map(Number);
  const date = new Date(year, month - 1, day + amount);
  return dateKey(date);
}

export function dayList(from, to) {
  const days = [];
  let cursor = String(from);
  const limit = 800;
  for (let index = 0; index < limit; index += 1) {
    days.push(cursor);
    if (cursor === to) break;
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function severityRank(severity) {
  return SEVERITY_RANK.get(normalizeSeverity(severity)) ?? SEVERITIES.length;
}

export function normalizeSeverity(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (SEVERITY_RANK.has(text)) return text;
  return SEVERITY_ALIASES.get(text) ?? 'low';
}

export function normalizeCategory(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (CATEGORIES.includes(text)) return text;
  return CATEGORY_ALIASES.get(text) ?? 'other';
}

export function firstSentence(text, max = 120) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const cut = flat.search(/[。.!?！？;；]\s/);
  const sentence = cut > 0 ? flat.slice(0, cut) : flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/**
 * Normalize any producer's finding (OCR comment or structural detector) into one
 * shape. `module` is derived from the path when the caller does not know it.
 */
export function finding(input = {}) {
  const path = String(input.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const startLine = Number.isFinite(Number(input.startLine ?? input.start_line)) ? Number(input.startLine ?? input.start_line) : 0;
  const endLine = Number.isFinite(Number(input.endLine ?? input.end_line)) ? Number(input.endLine ?? input.end_line) : startLine;
  const content = String(input.content ?? input.message ?? '').trim();
  const title = String(input.title ?? firstSentence(content));
  const severity = normalizeSeverity(input.severity);
  const category = normalizeCategory(input.category);
  const source = input.source === 'structural' ? 'structural' : 'ocr';
  const module = String(input.module ?? moduleOfPath(path));
  const fingerprint = input.fingerprint
    ?? hash([source, path, startLine, severity, title, content.slice(0, 400)].join('\u0000'), 16);
  return {
    id: String(input.id ?? `f-${fingerprint.slice(0, 12)}`),
    severity,
    category,
    path,
    startLine,
    endLine,
    title,
    content,
    suggestionCode: String(input.suggestionCode ?? input.suggestion_code ?? ''),
    existingCode: String(input.existingCode ?? input.existing_code ?? ''),
    thinking: trimText(input.thinking ?? '', 4000),
    source,
    rule: String(input.rule ?? ''),
    module,
  };
}

export function moduleOfPath(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  // Skip conventional source roots so `src/feature/x.ts` reports `feature`.
  if (['src', 'lib', 'app', 'packages', 'internal', 'pkg', 'cmd', 'source'].includes(parts[0])) {
    return parts[1] ?? parts[0];
  }
  return parts[0];
}

export function countFindings(findings = []) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  for (const item of findings) {
    const severity = normalizeSeverity(item?.severity);
    counts[severity] += 1;
    counts.total += 1;
  }
  return counts;
}

export function countBy(findings = [], key) {
  const table = new Map();
  for (const item of findings) {
    const value = String(item?.[key] ?? '').trim();
    if (!value) continue;
    table.set(value, (table.get(value) ?? 0) + 1);
  }
  return [...table.entries()]
    .map(([value, count]) => ({ key: value, count }))
    .sort((a, b) => b.count - a.count);
}

export function maxSeverity(findings = []) {
  let best = null;
  let rank = Number.POSITIVE_INFINITY;
  for (const item of findings) {
    const next = severityRank(item?.severity);
    if (next < rank) {
      rank = next;
      best = normalizeSeverity(item?.severity);
    }
  }
  return best;
}

export function trimText(value, max = 240) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

export function pct(part, total) {
  const a = Number(part) || 0;
  const b = Number(total) || 0;
  if (b <= 0) return 0;
  return Math.round((a / b) * 100);
}

export function readJsonFile(path, fallback = null) {
  try {
    const text = requireRead(path);
    return text === null ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

// Kept synchronous on purpose: callers are snapshot builders and constructors.
function requireRead(path) {
  return readFileSync(path, 'utf8');
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

export async function readJsonAsync(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Providers occasionally wrap JSON in prose or fences; recover the object. */
export function parseJsonLoose(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function agoText(value, now = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
