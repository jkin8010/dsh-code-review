/**
 * @jkin8010/dsh-code-review — host/git.js
 *
 * Read-only git probes for the review dashboard. Every export resolves into
 * plain JSON (or an array of it) and never rejects: a broken repository turns
 * into `{ error }` (or an empty list) instead of an exception, so one bad
 * project cannot take down a snapshot refresh.
 *
 * The one performance-critical path is `gitHeatmap`: a whole year of history is
 * read with a single `git log --numstat` (never per-day), capped by commit
 * count, then zero-filled into one record per calendar day so the client can
 * draw a GitHub-style grid without further work.
 *
 * Node built-ins only — no third-party dependency.
 */

import { execFile, spawn } from 'node:child_process';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import {
  DEFAULTS, expandHome, projectId, projectName,
} from './config.js';
import {
  addDays, dateKey, dayList, errorText, hash, isoOrNull, nowIso,
} from './shared.js';

const GIT_TIMEOUT_MS = 20_000;
const HEATMAP_TIMEOUT_MS = 60_000;
const LS_FILES_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Hard caps that keep a snapshot refresh bounded on huge monorepos. */
const MAX_SCAN_FILES = 4000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const READ_CONCURRENCY = 8;
const DISCOVER_CONCURRENCY = 4;
const MODULE_COMMIT_SCAN = 3000;
const MAX_MODULES = 60;

/** Directory names that are source roots rather than feature modules. */
const SOURCE_ROOTS = new Set([
  'src', 'lib', 'app', 'packages', 'internal', 'pkg', 'cmd',
  'source', 'sources', 'services', 'modules', 'backend', 'frontend',
]);

const LANGUAGE_BY_EXT = new Map([
  ['.js', 'JavaScript'], ['.mjs', 'JavaScript'], ['.cjs', 'JavaScript'], ['.jsx', 'JavaScript'],
  ['.ts', 'TypeScript'], ['.mts', 'TypeScript'], ['.cts', 'TypeScript'], ['.tsx', 'TypeScript'],
  ['.vue', 'Vue'], ['.svelte', 'Svelte'],
  ['.py', 'Python'], ['.pyi', 'Python'], ['.ipynb', 'Python'],
  ['.go', 'Go'], ['.rs', 'Rust'], ['.java', 'Java'], ['.kt', 'Kotlin'], ['.kts', 'Kotlin'],
  ['.swift', 'Swift'], ['.scala', 'Scala'], ['.cs', 'C#'], ['.c', 'C'], ['.h', 'C'],
  ['.cc', 'C++'], ['.cpp', 'C++'], ['.hpp', 'C++'], ['.m', 'Objective-C'], ['.mm', 'Objective-C'],
  ['.rb', 'Ruby'], ['.php', 'PHP'], ['.pl', 'Perl'], ['.lua', 'Lua'], ['.r', 'R'],
  ['.ex', 'Elixir'], ['.exs', 'Elixir'], ['.erl', 'Erlang'], ['.hs', 'Haskell'],
  ['.ml', 'OCaml'], ['.clj', 'Clojure'], ['.dart', 'Dart'], ['.zig', 'Zig'],
  ['.sh', 'Shell'], ['.bash', 'Shell'], ['.zsh', 'Shell'], ['.fish', 'Shell'], ['.ps1', 'PowerShell'],
  ['.sql', 'SQL'], ['.proto', 'Protocol Buffers'], ['.graphql', 'GraphQL'],
  ['.html', 'HTML'], ['.htm', 'HTML'], ['.css', 'CSS'], ['.scss', 'SCSS'], ['.sass', 'Sass'], ['.less', 'Less'],
  ['.md', 'Markdown'], ['.mdx', 'Markdown'], ['.rst', 'reStructuredText'],
  ['.json', 'JSON'], ['.jsonc', 'JSON'], ['.yaml', 'YAML'], ['.yml', 'YAML'], ['.toml', 'TOML'],
  ['.xml', 'XML'], ['.svg', 'SVG'], ['.tf', 'Terraform'], ['.hcl', 'HCL'],
]);

const STATUS_BY_CODE = new Map([
  ['A', 'added'], ['M', 'modified'], ['D', 'deleted'],
  ['R', 'renamed'], ['C', 'added'], ['T', 'modified'], ['U', 'modified'],
]);

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

function gitEnv() {
  return {
    ...process.env,
    // A read-only snapshot must never block on credentials or rewrite the index.
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
  };
}

/**
 * Run one git subprocess and normalize the callback into a data object.
 * Resolves (never rejects) with `{ ok, code, stdout, stderr, error, reason,
 * missing, timedOut, bufferOverflow }`. The failure kind is classified here so
 * every caller reports "timeout" and "output too large" differently instead of
 * folding both into a generic error.
 */
