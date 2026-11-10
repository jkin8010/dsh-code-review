/**
 * @jkin8010/dsh-code-review — host/ocr.js
 *
 * Thin, defensive adapter around the `ocr` CLI (alibaba/open-code-review).
 *
 * The Host owns every subprocess: probes (`--version`, `llm test`), previews
 * (`--preview --format json`) and real runs (`review` / `scan` with `--output`
 * into `<stateDir>/artifacts/<jobId>.json`). Nothing here throws: a missing
 * binary, an unconfigured LLM, a non-git directory or a timeout all resolve to
 * a classified Chinese error object so the job pipeline can report it.
 *
 * Live progress arrives on stderr as `[ocr] ...` lines; `runReview` parses them
 * into `onEvent` / `onProgress` callbacks while still writing the full log to
 * disk. `ocr llm test` is only ever spawned from `llmTest()` — reviews never
 * make a separate connectivity call.
 *
 * Node built-ins only — no third-party dependency.
 */

import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { expandHome, findOcrBinary, resolveOcrEnv } from './config.js';
import {
  clamp01, errorText, hash, parseJsonLoose,
} from './shared.js';

const PROBE_TIMEOUT_MS = 10_000;
const PREVIEW_TIMEOUT_MS = 120_000;
const LLM_TEST_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const STDERR_TAIL_LINES = 200;
const STDERR_KEEP_BYTES = 8 * 1024 * 1024;
const STDOUT_KEEP_BYTES = 4 * 1024 * 1024;

/** Review types map to `ocr review`; everything else scans whole files. */
const REVIEW_TYPES = new Set(['workspace', 'commit', 'range']);
const SCAN_TYPES = new Set(['module', 'scan', 'architecture', 'flow']);

const REVIEW_DEFAULT_TIMEOUT_MIN = 15;

