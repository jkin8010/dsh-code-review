import { createHash } from 'node:crypto';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

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
  projectDepth: 2,
  maxProjects: 40,
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

/** `undefined`/`null`/`''`/whitespace mean "not configured" rather than `0`. */
function isUnset(value) {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (isUnset(value)) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) return fallback;
  return Math.min(max, Math.floor(number));
}

/**
 * Like `positiveInt` but `0` is a legal value ("no limit" for token budgets).
 * Unset stays `0`; a negative or non-numeric value falls back to the default
 * instead of being coerced to `0`, so a typo cannot silently mean "unlimited".
 */
function tokenBudget(value, fallback, max) {
  if (isUnset(value)) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
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
  if (isUnset(value)) return fallback;
  const text = String(value).trim().toLowerCase();
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
      maxTokens: tokenBudget(ocrRaw.maxTokens, DEFAULTS.ocr.maxTokens, 10_000_000),
      maxTokensBudget: tokenBudget(ocrRaw.maxTokensBudget, DEFAULTS.ocr.maxTokensBudget, 100_000_000),
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

/**
 * Resolve the `ocr` executable; an absolute configured path wins.
 *
 * The scan touches every PATH entry plus the nvm version directories, so the
 * result is memoized per configured command — startup, every review and the
 * RPC health probe all ask the same question. A relative command name is
 * returned as-is and resolved through PATH by execvp at spawn time, unless a
 * matching executable is found on disk (then that absolute path is pinned).
 */
const ocrBinaryCache = new Map();

export function findOcrBinary(config) {
  const configured = expandHome(config?.ocr?.command);
  // Include the running Node binary so an nvm switch (and its new ocr) invalidates the cache.
  const cacheKey = `${configured}\u0000${process.env.PATH ?? ''}\u0000${process.execPath}\u0000${process.env.NVM_BIN ?? ''}`;
  const cached = ocrBinaryCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let resolved;
  if (configured) {
    if (isAbsolute(configured)) {
      resolved = executable(configured) ? configured : '';
    } else {
      const found = pathCandidates().map((candidate) => dirname(candidate)).find(
        (dir) => isAbsolute(dir) && executable(join(dir, configured)),
      );
      resolved = found ? join(found, configured) : configured;
    }
  } else {
    resolved = '';
    for (const candidate of pathCandidates()) {
      if (executable(candidate)) {
        resolved = candidate;
        break;
      }
    }
    // Last resort: bare name, let execvp search PATH at spawn time.
    if (!resolved) resolved = 'ocr';
  }
  ocrBinaryCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * Environment handed to every `ocr` child process. Provider credentials that
 * live in the plugin config are injected here and never leave the Host process.
 * `ocr.llmTokenFile` is deliberately not read here (this must stay synchronous);
 * index.js loads it into `ocr.llmToken` at startup and ocr.js's `prepareEnv`
 * reads the file as a fallback — both paths end up in `OCR_LLM_TOKEN`.
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
  if (ocr.llmToken) return 'config';
  if (ocr.llmTokenFile) return 'file';
  if (env.OCR_LLM_TOKEN || env.OCR_LLM_URL) return 'env';
  if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) return 'env';
  return 'none';
}

/** Read the OCR token once during composition; the value never changes later. */
export function loadConfiguredToken(config) {
  if (config?.ocr?.llmToken || !config?.ocr?.llmTokenFile) return '';
  try {
    return readFileSync(config.ocr.llmTokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}