function execGit(cwd, args, { timeout = GIT_TIMEOUT_MS, maxBuffer = GIT_MAX_BUFFER } = {}) {
  return new Promise((resolvePromise) => {
    execFile('git', args, {
      cwd,
      timeout,
      maxBuffer,
      windowsHide: true,
      encoding: 'utf8',
      env: gitEnv(),
    }, (error, stdout, stderr) => {
      const out = typeof stdout === 'string' ? stdout : '';
      const err = typeof stderr === 'string' ? stderr : '';
      if (!error) {
        resolvePromise({
          ok: true, code: 0, stdout: out, stderr: err, error: null, reason: '', missing: false, timedOut: false, bufferOverflow: false,
        });
        return;
      }
      const reason = String(error.code ?? '');
      // Node sets `error.killed` for a timeout SIGTERM, but ENOBUFS (maxBuffer)
      // can arrive with `killed` set too, so buffer overflow is classified
      // first and only then is `killed` read as a timeout.
      const bufferOverflow = reason === 'ENOBUFS' || /maxBuffer/i.test(String(error.message ?? ''));
      const timedOut = !bufferOverflow && (reason === 'ETIMEDOUT' || Boolean(error.killed));
      resolvePromise({
        ok: false,
        code: typeof error.code === 'number' ? error.code : null,
        stdout: out,
        stderr: err,
        error: errorText(error),
        reason,
        missing: reason === 'ENOENT',
        timedOut,
        bufferOverflow,
      });
    });
  });
}

/**
 * Stream one git command's stdout line by line. Unlike `execFile` there is no
 * buffer ceiling, so a year of `--numstat` history cannot be silently cut off at
 * `maxBuffer`; the callback sees every complete line as it is produced.
 * Resolves (never rejects) with the same failure shape as `execGit`.
 */
const MAX_STDOUT_LINE = 4 * 1024 * 1024;

function streamGit(cwd, args, onLine, { timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    if (typeof onLine !== 'function') {
      resolvePromise({
        ok: false, code: null, stderr: '', error: 'streamGit requires an onLine callback',
        reason: 'ECALLBACK', missing: false, timedOut: false, bufferOverflow: false,
      });
      return;
    }
    let child;
    try {
      child = spawn('git', args, {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: gitEnv(),
      });
    } catch (error) {
      resolvePromise({
        ok: false, code: null, stderr: '', error: errorText(error), reason: String(error?.code ?? ''),
        missing: false, timedOut: false, bufferOverflow: false,
      });
      return;
    }
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let stderr = '';
    let pending = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error) {
        resolvePromise({
          ok: true, code: 0, stderr, error: null, reason: '', missing: false, timedOut: false, bufferOverflow: false,
        });
        return;
      }
      const reason = String(error.code ?? '');
      resolvePromise({
        ok: false,
        code: typeof error.code === 'number' ? error.code : null,
        stderr,
        error: errorText(error),
        reason,
        missing: reason === 'ENOENT',
        timedOut: timedOut || reason === 'ETIMEDOUT',
        bufferOverflow: overflowed,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      // A wedged git must not keep the scan promise (and its caller) pending.
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5_000).unref?.();
    }, timeout);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      // A single pathological line must not grow without bound: treat it as a
      // buffer overflow and kill git instead of exhausting host memory.
      if (pending.length > MAX_STDOUT_LINE) {
        overflowed = true;
        pending = '';
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish(Object.assign(new Error('git output line exceeds 4MB'), { code: 'ENOBUFS' }));
        return;
      }
      let index = pending.indexOf('\n');
      while (index >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        try {
          onLine(line);
        } catch {
          /* one malformed line must not abort the whole scan */
        }
        index = pending.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('error', finish);
    child.on('close', (code) => {
      if (pending) {
        try {
          onLine(pending.replace(/\r$/, ''));
        } catch {
          /* ignore */
        }
      }
      if (timedOut) finish(Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT' }));
      else if (code === 0) finish(null);
      else finish(Object.assign(new Error(`git exited with code ${code}`), { code }));
    });
  });
}

function gitFailureMessage(result, fallback) {
  if (result.timedOut) return `git 读取超时：${fallback}`;
  if (result.bufferOverflow) return `git 输出过大（超出缓冲区）：${fallback}`;
  if (result.missing) return '未找到 git 命令：请安装 git 并确保在 PATH 中';
  return `${fallback}：${firstLine(result.stderr || result.error)}`;
}