const PROVIDER_HOSTS = [
  [/deepseek/i, 'deepseek'],
  [/openai|azure/i, 'openai'],
  [/anthropic|claude/i, 'anthropic'],
  [/dashscope|aliyuncs|bailian/i, 'qwen'],
  [/bigmodel|zhipu|glm/i, 'zhipu'],
  [/moonshot/i, 'moonshot'],
  [/volces|volcengine/i, 'doubao'],
  [/googleapis|generativelanguage/i, 'gemini'],
  [/bedrock/i, 'bedrock'],
  [/ollama|11434/i, 'ollama'],
];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function firstLine(text, max = 220) {
  const line = String(text ?? '').split('\n').map((item) => item.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function lastMeaningfulLine(text, max = 220) {
  const lines = String(text ?? '').split('\n').map((item) => item.trim()).filter(Boolean);
  const line = lines[lines.length - 1] ?? lines[0] ?? '';
  const cleaned = line.replace(/^(fatal|error):\s*/i, '');
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function tailLines(text, maxLines) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-maxLines);
}

function appendTail(current, text, maxBytes) {
  if (text.length >= maxBytes) return text.slice(text.length - maxBytes);
  const next = current + text;
  return next.length > maxBytes ? next.slice(next.length - maxBytes) : next;
}

function resolveProjectPath(value) {
  const text = expandHome(String(value ?? '').trim());
  return text ? resolve(text) : '';
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function commandForType(type) {
  const text = String(type ?? '').trim();
  if (REVIEW_TYPES.has(text)) return 'review';
  if (SCAN_TYPES.has(text)) return 'scan';
  return '';
}

/** Deduplicated, repo-relative paths (`--path` wants a comma-separated list). */
function normalizePaths(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const text = String(item ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function normalizeExclude(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '').trim()).filter(Boolean).join(',');
  }
  return String(value ?? '').trim();
}

function inferProvider(url) {
  const text = String(url ?? '').trim();
  if (!text) return '';
  for (const [pattern, name] of PROVIDER_HOSTS) {
    if (pattern.test(text)) return name;
  }
  return '';
}

function emptySummary() {
  return {
    filesReviewed: 0,
    comments: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    elapsed: 0,
  };
}

/** `ocr` reports elapsed as a Go duration string (`1m23s`); normalize to ms. */
function parseElapsed(value, fallbackMs = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const text = String(value ?? '').trim();
  if (!text) return fallbackMs;
  if (/^\d+$/.test(text)) return toInt(text) * 1000;
  let ms = 0;
  let matched = false;
  const hour = text.match(/(\d+(?:\.\d+)?)h/);
  if (hour) { ms += Number(hour[1]) * 3_600_000; matched = true; }
  const minute = text.match(/(\d+(?:\.\d+)?)m(?!s)/);
  if (minute) { ms += Number(minute[1]) * 60_000; matched = true; }
  const second = text.match(/(\d+(?:\.\d+)?)s/);
  if (second) { ms += Number(second[1]) * 1_000; matched = true; }
  const milli = text.match(/(\d+(?:\.\d+)?)ms/);
  if (milli) { ms += Number(milli[1]); matched = true; }
  return matched ? Math.round(ms) : fallbackMs;
}

function dedupeWarnings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = `${item.type}\u0000${item.file}\u0000${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 120);
}

function messageForCode(code, { stderr = '', exitCode = null, timeoutMinutes = 0 } = {}) {
  switch (code) {
    case 'ocr-missing':
      return '未找到 ocr CLI：请安装 alibaba/open-code-review（npm i -g @alibaba-group/open-code-review），或在插件配置 ocr.command / ocr.bin 指定绝对路径。';
    case 'llm-unconfigured':
      return 'OCR 尚未配置 LLM：请在插件配置 ocr.llmUrl 与 ocr.llmToken（或设置 OCR_LLM_URL / OCR_LLM_TOKEN），或运行 ocr config 配置 provider 后重试。';
    case 'git':
      return '当前项目不是可用的 git 仓库：review 需要 git 历史；可改用 scan 类型（module / architecture / flow），或换一个 git 项目。';
    case 'not-a-git-repo':
      return '当前目录不是 git 仓库：review 需要 git 历史；可改用 scan 类型（module / architecture / flow）。';
    case 'timeout':
      return `OCR 运行超时${timeoutMinutes ? `（任务预算 ${timeoutMinutes} 分钟）` : ''}：可缩小评审范围、降低并发，或调高 ocr.timeoutMin 后重试。`;
    case 'cancelled':
      return '评审已取消。';
    case 'invalid-type':
      return '未知的评审类型，无法映射到 ocr 命令。';
    case 'invalid-path':
      return '项目路径无效或不存在。';
    default: {
      const detail = lastMeaningfulLine(stderr);
      return detail
        ? `OCR 执行失败${exitCode !== null ? `（退出码 ${exitCode}）` : ''}：${detail}`
        : 'OCR 执行失败，请检查 ocr CLI 与 LLM 配置后重试。';
    }
  }
}

function classifyErrorText(text, result = {}) {
  if (result.missing) return 'ocr-missing';
  const combined = String(text ?? '');
  if (/no valid LLM endpoint|resolve LLM endpoint|OCR_LLM_URL|llm endpoint configured/i.test(combined)) {
    return 'llm-unconfigured';
  }
  if (/not a git repository|requires a valid git repository/i.test(combined)) return 'git';
  if (result.timedOut) return 'timeout';
  return 'ocr-failed';
}

/**
 * job-pipeline error codes are RPC codes (`code-review/<slug>`); the review
 * engine compares against them, while cancellation keeps the bare `cancelled`
 * code the contract specifies for a user-stopped run.
 */
function rpcErrorCode(slug) {
  return slug === 'cancelled' ? 'cancelled' : `code-review/${slug}`;
}

// ---------------------------------------------------------------------------
// binary / environment
// ---------------------------------------------------------------------------

/**
 * Pinned absolute binary wins (index.js resolves `config.ocr.bin` through
 * `findOcrBinary`), then the configured command / PATH discovery.
 */
function ocrBinary(config) {
  const pinned = String(config?.ocr?.bin ?? '').trim();
  if (pinned) return pinned;
  return findOcrBinary(config);
}

function buildChildEnv(binary, config, baseEnv = process.env) {
  const env = { ...resolveOcrEnv(config, baseEnv) };
  if (!env.PATH) env.PATH = baseEnv.PATH ?? '';
  // Keep PATH intact but make the resolved binary's directory win, so wrappers
  // that shell out to helper binaries behave the same as in a terminal.
  const binDir = isAbsolute(binary) ? dirname(binary) : '';
  env.PATH = [binDir, env.PATH].filter(Boolean).join(delimiter);
  return env;
}

async function prepareEnv(config, baseEnv = process.env) {
  const binary = ocrBinary(config);
  const env = buildChildEnv(binary, config, baseEnv);
  const tokenFile = expandHome(config?.ocr?.llmTokenFile);
  // config.js injects llmToken inline; a token *file* is read here so the
  // secret still never leaves the Host process.
  if (!env.OCR_LLM_TOKEN && tokenFile) {
    try {
      const token = (await readFile(tokenFile, 'utf8')).trim();
      if (token) env.OCR_LLM_TOKEN = token;
    } catch {
      /* unreadable token file is reported by probeLlm/run failures instead */
    }
  }
  return env;
}

/** Capture one short-lived ocr invocation (probe / preview / llm test). */
function execCapture(binary, args, { cwd = process.cwd(), env = process.env, timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise) => {
    if (!binary) {
      resolvePromise({
        ok: false, missing: true, code: null, stdout: '', stderr: '', error: '未找到 ocr CLI', timedOut: false,
      });
      return;
    }
    execFile(binary, args, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : '';
      const err = typeof stderr === 'string' ? stderr : '';
      if (!error) {
        resolvePromise({
          ok: true, missing: false, code: 0, stdout: out, stderr: err, error: null, timedOut: false,
        });
        return;
      }
      resolvePromise({
        ok: false,
        missing: error.code === 'ENOENT',
        code: typeof error.code === 'number' ? error.code : null,
        stdout: out,
        stderr: err,
        error: errorText(error),
        timedOut: Boolean(error.killed),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

/**
 * `ocr --version` probe: `{ available, version:'v1.13.6', path, error }`.
 * Version is normalized to `vX.Y.Z`; the raw output is never returned.
 */
export async function probe({ config, env = process.env } = {}) {
  const binary = ocrBinary(config);
  const result = await execCapture(binary, ['--version', '--color', 'never'], {
    env: await prepareEnv(config, env),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (result.missing) {
    return {
      available: false,
      version: '',
      path: String(binary ?? 'ocr'),
      error: messageForCode('ocr-missing'),
    };
  }
  if (!result.ok) {
    return {
      available: false,
      version: '',
      path: binary,
      error: `ocr --version 执行失败：${firstLine(result.stderr || result.error)}`,
    };
  }
  const match = `${result.stdout}\n${result.stderr}`.match(/open-code-review\s+v?(\d+\.\d+\.\d+)/i);
  if (!match) {
    return {
      available: true, version: '', path: binary, error: '无法从 ocr --version 输出解析版本号',
    };
  }
  return {
    available: true, version: `v${match[1]}`, path: binary, error: null,
  };
}

// ---------------------------------------------------------------------------
// probeLlm
// ---------------------------------------------------------------------------

/**
 * Read `~/.opencodereview/config.json` for provider/model only.
 * Tokens, URLs and commands are deliberately ignored here — nothing secret may
 * ever appear in the returned snapshot / logs.
 */
function llmFromConfigFile(configFile) {
  if (!configFile || typeof configFile !== 'object') return null;
  const provider = String(configFile.provider ?? '').trim();
  if (provider) {
    const section = configFile.providers?.[provider] ?? configFile.custom_providers?.[provider];
    const model = String(section?.model ?? '').trim()
      || String(configFile.model ?? '').trim()
      || String(section?.models?.[0] ?? '').trim();
    if (section || model) return { provider, model };
  }
  const llm = configFile.llm && typeof configFile.llm === 'object' ? configFile.llm : null;
  if (llm) {
    const hasLlm = String(llm.url ?? '').trim()
      || String(llm.auth_token ?? '').trim()
      || String(llm.model ?? '').trim();
    if (hasLlm) return { provider: inferProvider(llm.url), model: String(llm.model ?? '').trim() };
  }
  const model = String(configFile.model ?? '').trim();
  return model ? { provider: '', model } : null;
}

/**
 * Static LLM-configured probe — no network, no `ocr llm test`.
 *
 * Precedence: plugin-injected credentials → OCR_LLM_* env → ~/.opencodereview/
 * config.json provider/model → ANTHROPIC_* env. Returns `source` as
 * `config|env|file|none`, matching the snapshot health contract.
 */
export async function probeLlm({ config, env = process.env } = {}) {
  const ocr = config?.ocr ?? {};
  const base = {
    configured: false, provider: '', model: '', source: 'none', error: null,
  };

  if (String(ocr.llmToken ?? '').trim() || String(ocr.llmTokenFile ?? '').trim()) {
    return {
      configured: true,
      provider: String(ocr.provider ?? '').trim(),
      model: String(ocr.model ?? '').trim(),
      source: 'config',
      error: null,
    };
  }

  const envToken = String(env?.OCR_LLM_TOKEN ?? '').trim();
  const envUrl = String(env?.OCR_LLM_URL ?? '').trim();
  if (envToken || envUrl) {
    return {
      configured: true,
      provider: String(ocr.provider ?? '').trim() || inferProvider(envUrl),
      model: String(ocr.model ?? '').trim() || String(env?.OCR_LLM_MODEL ?? '').trim(),
      source: 'env',
      error: null,
    };
  }

  const configPath = join(homedir(), '.opencodereview', 'config.json');
  let fileError = null;
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const found = llmFromConfigFile(parsed);
    if (found) {
      return {
        configured: true, provider: found.provider, model: found.model, source: 'file', error: null,
      };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') fileError = `无法读取 ${configPath}：${errorText(error)}`;
  }

  if (String(env?.ANTHROPIC_AUTH_TOKEN ?? '').trim() || String(env?.ANTHROPIC_BASE_URL ?? '').trim()) {
    return {
      configured: true,
      provider: 'anthropic',
      model: String(env?.ANTHROPIC_MODEL ?? '').trim(),
      source: 'env',
      error: null,
    };
  }

  return { ...base, error: fileError };
}

// ---------------------------------------------------------------------------
// llmTest
// ---------------------------------------------------------------------------

/**
 * The only place that runs `ocr llm test`. Returns
 * `{ ok, latencyMs, message, error }` with an actionable Chinese message.
 */
export async function llmTest({ config, env = process.env } = {}) {
  const binary = ocrBinary(config);
  if (!binary) {
    return {
      ok: false, latencyMs: 0, message: messageForCode('ocr-missing'), error: 'ocr-missing',
    };
  }
  const startedAt = Date.now();
  const result = await execCapture(binary, ['llm', 'test', '--color', 'never'], {
    env: await prepareEnv(config, env),
    timeoutMs: LLM_TEST_TIMEOUT_MS,
  });
  const latencyMs = Date.now() - startedAt;
  const combined = `${result.stdout}\n${result.stderr}`;

  if (result.missing) {
    return {
      ok: false, latencyMs, message: messageForCode('ocr-missing'), error: 'ocr-missing',
    };
  }
  if (!result.ok) {
    const code = classifyErrorText(combined, result);
    return {
      ok: false,
      latencyMs,
      message: messageForCode(code, { stderr: combined, exitCode: result.code }),
      error: code,
    };
  }

  const success = /Connection test successful|✓/i.test(combined);
  const model = combined.match(/^Model:\s*(.+)$/m)?.[1]?.trim() ?? '';
  if (!success) {
    return {
      ok: false,
      latencyMs,
      message: `LLM 测试未返回成功标记：${firstLine(combined)}`,
      error: 'ocr-failed',
    };
  }
  return {
    ok: true,
    latencyMs,
    message: `LLM 连接正常${model ? `（${model}）` : ''}，耗时 ${latencyMs}ms`,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

/**
 * `ocr review|scan --preview --format json` → normalized plan:
 * `{ ok, mode, files:[{path,insertions,deletions,status,willReview,reason}],
 *    totalInsertions, totalDeletions, reviewable, excluded, error }`.
 *
 * A non-git directory in review mode returns `error:'not-a-git-repo'`; scan
 * mode works without git history. `message` carries the actionable detail.
 */
export async function preview({
  projectPath, type = 'workspace', scope = {}, config, env = process.env,
} = {}) {
  const command = commandForType(type);
  const mode = command || 'review';
  const empty = {
    ok: false,
    mode,
    files: [],
    totalInsertions: 0,
    totalDeletions: 0,
    reviewable: 0,
    excluded: 0,
    error: null,
    message: '',
  };

  if (!command) return { ...empty, error: 'invalid-type', message: messageForCode('invalid-type') };
  const root = resolveProjectPath(projectPath);
  if (!root) return { ...empty, error: 'invalid-path', message: messageForCode('invalid-path') };
  if (!(await isDirectory(root))) {
    return { ...empty, error: 'invalid-path', message: `项目路径不存在或不是目录：${root}` };
  }
  const binary = ocrBinary(config);
  if (!binary) return { ...empty, error: 'ocr-missing', message: messageForCode('ocr-missing') };

  const args = [command, '--preview', '--format', 'json', '--repo', root, '--color', 'never'];
  if (command === 'review') {
    if (type === 'commit') {
      const commit = String(scope?.commit ?? '').trim();
      if (!commit) return { ...empty, error: 'git', message: 'commit 评审缺少 commit 参数。' };
      args.push('--commit', commit);
    } else if (type === 'range') {
      const from = String(scope?.from ?? '').trim();
      const to = String(scope?.to ?? '').trim();
      if (!from || !to) return { ...empty, error: 'git', message: 'range 评审缺少 from/to 参数。' };
      args.push('--from', from, '--to', to);
    }
  } else {
    const paths = normalizePaths(scope?.paths);
    if (paths.length) args.push('--path', paths.join(','));
  }

  const result = await execCapture(binary, args, {
    cwd: root,
    env: await prepareEnv(config, env),
    timeoutMs: PREVIEW_TIMEOUT_MS,
  });

  if (result.missing) return { ...empty, error: 'ocr-missing', message: messageForCode('ocr-missing') };
  if (!result.ok) {
    const combined = `${result.stderr}\n${result.stdout}`;
    if (/not a git repository|requires a valid git repository/i.test(combined)) {
      return { ...empty, error: 'not-a-git-repo', message: messageForCode('not-a-git-repo') };
    }
    const code = classifyErrorText(combined, result);
    return {
      ...empty,
      error: code,
      message: messageForCode(code, { stderr: combined, exitCode: result.code }),
    };
  }

  const parsed = parseJsonLoose(result.stdout) ?? parseJsonLoose(result.stderr);
  if (!parsed || typeof parsed !== 'object') {
    return {
      ...empty,
      error: 'ocr-failed',
      message: `ocr ${command} --preview 未输出可解析的 JSON：${firstLine(result.stderr || result.stdout)}`,
    };
  }

  const files = (Array.isArray(parsed.files) ? parsed.files : []).map((entry) => ({
    path: String(entry?.path ?? ''),
    insertions: toInt(entry?.insertions),
    deletions: toInt(entry?.deletions),
    status: String(entry?.status ?? ''),
    willReview: Boolean(entry?.will_review),
    reason: String(entry?.exclude_reason ?? ''),
  }));

  return {
    ok: true,
    mode: command,
    files,
    totalInsertions: toInt(parsed.total_insertions),
    totalDeletions: toInt(parsed.total_deletions),
    reviewable: toInt(parsed.reviewable_count),
    excluded: toInt(parsed.excluded_count),
    error: null,
    message: '',
  };
}

// ---------------------------------------------------------------------------
// progress parsing
// ---------------------------------------------------------------------------

/**
 * Turns `[ocr] ...` stderr lines into `onEvent` + bounded `onProgress` updates.
 *
 * OCR does not announce its total group count when LLM grouping runs, so the
 * fraction is an estimate: exact when the grouping line reports a shape
 * ("one group" / "per file" / "N groups"), otherwise file count / 3 capped by
 * observed groups. The job layer owns final progress, this only smooths the
 * AI stage.
 */
function createProgressTracker({ onEvent, onProgress } = {}) {
  const groups = new Map(); // label -> { files, completed }
  const groupFindings = new Map();
  const batches = new Set();
  const warnings = [];
  const state = {
    sessionId: '',
    totalFiles: 0,
    reviewFiles: 0,
    totalGroups: 0,
    totalBatches: 0,
    phase: '准备中',
    round: 0,
    maxRounds: 0,
  };
  let completedFiles = 0;

  function ensureGroup(label) {
    const key = String(label ?? '').trim();
    if (!groups.has(key)) {
      const files = key.split(',').filter(Boolean).length || 1;
      groups.set(key, { files, completed: false });
    }
    return groups.get(key);
  }

  function markGroupComplete(label) {
    const group = ensureGroup(label);
    if (group.completed) return;
    group.completed = true;
    completedFiles += group.files;
  }

  function completedGroupCount() {
    let count = 0;
    for (const group of groups.values()) if (group.completed) count += 1;
    return count;
  }

  function findingsTotal() {
    let total = 0;
    for (const count of groupFindings.values()) total += count;
    return total;
  }

  function estimatedGroups() {
    if (state.totalGroups > 0) return state.totalGroups;
    if (state.reviewFiles > 0) return Math.max(1, Math.ceil(state.reviewFiles / 3));
    return Math.max(1, completedGroupCount() + 1);
  }

  function emit(phase, patch = {}) {
    if (typeof onProgress !== 'function') return;
    state.phase = phase;
    const completed = completedGroupCount();
    let fraction = 0;
    let detail = '';
    if (state.totalBatches > 0) {
      // Scan batches: leave the last 10% for dedup + project summary phases.
      fraction = Math.min(0.9, (batches.size / state.totalBatches) * 0.9);
      detail = `已完成 ${batches.size}/${state.totalBatches} 批`;
    } else {
      const total = estimatedGroups();
      fraction = completed > 0 ? Math.min(0.99, completed / total) : 0;
      if (completed > 0) detail = `已完成 ${completed}/${total} 组`;
      else if (phase === 'dispatch') detail = '准备评审…';
      else detail = '分析中…';
    }
    const progress = {
      fraction: clamp01(fraction),
      detail,
      phase,
      group: '',
      round: state.round,
      maxRounds: state.maxRounds,
      findings: findingsTotal(),
      filesDone: completedFiles,
    };
    Object.assign(progress, patch);
    if (patch && patch.detail) progress.detail = patch.detail;
    progress.fraction = clamp01(progress.fraction);
    try {
      onProgress(progress);
    } catch {
      /* progress callbacks must never break the run */
    }
  }

  function handleLine(rawLine) {
    const text = String(rawLine ?? '').replace(/\r$/, '');
    if (!text.trim()) return;
    const body = text.startsWith('[ocr]') ? text.slice(5).trim() : text.trim();

    const level = /^WARNING\b/i.test(body) || /\bWARNING:/.test(body)
      ? 'warn'
      : /(panic|Subtask error|subtask error|failed|error:)/i.test(body) ? 'error' : 'info';
    if (typeof onEvent === 'function') {
      try {
        onEvent({ level, text: body });
      } catch {
        /* ignore */
      }
    }
    if (level === 'warn') {
      warnings.push({ type: 'warning', file: '', message: body.replace(/^WARNING:\s*/i, '') });
    }

    const subtask = body.match(/^Subtask error for group "(.+?)":\s*(.*)$/);
    if (subtask) warnings.push({ type: 'subtask_error', file: subtask[1], message: subtask[2] || body });
    const scanSubtask = body.match(/^Scan subtask error for (.+?)(?: \(batch #\d+\))?:\s*(.*)$/);
    if (scanSubtask) warnings.push({ type: 'subtask_error', file: scanSubtask[1], message: scanSubtask[2] || body });

    const session = body.match(/^Session:\s*(\S+)/);
    if (session) {
      state.sessionId = session[1];
      return;
    }

    const dispatch = body.match(/^(\d+) file\(s\) changed, reviewing (\d+)/);
    if (dispatch) {
      state.totalFiles = toInt(dispatch[1]);
      state.reviewFiles = toInt(dispatch[2]);
      emit('dispatch', { detail: `共 ${state.totalFiles} 个改动文件，评审 ${state.reviewFiles} 个` });
      return;
    }
    const scanDispatch = body.match(/^full-scan: (\d+) file\(s\) discovered, reviewing (\d+)/);
    if (scanDispatch) {
      state.totalFiles = toInt(scanDispatch[1]);
      state.reviewFiles = toInt(scanDispatch[2]);
      emit('dispatch', { detail: `扫描 ${state.reviewFiles} 个文件` });
      return;
    }
    const scanBatches = body.match(/^scan dispatch: (\d+) batch/);
    if (scanBatches) {
      state.totalBatches = toInt(scanBatches[1]);
      emit('dispatch', { detail: `共 ${state.totalBatches} 批` });
      return;
    }

    const grouping = body.match(/^Skipping LLM grouping for \d+ file\(s\).*?—\s*(.+)$/);
    if (grouping) {
      const shape = grouping[1].trim();
      if (/one group/i.test(shape)) {
        state.totalGroups = Math.max(state.totalGroups, 1);
      } else if (/per file/i.test(shape)) {
        state.totalGroups = Math.max(state.totalGroups, state.reviewFiles || 1);
      } else {
        const count = shape.match(/(\d+)\s+groups/i);
        if (count) state.totalGroups = Math.max(state.totalGroups, toInt(count[1]));
      }
      return;
    }
    if (/^LLM grouping failed/i.test(body)) {
      state.totalGroups = Math.max(state.totalGroups, state.reviewFiles || 1);
      return;
    }

    const planned = body.match(/^Plan completed for group "(.+?)"/);
    if (planned) {
      ensureGroup(planned[1]);
      emit('plan', { group: planned[1] });
      return;
    }

    const reached = body.match(/^Group "(.+?)" reached (\d+) confirmed findings/);
    if (reached) {
      ensureGroup(reached[1]);
      groupFindings.set(reached[1], Math.max(groupFindings.get(reached[1]) ?? 0, toInt(reached[2])));
      markGroupComplete(reached[1]);
      emit('review', { group: reached[1], findings: findingsTotal() });
      return;
    }
    const noNew = body.match(/^Round (\d+)\/(\d+) added no new findings for group "(.+?)"/);
    if (noNew) {
      state.round = toInt(noNew[1]);
      state.maxRounds = toInt(noNew[2]);
      markGroupComplete(noNew[3]);
      emit('review', { group: noNew[3], round: state.round, maxRounds: state.maxRounds });
      return;
    }
    const roundFailed = body.match(/^Round (\d+) failed for group "(.+?)"/);
    if (roundFailed) {
      state.round = toInt(roundFailed[1]);
      markGroupComplete(roundFailed[2]);
      emit('review', { group: roundFailed[2], round: state.round });
      return;
    }
    const filterRemoved = body.match(/^Review filter removed (\d+) comment\(s\) for group "(.+?)"/);
    if (filterRemoved) {
      const label = filterRemoved[2];
      const removed = toInt(filterRemoved[1]);
      groupFindings.set(label, Math.max(0, (groupFindings.get(label) ?? 0) - removed));
      markGroupComplete(label);
      emit('filter', { group: label, findings: findingsTotal() });
      return;
    }
    const filterSkipped = body.match(/^Review filter (?:skipped|failed) for group "(.+?)"/);
    if (filterSkipped) {
      markGroupComplete(filterSkipped[1]);
      emit('filter', { group: filterSkipped[1] });
      return;
    }

    const dedup = body.match(/^scan dedup batch #(\d+)/);
    if (dedup) {
      batches.add(toInt(dedup[1]));
      emit('dedup', {
        detail: state.totalBatches > 0
          ? `已完成 ${batches.size}/${state.totalBatches} 批`
          : `已完成 ${batches.size} 批`,
      });
      return;
    }

    if (/^estimated cost:/.test(body) || /^token budget:/.test(body)) {
      emit('budget');
    }
  }

  return {
    handleLine,
    warnings,
    get sessionId() {
      return state.sessionId;
    },
  };
}

// ---------------------------------------------------------------------------
// live subprocess (runReview)
// ---------------------------------------------------------------------------

/**
 * Spawn the long-running review with live stderr parsing, timeout and
 * SIGTERM→(2s)→SIGKILL cancellation.
 */
function spawnReview({
  binary, args, cwd, env, timeoutMs, signal, onLine,
}) {
  return new Promise((resolvePromise) => {
    const base = {
      missing: false,
      spawnError: false,
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      cancelled: false,
      elapsedMs: 0,
      error: null,
    };
    if (!binary) {
      resolvePromise({ ...base, missing: true, error: '未找到 ocr CLI' });
      return;
    }
    if (signal?.aborted) {
      resolvePromise({ ...base, cancelled: true, error: '已取消' });
      return;
    }

    const startedAt = Date.now();
    let child;
    try {
      child = spawn(binary, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({ ...base, spawnError: true, error: errorText(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let killTimer = null;
    let hardTimer = null;

    const finalize = (extra) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
      const final = {
        ...base,
        ...extra,
        stdout,
        stderr,
        timedOut,
        cancelled: cancelled || Boolean(signal?.aborted && extra?.cancelled),
        elapsedMs: Date.now() - startedAt,
      };
      final.ok = !final.spawnError && !final.missing && !final.timedOut
        && !final.cancelled && final.code === 0;
      resolvePromise(final);
    };

    const killChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };

    function onAbort() {
      cancelled = true;
      killChild();
    }

    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      hardTimer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, timeoutMs);
      hardTimer.unref?.();
    }

    const consume = (text) => {
      pendingLine += text;
      let index = pendingLine.indexOf('\n');
      while (index >= 0) {
        const line = pendingLine.slice(0, index).replace(/\r$/, '');
        pendingLine = pendingLine.slice(index + 1);
        if (line.trim()) {
          try {
            onLine?.(line);
          } catch {
            /* parser must never break the run */
          }
        }
        index = pendingLine.indexOf('\n');
      }
    };

    child.stdout?.on('data', (chunk) => {
      stdout = appendTail(stdout, chunk.toString(), STDOUT_KEEP_BYTES);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = appendTail(stderr, text, STDERR_KEEP_BYTES);
      consume(text);
    });
    child.on('error', (error) => {
      finalize({
        spawnError: error?.code !== 'ENOENT',
        missing: error?.code === 'ENOENT',
        error: errorText(error),
      });
    });
    child.on('close', (code, signalName) => {
      if (pendingLine.trim()) {
        try {
          onLine?.(pendingLine.trim());
        } catch {
          /* ignore */
        }
      }
      finalize({ code, signal: signalName, error: null });
    });
  });
}

// ---------------------------------------------------------------------------
// runReview
// ---------------------------------------------------------------------------

function normalizeComment(comment = {}) {
  return {
    path: String(comment.path ?? ''),
    content: String(comment.content ?? ''),
    start_line: toInt(comment.start_line),
    end_line: toInt(comment.end_line),
    category: String(comment.category ?? ''),
    severity: String(comment.severity ?? ''),
    suggestion_code: String(comment.suggestion_code ?? ''),
    existing_code: String(comment.existing_code ?? ''),
    thinking: String(comment.thinking ?? ''),
  };
}

function mapSummary(rawSummary, commentCount, fallbackElapsedMs) {
  const summary = rawSummary && typeof rawSummary === 'object' ? rawSummary : {};
  return {
    filesReviewed: toInt(summary.files_reviewed),
    comments: toInt(summary.comments) || commentCount,
    totalTokens: toInt(summary.total_tokens),
    inputTokens: toInt(summary.input_tokens),
    outputTokens: toInt(summary.output_tokens),
    elapsed: parseElapsed(summary.elapsed, fallbackElapsedMs),
  };
}

/**
 * Run a real `ocr review` / `ocr scan`.
 *
 * JSON result is written to `<stateDir>/artifacts/<jobId>.json`, the full
 * stderr log to `<jobId>.log`, and the parsed comments are returned as OCR's
 * own raw field names (`path/content/start_line/...`) for `host/jobs.js` to
 * normalize. Failures resolve to `{ ok:false, error:{ code, message } }`, where
 * `code` is the RPC form `code-review/<slug>` for
 * `ocr-missing|llm-unconfigured|git|timeout|ocr-failed`; a user cancellation
 * keeps the contract's bare `cancelled`.
 */
export async function runReview({
  projectPath,
  type = 'workspace',
  scope = {},
  plan = null,
  config = {},
  env = process.env,
  background = '',
  rules = null,
  exclude = '',
  signal,
  onEvent,
  onProgress,
  jobId = '',
  timeoutMs = 0,
} = {}) {
  const command = commandForType(type);
  const root = resolveProjectPath(projectPath);
  const ocr = config?.ocr ?? {};
  const stateDir = expandHome(config?.stateDir) || join(homedir(), '.dsh', 'code-review');
  const artifactsDir = join(stateDir, 'artifacts');
  const safeId = String(jobId || `ocr-${Date.now()}-${hash(String(Math.random()), 6)}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '-');
  const rawOutputPath = join(artifactsDir, `${safeId}.json`);
  const logPath = join(artifactsDir, `${safeId}.log`);

  const resultBase = () => ({
    ok: false,
    status: 'failed',
    comments: [],
    summary: emptySummary(),
    projectSummary: '',
    warnings: [],
    sessionId: '',
    manifest: null,
    llm: null,
    rawOutputPath,
    stderrTail: [],
    error: null,
  });
  const fail = (code, message, extra = {}) => ({
    ...resultBase(),
    ...extra,
    error: { code: rpcErrorCode(code), message },
  });

  if (!command) return fail('invalid-type', messageForCode('invalid-type'));
  if (!root) return fail('git', messageForCode('invalid-path'));
  if (signal?.aborted) return fail('cancelled', messageForCode('cancelled'), { status: 'cancelled' });
  if (!(await isDirectory(root))) {
    return fail('git', `项目路径不存在或不是目录：${root}`);
  }

  const binary = ocrBinary(config);
  if (!binary) return fail('ocr-missing', messageForCode('ocr-missing'));

  if (command === 'review') {
    if (type === 'commit' && !String(scope?.commit ?? '').trim()) {
      return fail('git', 'commit 评审缺少 commit 参数。');
    }
    if (type === 'range' && (!String(scope?.from ?? '').trim() || !String(scope?.to ?? '').trim())) {
      return fail('git', 'range 评审缺少 from/to 参数。');
    }
  }

  try {
    await mkdir(artifactsDir, { recursive: true });
  } catch (error) {
    return fail('ocr-failed', `无法创建 artifacts 目录 ${artifactsDir}：${errorText(error)}`);
  }

  let childEnv;
  try {
    childEnv = await prepareEnv(config, env);
  } catch (error) {
    return fail('ocr-failed', `准备 ocr 运行环境失败：${errorText(error)}`);
  }

  const timeoutMinutes = Number(ocr.timeoutMin) > 0
    ? Math.floor(Number(ocr.timeoutMin))
    : REVIEW_DEFAULT_TIMEOUT_MIN;
  const hardTimeoutMs = Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : Math.max(10 * 60_000, timeoutMinutes * 60_000 * 3);

  const args = [
    command,
    '--format', 'json',
    '--output', rawOutputPath,
    '--audience', 'human',
    '--repo', root,
    '--color', 'never',
  ];
  if (command === 'review') {
    if (type === 'commit') args.push('--commit', String(scope.commit).trim());
    if (type === 'range') {
      args.push('--from', String(scope.from).trim(), '--to', String(scope.to).trim());
    }
  } else {
    // `scan` / `module` / `architecture` / `flow`. Directories come from scope;
    // architecture/flow anchor files come through `plan` (the structural stage
    // selected them), so fall back to the planned reviewable files instead of
    // scanning the whole repository.
    let paths = normalizePaths(scope?.paths);
    if (!paths.length && plan && Array.isArray(plan.files)) {
      paths = normalizePaths(
        plan.files
          .filter((file) => file && file.willReview !== false)
          .map((file) => file.path),
      ).slice(0, 2000);
    }
    if (paths.length) args.push('--path', paths.join(','));
  }
  // `--effort` only exists on `ocr review`; `ocr scan` rejects unknown flags.
  if (command === 'review' && String(ocr.effort ?? '').trim()) {
    args.push('--effort', String(ocr.effort).trim());
  }
  if (Number(ocr.concurrency) > 0) args.push('--concurrency', String(Math.floor(Number(ocr.concurrency))));
  if (Number(ocr.timeoutMin) > 0) args.push('--timeout', String(timeoutMinutes));
  if (Number(ocr.maxTokens) > 0) args.push('--max-tokens', String(Math.floor(Number(ocr.maxTokens))));
  if (Number(ocr.maxTokensBudget) > 0) {
    args.push('--max-tokens-budget', String(Math.floor(Number(ocr.maxTokensBudget))));
  }
  const excludeText = normalizeExclude(exclude);
  if (excludeText) args.push('--exclude', excludeText);
  if (Array.isArray(ocr.extraArgs)) {
    for (const extra of ocr.extraArgs) {
      const text = String(extra ?? '');
      if (text) args.push(text);
    }
  }

  const tempFiles = [];
  const cleanupTemp = async () => {
    await Promise.all(tempFiles.map((file) => unlink(file).catch(() => {})));
  };

  if (rules && typeof rules === 'object') {
    const rulePath = join(artifactsDir, `${safeId}.rule.json`);
    try {
      await writeFile(rulePath, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
      tempFiles.push(rulePath);
      args.push('--rule', rulePath);
    } catch (error) {
      return fail('ocr-failed', `无法写入评审规则临时文件：${errorText(error)}`);
    }
  } else if (typeof rules === 'string' && rules.trim()) {
    args.push('--rule', rules.trim());
  }
  if (String(background ?? '').trim()) {
    if (command === 'review') {
      // `ocr review` accepts a Markdown file and prefers it over inline text.
      const backgroundPath = join(artifactsDir, `${safeId}.background.md`);
      try {
        await writeFile(backgroundPath, String(background), 'utf8');
        tempFiles.push(backgroundPath);
        args.push('--background-file', backgroundPath);
      } catch (error) {
        await cleanupTemp();
      return fail('ocr-failed', `无法写入评审背景临时文件：${errorText(error)}`);
      }
    } else {
      // `ocr scan` only has `--background` (no --background-file); pass the
      // generated Markdown inline, capped so a huge analysis cannot overflow
      // the argv limit.
      args.push('--background', String(background).slice(0, 60_000));
    }
  }

  const tracker = createProgressTracker({ onEvent, onProgress });
  let result;
  try {
    result = await spawnReview({
      binary,
      args,
      cwd: root,
      env: childEnv,
      timeoutMs: hardTimeoutMs,
      signal,
      onLine: (line) => tracker.handleLine(line),
    });
  } finally {
    await cleanupTemp();
  }

  // Persist the full log even for failures — it is the only diagnostics the UI
  // can show without re-running an expensive review.
  const stderrTail = tailLines(result.stderr, STDERR_TAIL_LINES);
  try {
    await writeFile(logPath, result.stderr || '(no stderr output)\n', 'utf8');
  } catch {
    /* log persistence is best effort */
  }

  if (result.cancelled || (signal?.aborted && !result.ok)) {
    return fail('cancelled', messageForCode('cancelled'), { status: 'cancelled', stderrTail });
  }
  if (result.missing) return fail('ocr-missing', messageForCode('ocr-missing'), { stderrTail });
  if (result.timedOut) {
    return fail('timeout', messageForCode('timeout', { timeoutMinutes }), { stderrTail });
  }
  if (result.spawnError) {
    return fail('ocr-failed', `无法启动 ocr CLI（${binary}）：${firstLine(result.error)}`, { stderrTail });
  }

  let parsed = null;
  try {
    parsed = parseJsonLoose(await readFile(rawOutputPath, 'utf8'));
  } catch {
    /* fall through to stdout fallback */
  }
  if (!parsed) parsed = parseJsonLoose(result.stdout);

  if (!result.ok) {
    const combined = `${result.stderr}\n${result.stdout}`;
    const code = classifyErrorText(combined, result);
    return fail(code, messageForCode(code, {
      stderr: combined,
      exitCode: result.code,
      timeoutMinutes,
    }), { stderrTail });
  }

  if (!parsed || typeof parsed !== 'object') {
    return fail(
      'ocr-failed',
      `OCR 未生成 JSON 结果文件 ${rawOutputPath}${stderrTail.length ? `（stderr：${firstLine(stderrTail.join('\n'))}）` : ''}`,
      { stderrTail },
    );
  }
  if (String(parsed.status ?? '').toLowerCase() === 'failed') {
    const detail = firstLine(stderrTail.join('\n'));
    return fail('ocr-failed', String(parsed.message ?? (detail || 'OCR 报告运行失败。')), { stderrTail });
  }

  const comments = (Array.isArray(parsed.comments) ? parsed.comments : []).map(normalizeComment);
  const summary = mapSummary(parsed.summary, comments.length, result.elapsedMs);
  const jsonWarnings = (Array.isArray(parsed.warnings) ? parsed.warnings : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      type: String(item.type ?? 'warning'),
      file: String(item.file ?? ''),
      message: String(item.message ?? ''),
    }));
  const warnings = dedupeWarnings([...jsonWarnings, ...tracker.warnings]);
  if (parsed.summary?.budget_exceeded) {
    warnings.push({
      type: 'token_budget_reached',
      file: '',
      message: '达到 token 预算上限，部分文件未完成评审。',
    });
  }

  return {
    ok: true,
    status: 'success',
    comments,
    summary,
    projectSummary: String(parsed.project_summary ?? ''),
    warnings,
    sessionId: String(parsed.session_id ?? tracker.sessionId ?? ''),
    manifest: parsed.manifest && typeof parsed.manifest === 'object' ? parsed.manifest : null,
    // OCR reports the resolved provider/model; expose it (never credentials) so
    // the job can show which model produced the findings.
    llm: parsed.llm && typeof parsed.llm === 'object'
      ? { provider: String(parsed.llm.provider ?? ''), model: String(parsed.llm.model ?? '') }
      : null,
    rawOutputPath,
    stderrTail,
    error: null,
  };
}
