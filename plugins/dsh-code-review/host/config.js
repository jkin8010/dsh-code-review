import { createHash } from 'node:crypto';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/**
 * Plugin configuration: defaults plus normalization.
 *
 * The DSH loader hands `apply(ctx, config)` the raw YAML object from the
 * profile patch. Every consumer below reads only the normalized shape, so a
 * typo in the patch degrades one group of settings instead of crashing the
 * plugin at mount time.
 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  pollSeconds: 2,
  projectRoots: [],
  extraProjects: [],
  defaultProjectPath: '',
  excludeProjects: [],
  stateDir: '~/.dsh/code-review',
  engine: 'auto',
  maxJobs: 200,
  heatmapDays: 365,
  gitScanLimit: 4000,
  ocr: Object.freeze({
    command: '',
    provider: '',
    model: '',
    llmUrl: '',
    llmToken: '',
    llmTokenFile: '',
    effort: 'medium',
    concurrency: 8,
    timeoutMin: 15,
    maxTokens: 0,
    maxTokensBudget: 0,
    extraArgs: [],
  }),
});

const ENGINE_MODES = new Set(['auto', 'ocr', 'structural']);
const EFFORTS = new Set(['low', 'medium', 'high']);

export function expandHome(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return join(homedir(), text.slice(2));
  return text;
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) return fallback;
  return Math.min(max, Math.floor(number));
}

function stringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => expandHome(item)).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => expandHome(item.trim())).filter(Boolean);
  }
  return [];
}

function pickEnum(value, allowed, fallback) {
  const text = String(value ?? '').trim().toLowerCase();
  return allowed.has(text) ? text : fallback;
}

/** Normalize one raw config object into the shared `Config` shape. */
export function normalizeConfig(rawConfig, { hostCwd } = {}) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const ocrRaw = raw.ocr && typeof raw.ocr === 'object' ? raw.ocr : {};
  const cwd = expandHome(hostCwd) || process.cwd();
  const defaultProjectPath = expandHome(raw.defaultProjectPath) || cwd;
  const engine = pickEnum(raw.engine, ENGINE_MODES, DEFAULTS.engine);
  const effort = pickEnum(ocrRaw.effort, EFFORTS, DEFAULTS.ocr.effort);

  return {
    enabled: raw.enabled !== false,
    pollSeconds: positiveInt(raw.pollSeconds, DEFAULTS.pollSeconds, 1, 60),
    projectRoots: stringList(raw.projectRoots),
    defaultProjectPath,
    excludeProjects: stringList(raw.excludeProjects),
    stateDir: expandHome(raw.stateDir) || join(homedir(), '.dsh', 'code-review'),
    engine,
    maxJobs: positiveInt(raw.maxJobs, DEFAULTS.maxJobs, 10, 2000),
    heatmapDays: positiveInt(raw.heatmapDays, DEFAULTS.heatmapDays, 30, 730),
    gitScanLimit: positiveInt(raw.gitScanLimit, DEFAULTS.gitScanLimit, 100, 20000),
    ocr: {
      command: String(ocrRaw.command ?? '').trim(),
      provider: String(ocrRaw.provider ?? '').trim(),
      model: String(ocrRaw.model ?? '').trim(),
      llmUrl: String(ocrRaw.llmUrl ?? '').trim(),
      llmToken: String(ocrRaw.llmToken ?? '').trim(),
      llmTokenFile: expandHome(ocrRaw.llmTokenFile),
      effort,
      concurrency: positiveInt(ocrRaw.concurrency, DEFAULTS.ocr.concurrency, 1, 32),
      timeoutMin: positiveInt(ocrRaw.timeoutMin, DEFAULTS.ocr.timeoutMin, 1, 240),
      maxTokens: positiveInt(ocrRaw.maxTokens, 0, 0, 10_000_000),
      maxTokensBudget: positiveInt(ocrRaw.maxTokensBudget, 0, 0, 100_000_000),
      extraArgs: Array.isArray(ocrRaw.extraArgs) ? ocrRaw.extraArgs.map(String) : [],
    },
  };
}

export function projectName(repoPath) {
  const clean = String(repoPath ?? '').replace(/[/\\]+$/, '');
  const parts = clean.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || clean || 'project';
}

export function projectId(repoPath) {
  const digest = createHash('sha1').update(String(repoPath ?? '')).digest('hex');
  return `p-${digest.slice(0, 10)}`;
}

function executable(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates() {
  const home = homedir();
  const list = [];
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (dir) list.push(join(dir, 'ocr'));
  }
  list.push(
    join(home, '.local', 'bin', 'ocr'),
    join(home, '.npm-global', 'bin', 'ocr'),
    '/opt/homebrew/bin/ocr',
    '/usr/local/bin/ocr',
    '/usr/bin/ocr',
  );
  // nvm keeps each Node version's global bin under its own directory.
  try {
    const nvm = join(home, '.nvm', 'versions', 'node');
    for (const version of readdirSync(nvm)) list.push(join(nvm, version, 'bin', 'ocr'));
  } catch {
    /* no nvm */
  }
  return list;
}

/** Resolve the `ocr` executable once; an absolute configured path wins. */
export function findOcrBinary(config) {
  const configured = expandHome(config?.ocr?.command);
  if (configured) {
    if (isAbsolute(configured)) return executable(configured) ? configured : '';
    return configured;
  }
  for (const candidate of pathCandidates()) {
    if (executable(candidate)) return candidate;
  }
  // Last resort: bare name, let execvp search PATH at spawn time.
  return 'ocr';
}

/**
 * Environment handed to every `ocr` child process. Provider credentials that
 * live in the plugin config are injected here and never leave the Host process.
 */
export function resolveOcrEnv(config, baseEnv = process.env) {
  const env = { ...baseEnv };
  const ocr = config?.ocr ?? {};
  if (ocr.llmUrl) env.OCR_LLM_URL = ocr.llmUrl;
  if (ocr.llmToken) env.OCR_LLM_TOKEN = ocr.llmToken;
  if (ocr.model) env.OCR_LLM_MODEL = ocr.model;
  return env;
}

/** Environment used to probe for LLM configuration without exposing secrets. */
export function llmConfigSource(config, env = process.env) {
  const ocr = config?.ocr ?? {};
  if (ocr.llmToken || ocr.llmTokenFile) return 'config';
  if (env.OCR_LLM_TOKEN || env.OCR_LLM_URL) return 'env';
  if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) return 'env';
  return 'none';
}