function resolveRepoPath(value) {
  const text = expandHome(String(value ?? '').trim());
  return text ? resolve(text) : '';
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** First non-empty line, bounded, for compact error messages. */
function firstLine(text, max = 220) {
  const line = String(text ?? '').split('\n').map((item) => item.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Last non-empty, non-stack line — git usually puts the useful message last. */
function lastMeaningfulLine(text, max = 220) {
  const lines = String(text ?? '').split('\n').map((item) => item.trim()).filter(Boolean);
  const line = lines[lines.length - 1] ?? lines[0] ?? '';
  const cleaned = line.replace(/^(fatal|error):\s*/i, '');
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function clampDays(value) {
  return clampInt(value, DEFAULTS.heatmapDays, 1, 730);
}

function clampLimit(value, fallback, min = 1) {
  return clampInt(value, fallback, min, 10_000);
}

function emptyFindings() {
  return { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
}

/**
 * Bounded-concurrency map that preserves input order and never rejects.
 * A throwing worker yields `undefined` at its index (callers already skip
 * falsy entries); the failure is also recorded in `options.errors` so the
 * caller can tell "nothing produced" from "processing failed" and report it.
 */
async function mapLimit(items, limit, worker, options = {}) {
  const list = Array.from(items ?? []);
  if (!list.length) return [];
  const results = new Array(list.length);
  const errors = Array.isArray(options.errors) ? options.errors : null;
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, list.length));
  async function run() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
      } catch (error) {
        results[index] = undefined;
        errors?.push({ index, item: list[index], error: errorText(error) });
        options.logger?.warn?.(`mapLimit item ${index} failed: ${errorText(error)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: size }, run));
  return results;
}

// ---------------------------------------------------------------------------
// gitMeta
// ---------------------------------------------------------------------------

/**
 * Cheap repository identity: branch, HEAD, last commit, dirty flag, origin.
 * A non-repository directory resolves to `kind:'dir'` with a Chinese `error`.
 */
export async function gitMeta({ repoPath } = {}) {
  const at = nowIso();
  const root = resolveRepoPath(repoPath);
  const dirResult = {
    kind: 'dir',
    branch: '',
    head: '',
    headSubject: '',
    committedAt: null,
    dirty: false,
    remote: '',
    error: null,
    at,
  };

  if (!root) return { ...dirResult, error: '未提供项目路径' };
  if (!(await directoryExists(root))) return { ...dirResult, error: `项目路径不存在：${root}` };

  const inside = await execGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    const detail = firstLine(inside.stderr || inside.error);
    return { ...dirResult, error: detail ? `不是 git 仓库：${root}（${detail}）` : `不是 git 仓库：${root}` };
  }

  const [branchResult, headResult, subjectResult, dateResult, statusResult, remoteResult] = await Promise.all([
    execGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    execGit(root, ['rev-parse', '--short=7', 'HEAD']),
    execGit(root, ['-c', 'core.quotePath=false', 'log', '-1', '--pretty=%s']),
    execGit(root, ['log', '-1', '--pretty=%aI']),
    execGit(root, ['status', '--porcelain', '--untracked-files=normal']),
    execGit(root, ['remote', 'get-url', 'origin']),
  ]);

  let branch = branchResult.ok ? branchResult.stdout.trim() : '';
  if (!branch || branch === 'HEAD') {
    const symbolic = await execGit(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
    if (symbolic.ok) branch = symbolic.stdout.trim();
  }

  return {
    kind: 'git',
    branch,
    head: headResult.ok ? headResult.stdout.trim() : '',
    headSubject: subjectResult.ok ? subjectResult.stdout.trim() : '',
    committedAt: isoOrNull(dateResult.stdout?.trim()),
    dirty: statusResult.ok ? statusResult.stdout.trim().length > 0 : false,
    remote: remoteResult.ok ? remoteResult.stdout.trim() : '',
    error: null,
    at,
  };
}

// ---------------------------------------------------------------------------
// gitHeatmap
// ---------------------------------------------------------------------------

function emptyHeatmap(days) {
  const span = clampDays(days);
  const to = dateKey(Date.now());
  const from = addDays(to, -(span - 1));
  const filled = dayList(from, to).map((date) => ({ date, commits: 0, insertions: 0, deletions: 0 }));
  return {
    from,
    to,
    days: filled,
    // Compact commit series for the project cards' sparkline; snapshot trims
    // `days` away for non-current projects and keeps only this.
    spark: filled.slice(-90).map((day) => day.commits),
    max: 0,
    totalCommits: 0,
    totalInsertions: 0,
    totalDeletions: 0,
    streaks: { current: 0, longest: 0 },
    busiest: { date: from, commits: 0 },
    activeDays: 0,
    error: null,
    at: nowIso(),
  };
}

function computeStreaks(days) {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    if (day.commits > 0) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  // A streak ending today is "current"; if today is still quiet, yesterday's
  // streak is still alive (matches how contribution charts behave).
  let index = days.length - 1;
  if (index >= 0 && days[index].commits === 0) index -= 1;
  let current = 0;
  for (; index >= 0 && days[index].commits > 0; index -= 1) current += 1;
  return { current, longest };
}

/**
 * One-year (or `days`) commit heatmap.
 *
 * A single `git log --since --numstat --date=short --pretty=format:%ad` call is
 * parsed into per-day totals, then every calendar day between `from` and `to`
 * is filled in (zero-activity days become `commits:0, insertions:0,
 * deletions:0`) so the client can index the grid directly.
 */
export async function gitHeatmap({ repoPath, days = 365, limit } = {}) {
  const heatmap = emptyHeatmap(days);
  const root = resolveRepoPath(repoPath);
  if (!root) {
    heatmap.error = '未提供项目路径';
    return heatmap;
  }
  if (!(await directoryExists(root))) {
    heatmap.error = `项目路径不存在：${root}`;
    return heatmap;
  }

  const maxCount = clampLimit(limit, DEFAULTS.gitScanLimit);
  const args = [
    'log',
    `--since=${heatmap.from} 00:00:00`,
    `--until=${heatmap.to} 23:59:59`,
    '--numstat',
    '--date=short',
    '--pretty=format:%ad',
    `--max-count=${maxCount}`,
  ];
  // Parsed while git writes: a year of numstat can exceed any fixed maxBuffer,
  // and a truncated buffer used to shrink the statistics without an error.
  const active = new Map();
  let current = null;
  let inRange = false;
  const result = await streamGit(root, args, (line) => {
    if (!line) return;
    if (/^\d{4}-\d{2}-\d{2}$/.test(line)) {
      current = line;
      // --since/--until filter by commit timestamp while %ad prints the author
      // date; a commit may therefore spill one day outside the window. Keeping
      // only in-range days makes totals agree with the rendered grid.
      inRange = line >= heatmap.from && line <= heatmap.to;
      if (inRange) {
        const entry = active.get(line) ?? { commits: 0, insertions: 0, deletions: 0 };
        entry.commits += 1;
        active.set(line, entry);
      }
      return;
    }
    if (!inRange || !current) return;
    const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!match) return;
    const entry = active.get(current);
    if (!entry) return;
    entry.insertions += match[1] === '-' ? 0 : Number(match[1]);
    entry.deletions += match[2] === '-' ? 0 : Number(match[2]);
  }, { timeout: HEATMAP_TIMEOUT_MS });
  if (!result.ok) {
    if (/not a git repository/i.test(result.stderr)) {
      heatmap.error = `不是 git 仓库：${root}`;
    } else if (result.missing) {
      heatmap.error = gitFailureMessage(result, '读取 git 历史失败');
    } else if (result.timedOut) {
      heatmap.error = `读取 git 历史超时（${HEATMAP_TIMEOUT_MS / 1000}s）：请降低 gitScanLimit`;
    } else {
      heatmap.error = `读取 git 历史失败：${firstLine(result.stderr || result.error)}`;
    }
    return heatmap;
  }

  let max = 0;
  let totalCommits = 0;
  let totalInsertions = 0;
  let totalDeletions = 0;
  let activeDays = 0;
  let busiest = { date: heatmap.from, commits: 0 };
  for (const day of heatmap.days) {
    const found = active.get(day.date);
    if (!found) continue;
    day.commits = found.commits;
    day.insertions = found.insertions;
    day.deletions = found.deletions;
    totalCommits += found.commits;
    totalInsertions += found.insertions;
    totalDeletions += found.deletions;
    if (found.commits > 0) activeDays += 1;
    if (found.commits > max) {
      max = found.commits;
      busiest = { date: day.date, commits: found.commits };
    }
  }

  heatmap.max = max;
  heatmap.totalCommits = totalCommits;
  heatmap.totalInsertions = totalInsertions;
  heatmap.totalDeletions = totalDeletions;
  heatmap.activeDays = activeDays;
  heatmap.busiest = busiest;
  heatmap.spark = heatmap.days.slice(-90).map((day) => day.commits);
  heatmap.streaks = computeStreaks(heatmap.days);
  heatmap.error = null;
  return heatmap;
}

// ---------------------------------------------------------------------------
// file inventory + LOC counting
// ---------------------------------------------------------------------------

/**
 * `git ls-files -z` — tracked files (staged + committed). `limit <= 0` keeps
 * every path; the normal scan path slices to the contract's 4000-file cap.
 */
async function listTrackedFiles(root, { limit = MAX_SCAN_FILES } = {}) {
  const result = await execGit(root, ['ls-files', '-z'], { timeout: LS_FILES_TIMEOUT_MS });
  if (!result.ok) {
    return {
      ok: false,
      files: [],
      total: 0,
      error: /not a git repository/i.test(result.stderr)
        ? `不是 git 仓库：${root}`
        : `无法列出仓库文件：${firstLine(result.stderr || result.error)}`,
    };
  }
  const all = result.stdout.split('\0').filter(Boolean);
  const files = limit > 0 ? all.slice(0, limit) : all;
  return { ok: true, files, total: all.length, error: null };
}

/**
 * Count lines of one tracked file without loading it whole.
 * Binary (NUL byte) and oversized files are reported as skipped with `lines:0`,
 * which keeps the module LOC honest instead of counting gibberish.
 */
async function countFileLines(root, relPath) {
  const absolute = resolve(root, relPath);
  const skipped = { lines: 0, bytes: 0, skipped: true, binary: false, exists: false };
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return skipped;

  let info;
  try {
    info = await stat(absolute);
  } catch {
    return skipped;
  }
  if (!info.isFile()) return skipped;
  if (info.size > MAX_FILE_BYTES) {
    return { lines: 0, bytes: info.size, skipped: true, binary: false, exists: true, tooLarge: true };
  }

  let handle;
  try {
    handle = await open(absolute, 'r');
  } catch {
    return skipped;
  }
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    let lines = 0;
    let binary = false;
    let lastByte = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      const view = chunk.subarray(0, bytesRead);
      if (view.includes(0)) {
        binary = true;
        break;
      }
      bytes += bytesRead;
      for (let i = 0; i < bytesRead; i += 1) {
        if (view[i] === 0x0a) lines += 1;
      }
      lastByte = view[bytesRead - 1];
    }
    if (binary) return { lines: 0, bytes, skipped: true, binary: true, exists: true };
    if (bytes > 0 && lastByte !== 0x0a) lines += 1;
    return { lines, bytes, skipped: false, binary: false, exists: true };
  } catch {
    return skipped;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function scanTrackedFiles(root, { withLoc = true } = {}) {
  const listed = await listTrackedFiles(root);
  if (!listed.ok) return { ok: false, files: [], total: 0, error: listed.error };
  if (!withLoc) {
    return {
      ok: true,
      files: listed.files.map((path) => ({ path, lines: 0, bytes: 0, skipped: true, binary: false })),
      total: listed.total,
      error: null,
    };
  }
  const files = new Array(listed.files.length);
  const mapErrors = [];
  await mapLimit(listed.files, READ_CONCURRENCY, async (relPath, index) => {
    const stats = await countFileLines(root, relPath);
    files[index] = { path: relPath, ...stats };
  }, { errors: mapErrors });
  // An unreadable file must not become a hole in the array: downstream LOC and
  // module aggregation would throw on `undefined.lines`.
  for (const failure of mapErrors) {
    files[failure.index] = {
      path: listed.files[failure.index], lines: 0, bytes: 0, skipped: true, binary: false, error: failure.error,
    };
  }
  return { ok: true, files, total: listed.total, error: null };
}

// ---------------------------------------------------------------------------
// module aggregation
// ---------------------------------------------------------------------------

/**
 * Module key for a repository-relative path.
 *
 * `depth` counts module-name segments after an optional source root, so
 * `src/agent/x.ts` with depth 1 becomes `agent` and `src/agent/llm/x.ts` with
 * depth 2 becomes `agent/llm`. Root-level files (no directory) belong to no
 * module, and dot-directories (`.github`, `.vscode`) are infrastructure rather
 * than reviewable code.
 */
function moduleKeyForPath(relPath, depth) {
  // The last path segment is the file itself; modules are made of directories.
  const dirs = String(relPath ?? '').split('/').filter(Boolean).slice(0, -1);
  if (!dirs.length) return '';
  let index = 0;
  if (SOURCE_ROOTS.has(dirs[0])) index = 1;
  const levels = clampInt(depth, 1, 1, 3);
  const slice = dirs.slice(index, index + levels);
  if (!slice.length) {
    // `src/file.ts`: no feature directory below the source root, so the root
    // directory itself is the module.
    return dirs[0].startsWith('.') ? '' : dirs[0];
  }
  if (slice[0].startsWith('.')) return '';
  return slice.join('/');
}

/** Last commit timestamp per module: one capped `git log --name-only` call. */
async function moduleLastCommits(root, moduleKeys, depth) {
  const lastAt = new Map();
  const pending = new Set(moduleKeys);
  if (!pending.size) return lastAt;

  const result = await execGit(root, [
    '-c', 'core.quotePath=false',
    'log', '-n', String(MODULE_COMMIT_SCAN),
    '--pretty=format:%aI', '--name-only',
  ], { timeout: STREAM_TIMEOUT_MS });
  if (!result.ok) return lastAt;

  let committedAt = null;
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line)) {
      committedAt = isoOrNull(line);
      continue;
    }
    if (!committedAt) continue;
    const key = moduleKeyForPath(line, depth);
    if (!key || !pending.has(key)) continue;
    lastAt.set(key, committedAt);
    pending.delete(key);
    if (!pending.size) break; // newest-first: every module already has its date
  }
  return lastAt;
}

async function buildModules(root, files, { depth, maxModules }) {
  const counts = new Map();
  for (const file of files) {
    const key = moduleKeyForPath(file.path, depth);
    if (!key) continue;
    const entry = counts.get(key) ?? { key, files: 0, loc: 0 };
    entry.files += 1;
    entry.loc += file.lines ?? 0;
    counts.set(key, entry);
  }
  if (!counts.size) return { modules: [], total: 0 };

  const lastAt = await moduleLastCommits(root, new Set(counts.keys()), depth);
  const modules = [...counts.values()].map(({ key, files: fileCount, loc }) => ({
    id: `m-${hash(key, 10)}`,
    name: key.split('/').pop() ?? key,
    path: key,
    files: fileCount,
    loc,
    lastCommitAt: lastAt.get(key) ?? null,
    // Review state lives in the store; the git layer starts from neutral
    // defaults so the snapshot shape is complete without the store.
    lastReviewAt: null,
    reviewCount: 0,
    findings: emptyFindings(),
    risk: 'low',
  }));
  modules.sort((a, b) => b.files - a.files || b.loc - a.loc || a.path.localeCompare(b.path));
  return { modules: modules.slice(0, Math.max(1, maxModules)), total: modules.length };
}

// ---------------------------------------------------------------------------
// language statistics
// ---------------------------------------------------------------------------

function languageOfPath(relPath) {
  const name = String(relPath ?? '').split('/').pop() ?? '';
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'Dockerfile';
  if (lower === 'makefile' || lower === 'gnumakefile') return 'Makefile';
  return LANGUAGE_BY_EXT.get(extname(lower)) ?? '';
}

function topLanguage(files) {
  const counts = new Map();
  for (const file of files) {
    if (file.skipped || file.binary) continue;
    const language = languageOfPath(file.path);
    if (!language) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

function countTopLevelDirs(paths) {
  const dirs = new Set();
  for (const path of paths) {
    const parts = String(path).split('/');
    if (parts.length < 2 || !parts[0] || parts[0].startsWith('.')) continue;
    dirs.add(parts[0]);
  }
  return dirs.size;
}

// ---------------------------------------------------------------------------
// moduleTree
// ---------------------------------------------------------------------------

/**
 * Module summary list sorted by file count (then LOC). Returns `[]` for a
 * non-git or unreadable repository — callers treat "no modules" as an empty
 * project view rather than an error.
 */
export async function moduleTree({ repoPath, depth = 2, maxModules = MAX_MODULES } = {}) {
  const root = resolveRepoPath(repoPath);
  if (!root || !(await directoryExists(root))) return [];
  const scanned = await scanTrackedFiles(root);
  if (!scanned.ok) return [];
  const built = await buildModules(root, scanned.files, {
    depth: clampInt(depth, 1, 1, 3),
    maxModules: clampInt(maxModules, MAX_MODULES, 1, 500),
  });
  return built.modules;
}

// ---------------------------------------------------------------------------
// inspectProject
// ---------------------------------------------------------------------------

function projectSkeleton({ path, heatmapDays, error, kind = 'dir', loc = 0 }) {
  return {
    id: projectId(path),
    name: projectName(path),
    path,
    kind,
    branch: '',
    head: '',
    headSubject: '',
    committedAt: null,
    lastCommitAt: null,
    dirty: false,
    remote: '',
    language: '',
    fileCount: 0,
    moduleCount: 0,
    loc,
    modules: [],
    heatmap: emptyHeatmap(heatmapDays),
    lastReviewAt: null,
    reviewCount: 0,
    findings: emptyFindings(),
    error,
    at: nowIso(),
  };
}

/**
 * Full project view: git identity + language stats + top modules + heatmap.
 *
 * `light:true` skips per-file line counting (no LOC cost) and returns
 * `loc:null`, a full tracked file count, a top-level directory count and the
 * requested heatmap window — enough for snapshot list cards. Review-state
 * fields (`lastReviewAt`, `reviewCount`, `findings`) are defaults; the store
 * layer owns those.
 */
export async function inspectProject({
  repoPath,
  heatmapDays = 365,
  moduleDepth = 1,
  light = false,
  gitScanLimit,
  maxModules = MAX_MODULES,
} = {}) {
  const root = resolveRepoPath(repoPath);
  const days = clampDays(heatmapDays);
  if (!root) return projectSkeleton({ path: '', heatmapDays: days, error: '未提供项目路径' });
  if (!(await directoryExists(root))) {
    return projectSkeleton({ path: root, heatmapDays: days, error: `项目路径不存在：${root}` });
  }

  const meta = await gitMeta({ repoPath: root });
  if (meta.kind !== 'git' || meta.error) {
    return {
      ...projectSkeleton({ path: root, heatmapDays: days, error: meta.error || `不是 git 仓库：${root}` }),
      kind: meta.kind,
      dirty: meta.dirty,
    };
  }

  const base = {
    id: projectId(root),
    name: projectName(root),
    path: root,
    kind: 'git',
    branch: meta.branch,
    head: meta.head,
    headSubject: meta.headSubject,
    committedAt: meta.committedAt,
    lastCommitAt: meta.committedAt,
    dirty: meta.dirty,
    remote: meta.remote,
    lastReviewAt: null,
    reviewCount: 0,
    findings: emptyFindings(),
    at: nowIso(),
  };
  const heatmapPromise = gitHeatmap({ repoPath: root, days, limit: gitScanLimit });

  if (light) {
    // List paths only (no reads): a full count plus a cheap top-level-dir count.
    const [listed, heatmap] = await Promise.all([
      listTrackedFiles(root, { limit: 0 }),
      heatmapPromise,
    ]);
    const files = listed.ok ? listed.files : [];
    return {
      ...base,
      language: topLanguage(files.map((path) => ({ path }))),
      fileCount: listed.ok ? listed.total : 0,
      moduleCount: countTopLevelDirs(files),
      loc: null,
      modules: [],
      heatmap,
      error: listed.ok ? heatmap.error : (listed.error || heatmap.error),
    };
  }

  const [scanned, heatmap] = await Promise.all([scanTrackedFiles(root), heatmapPromise]);
  if (!scanned.ok) {
    return {
      ...base,
      loc: 0,
      fileCount: 0,
      moduleCount: 0,
      modules: [],
      heatmap,
      error: scanned.error || heatmap.error,
    };
  }

  const built = await buildModules(root, scanned.files, {
    depth: clampInt(moduleDepth, 1, 1, 3),
    maxModules: clampInt(maxModules, MAX_MODULES, 1, 500),
  });
  const loc = scanned.files.reduce((sum, file) => sum + (file.lines ?? 0), 0);
  const errors = [heatmap.error].filter(Boolean);
  return {
    ...base,
    language: topLanguage(scanned.files),
    fileCount: scanned.files.length,
    moduleCount: built.total,
    loc,
    modules: built.modules,
    heatmap,
    error: errors.length ? errors.join('；') : null,
  };
}

// ---------------------------------------------------------------------------
// discoverProjects
// ---------------------------------------------------------------------------

function isExcludedProject(childPath, dirName, exclude) {
  for (const raw of exclude ?? []) {
    const entry = expandHome(String(raw ?? '').trim()).replace(/[/\\]+$/, '');
    if (!entry) continue;
    if (entry === dirName || basename(entry) === dirName) return true;
    if (childPath === entry) return true;
    if (childPath.startsWith(`${entry}/`) || childPath.startsWith(`${entry}${sep}`)) return true;
  }
  return false;
}

/**
 * Discover git projects that are direct children of the configured roots.
 *
 * Returns lightweight summaries sorted by last commit time (newest first).
 * The contract only requires `{ id, name, path, lastCommitAt, head, branch }`;
 * snapshot enriches entries with `inspectProject({ light:true })` when it needs
 * cards. A single failing project is skipped rather than aborting the scan.
 */
export async function discoverProjects({ roots = [], exclude = [], limit = 24 } = {}) {
  const discovered = [];
  const seen = new Set();

  for (const rawRoot of roots ?? []) {
    const root = resolveRepoPath(rawRoot);
    if (!root) continue;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const child = join(root, entry.name);
      if (seen.has(child)) continue;
      if (isExcludedProject(child, entry.name, exclude)) continue;
      try {
        const gitEntry = await lstat(join(child, '.git'));
        // Worktrees and submodules use a `.git` file instead of a directory.
        if (!gitEntry.isDirectory() && !gitEntry.isFile()) continue;
      } catch {
        continue;
      }
      seen.add(child);
      discovered.push(child);
    }
  }

  if (!discovered.length) return [];
  const metas = await mapLimit(discovered, DISCOVER_CONCURRENCY, (path) => gitMeta({ repoPath: path }));

  const found = [];
  for (let index = 0; index < discovered.length; index += 1) {
    const meta = metas[index];
    if (!meta || meta.kind !== 'git' || meta.error) continue;
    found.push({ path: discovered[index], meta });
  }
  const timeOf = (meta) => Date.parse(meta.committedAt ?? '') || 0;
  found.sort((a, b) => timeOf(b.meta) - timeOf(a.meta) || a.path.localeCompare(b.path));

  const cap = clampInt(limit, 24, 1, 200);
  const at = nowIso();
  return found.slice(0, cap).map(({ path, meta }) => ({
    id: projectId(path),
    name: projectName(path),
    path,
    lastCommitAt: meta.committedAt,
    committedAt: meta.committedAt,
    head: meta.head,
    branch: meta.branch,
    dirty: meta.dirty,
    remote: meta.remote,
    at,
    error: null,
  }));
}

// ---------------------------------------------------------------------------
// changedFiles
// ---------------------------------------------------------------------------

function cleanNumstatPath(path) {
  const text = String(path ?? '').trim();
  const braced = text.match(/^(.*)\{(.+) => (.+)\}(.*)$/);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/{2,}/g, '/');
  const simple = text.match(/^(.*) => (.+)$/);
  return simple ? simple[2] : text;
}

function parseNumstat(text) {
  const entries = new Map();
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    const binary = match[1] === '-' && match[2] === '-';
    entries.set(cleanNumstatPath(match[3]), {
      insertions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
      binary,
    });
  }
  return entries;
}

function parseNameStatus(text) {
  const entries = new Map();
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields.length < 2) continue;
    const code = fields[0].trim().charAt(0).toUpperCase();
    const path = cleanNumstatPath(fields[fields.length - 1]);
    if (!path) continue;
    entries.set(path, STATUS_BY_CODE.get(code) ?? 'modified');
  }
  return entries;
}

function mergeChanges(numstatText, nameStatusText) {
  const stats = parseNumstat(numstatText);
  const statuses = parseNameStatus(nameStatusText);
  const files = [];
  const seen = new Set();

  for (const [path, status] of statuses) {
    const counts = stats.get(path);
    files.push({
      path,
      insertions: counts?.insertions ?? 0,
      deletions: counts?.deletions ?? 0,
      status: counts?.binary ? 'binary' : status,
    });
    seen.add(path);
  }
  for (const [path, counts] of stats) {
    if (seen.has(path)) continue;
    files.push({
      path,
      insertions: counts.insertions,
      deletions: counts.deletions,
      status: counts.binary ? 'binary' : 'modified',
    });
  }
  return files;
}

function summarizeChanges(files, at) {
  return {
    files,
    totalInsertions: files.reduce((sum, file) => sum + file.insertions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
    error: null,
    at,
  };
}

function statusFromPorcelain(code) {
  const indexStatus = code.charAt(0);
  const workStatus = code.charAt(1);
  if (code === '??' || indexStatus === 'A' || workStatus === 'A') return 'added';
  if (indexStatus === 'R' || workStatus === 'R') return 'renamed';
  if (indexStatus === 'D' || workStatus === 'D') return 'deleted';
  return 'modified';
}

async function workspaceChanges(root, at) {
  const [statusResult, numstatResult] = await Promise.all([
    execGit(root, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all']),
    execGit(root, ['-c', 'core.quotePath=false', 'diff', '--numstat', 'HEAD']),
  ]);

  const statuses = [];
  if (statusResult.ok) {
    for (const rawLine of statusResult.stdout.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.length < 4) continue;
      const code = line.slice(0, 2);
      let path = line.slice(3).trim();
      if (path.includes(' -> ')) path = path.split(' -> ').pop().trim();
      if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
      if (!path) continue;
      statuses.push({ path: cleanNumstatPath(path), status: statusFromPorcelain(code) });
    }
  } else if (/not a git repository/i.test(statusResult.stderr)) {
    return { files: [], totalInsertions: 0, totalDeletions: 0, error: `不是 git 仓库：${root}`, at };
  }

  // Unborn HEAD: compare the index and the working tree separately.
  let numstatText = numstatResult.ok ? numstatResult.stdout : '';
  if (!numstatResult.ok) {
    const [unstaged, staged] = await Promise.all([
      execGit(root, ['-c', 'core.quotePath=false', 'diff', '--numstat']),
      execGit(root, ['-c', 'core.quotePath=false', 'diff', '--cached', '--numstat']),
    ]);
    numstatText = `${unstaged.ok ? unstaged.stdout : ''}\n${staged.ok ? staged.stdout : ''}`;
  }
  const stats = parseNumstat(numstatText);

  const files = [];
  for (const entry of statuses) {
    const counts = stats.get(entry.path);
    let insertions = counts?.insertions ?? 0;
    const deletions = counts?.deletions ?? 0;
    // Untracked files never appear in `git diff`; count their lines directly.
    if (!counts && entry.status === 'added') {
      const lineCount = await countFileLines(root, entry.path);
      insertions = lineCount.lines ?? 0;
    }
    files.push({
      path: entry.path,
      insertions,
      deletions,
      status: counts?.binary ? 'binary' : entry.status,
    });
  }
  return summarizeChanges(files, at);
}

async function commitChanges(root, commit, at) {
  const [numstatResult, statusResult] = await Promise.all([
    execGit(root, ['-c', 'core.quotePath=false', 'show', '--numstat', '--format=', commit]),
    execGit(root, ['-c', 'core.quotePath=false', 'show', '--name-status', '--format=', commit]),
  ]);
  if (!numstatResult.ok) {
    return {
      files: [],
      totalInsertions: 0,
      totalDeletions: 0,
      error: `读取提交 ${commit} 失败：${firstLine(numstatResult.stderr || numstatResult.error)}`,
      at,
    };
  }
  const files = mergeChanges(numstatResult.stdout, statusResult.ok ? statusResult.stdout : '');
  return summarizeChanges(files, at);
}

async function rangeChanges(root, from, to, at) {
  const mergeBase = await execGit(root, ['merge-base', from, to]);
  if (!mergeBase.ok) {
    return {
      files: [],
      totalInsertions: 0,
      totalDeletions: 0,
      error: `无法计算 ${from} 与 ${to} 的 merge-base：${lastMeaningfulLine(mergeBase.stderr || mergeBase.error)}`,
      at,
    };
  }
  const base = mergeBase.stdout.trim();
  const [numstatResult, statusResult] = await Promise.all([
    execGit(root, ['-c', 'core.quotePath=false', 'diff', '--numstat', base, to]),
    execGit(root, ['-c', 'core.quotePath=false', 'diff', '--name-status', base, to]),
  ]);
  if (!numstatResult.ok) {
    return {
      files: [],
      totalInsertions: 0,
      totalDeletions: 0,
      error: `读取 ${from}..${to} 差异失败：${firstLine(numstatResult.stderr || numstatResult.error)}`,
      at,
    };
  }
  return summarizeChanges(mergeChanges(numstatResult.stdout, statusResult.ok ? statusResult.stdout : ''), at);
}

/**
 * Changed files for one review mode.
 *   workspace — staged + unstaged + untracked against HEAD
 *   commit    — one commit against its parent (`<commit>^` semantics)
 *   range     — merge-base(`from`,`to`)..`to`, matching OCR's range review
 */
export async function changedFiles({ repoPath, mode = 'workspace', commit = '', from = '', to = '' } = {}) {
  const at = nowIso();
  const root = resolveRepoPath(repoPath);
  const empty = { files: [], totalInsertions: 0, totalDeletions: 0, error: null, at };
  if (!root) return { ...empty, error: '未提供项目路径' };
  if (!(await directoryExists(root))) return { ...empty, error: `项目路径不存在：${root}` };

  if (mode === 'commit') {
    if (!String(commit ?? '').trim()) return { ...empty, error: 'commit 模式缺少 commit 参数' };
    return commitChanges(root, String(commit).trim(), at);
  }
  if (mode === 'range') {
    if (!String(from ?? '').trim() || !String(to ?? '').trim()) {
      return { ...empty, error: 'range 模式缺少 from/to 参数' };
    }
    return rangeChanges(root, String(from).trim(), String(to).trim(), at);
  }
  return workspaceChanges(root, at);
}
