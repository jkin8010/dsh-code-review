/**
 * @qise/dsh-code-review — host/analyze.js
 *
 * Deterministic, offline structural analysis for the three "scan" review kinds
 * (architecture / module / flow) plus the added-line heuristics used by diff
 * reviews. Everything here is regex + graph work over project files handed in by
 * the job runner: no network, no third-party dependency, no writes.
 *
 * Contract: docs/CODE-REVIEW-CONTRACT.md §2 (host/analyze.js) and §3 (Finding /
 * Graph / activity). Every finding goes through `shared.finding()` so id,
 * fingerprint, severity and category normalization stay in one place.
 *
 * The analyzers are intentionally *conservative*: a rule only fires when the
 * evidence is textual and local, and noisy rules (magic numbers, duplicate
 * windows) are capped. `activity` narrates what the analysis did, in Chinese,
 * so the job timeline stays readable while the deterministic pass runs.
 */
import { readdir, readFile as fsReadFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, posix } from 'node:path';

import {
  countBy,
  countFindings,
  errorText,
  finding,
  hash,
  moduleOfPath,
  nowIso,
  severityRank,
  trimText,
} from './shared.js';

const MAX_READ_BYTES = 256 * 1024;
const MAX_WALK_FILES = 4000;
const MAX_ARCH_MODULES = 40;
const MAX_MODULE_GRAPH_FILES = 30;
const MAX_FLOWS = 12;
const MAX_ACTIVITY = 20;
const MIN_ACTIVITY = 5;
const DUPLICATE_WINDOW = 8;

const SOURCE_ROOTS = new Set([
  'src', 'lib', 'app', 'packages', 'internal', 'pkg', 'cmd', 'source',
  'dist', 'build', 'out', 'test', 'tests', '__tests__', 'coverage',
]);

// Directory basenames that repeat by convention; flagging them as "duplicate
// module names" would drown the real signal.
const CONVENTIONAL_DIRS = new Set([
  'host', 'client', 'server', 'shared', 'common', 'config', 'locale', 'assets',
  'public', 'scripts', 'bin', 'docs', 'types', 'helpers', 'utils', 'lib', 'src',
]);

const EXT_LANGUAGE = new Map([
  ['.js', 'js'], ['.jsx', 'js'], ['.mjs', 'js'], ['.cjs', 'js'], ['.vue', 'js'], ['.svelte', 'js'],
  ['.ts', 'ts'], ['.tsx', 'ts'], ['.mts', 'ts'], ['.cts', 'ts'],
  ['.py', 'py'],
  ['.go', 'go'],
  ['.java', 'java'],
  ['.kt', 'kotlin'], ['.kts', 'kotlin'],
  ['.rs', 'rust'],
  ['.php', 'php'],
  ['.rb', 'ruby'],
]);

const SOURCE_EXTENSIONS = new Set(EXT_LANGUAGE.keys());

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'coverage',
  'vendor', 'target', '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv',
  'env', '.idea', '.vscode', '.turbo', '.pnpm-store', 'tmp', 'logs',
]);

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];
const ASSET_EXTS = new Set([
  '.css', '.scss', '.sass', '.less', '.styl', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.webm',
  '.json', '.md', '.txt', '.yaml', '.yml',
]);

const FUNCTION_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'else',
  'do', 'try', 'finally', 'with', 'match', 'when', 'elif', 'unless', 'case',
  'super', 'this', 'await', 'yield', 'typeof', 'delete', 'void', 'in', 'of',
]);

const BUILTIN_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'typeof',
  'await', 'async', 'then', 'catch', 'finally', 'map', 'filter', 'forEach', 'reduce',
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'split', 'join', 'replace',
  'trim', 'toLowerCase', 'toUpperCase', 'includes', 'startsWith', 'endsWith',
  'JSON', 'Object', 'Array', 'Promise', 'Number', 'String', 'Boolean', 'Math', 'Date',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'require', 'import',
  'console', 'log', 'error', 'warn', 'info', 'debug', 'assert', 'res', 'req', 'next',
  'send', 'json', 'status', 'end', 'write', 'listen', 'use', 'on', 'emit', 'once',
  'createServer', 'fetch', 'axios', 'describe', 'it', 'test', 'expect', 'beforeEach',
  'afterEach', 'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useSWR',
  'query', 'get', 'post', 'put', 'patch', 'delete',
]);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function posixPath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function dirOf(value) {
  const dir = posix.dirname(posixPath(value));
  return dir === '.' ? '' : dir;
}

function baseOf(value) {
  return posix.basename(posixPath(value));
}

function joinRel(...parts) {
  const joined = posix.join(...parts.map((part) => posixPath(part)));
  return joined === '.' ? '' : joined.replace(/^\.\//, '');
}

function normalizeRel(value) {
  let result = posix.normalize(posixPath(value)).replace(/^\.\//, '');
  if (result === '.') result = '';
  return result.replace(/\/+$/, '');
}

function dirDepth(value) {
  const dir = dirOf(value);
  return dir ? dir.split('/').filter(Boolean).length : 0;
}

function countLines(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  const lines = value.split('\n').length;
  return value.endsWith('\n') ? lines - 1 : lines;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function languageOf(path) {
  return EXT_LANGUAGE.get(extname(posixPath(path)).toLowerCase()) ?? '';
}

function projectNameOf(project) {
  const name = String(project?.name ?? '').trim();
  if (name) return name;
  const root = String(project?.path ?? '').trim();
  return root ? baseOf(root) || 'project' : 'project';
}

/** `indexOf`-based line locator, built once per file. */
function createLineAt(content) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') starts.push(index + 1);
  }
  return (position) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= position) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

function makeLog() {
  const items = [];
  const push = (level, text) => {
    const line = trimText(String(text ?? ''), 200);
    if (line) items.push({ ts: nowIso(), level, text: line });
  };
  return {
    info: (text) => push('info', text),
    success: (text) => push('success', text),
    warn: (text) => push('warn', text),
    error: (text) => push('error', text),
    size: () => items.length,
    finish(fallbacks = []) {
      const extras = [];
      for (const text of fallbacks) {
        if (items.length + extras.length >= MIN_ACTIVITY) break;
        extras.push({ ts: nowIso(), level: 'info', text: trimText(String(text ?? ''), 200) });
      }
      if (!extras.length) return items.slice(0, MAX_ACTIVITY);
      const lastSuccess = items.findLastIndex((item) => item.level === 'success');
      const merged = lastSuccess >= 0
        ? [...items.slice(0, lastSuccess), ...extras, ...items.slice(lastSuccess)]
        : [...items, ...extras];
      return merged.slice(0, MAX_ACTIVITY);
    },
  };
}

function sortFindings(list) {
  return list
    .slice()
    .sort((a, b) => (
      severityRank(a.severity) - severityRank(b.severity)
      || String(a.path).localeCompare(String(b.path))
      || Number(a.startLine) - Number(b.startLine)
      || String(a.rule).localeCompare(String(b.rule))
    ));
}

function worseRisk(current, severity) {
  const rank = severityRank(severity);
  if (rank <= 1) return 'high';
  if (rank === 2) return current === 'high' ? 'high' : 'medium';
  return current ?? 'low';
}

function riskOfFindings(list) {
  let risk = 'low';
  for (const item of list) risk = worseRisk(risk, item?.severity);
  return risk;
}

function countByRule(findings) {
  return countBy(findings, 'rule')
    .slice(0, 8)
    .map((entry) => ({ rule: entry.key, count: entry.count }));
}

function isEntryFile(path) {
  const value = posixPath(path);
  if (!languageOf(value)) return false;
  const base = baseOf(value);
  if (/^(?:index|main|app|server|cli|entry|bootstrap|manage|wsgi|asgi|run|start|__main__)(?:\.[^.]+)$/i.test(base)) {
    return true;
  }
  if (/(^|\/)(?:bin|cmd|scripts?|pages\/api|app\/api)\//i.test(value)) return true;
  return false;
}

function isTestFile(path) {
  const value = posixPath(path);
  return /(^|\/)(?:__tests__|tests?|specs?|e2e)\//i.test(value)
    || /\.(?:test|spec)\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(value)
    || /(^|\/)test_[^/]+\.py$/i.test(value)
    || /_test\.(?:py|go)$/i.test(value)
    || /(?:Test|Tests)\.(?:java|kt)$/.test(value)
    || /_spec\.rb$/i.test(value);
}

function isServicePath(path) {
  return /(^|\/)(?:services?|handlers?|usecases?|domain|controllers?|repositories|repo|resolvers?|actions?)\//i.test(posixPath(path));
}

function isUiFile(path, content) {
  const value = posixPath(path);
  if (/\.(?:jsx|tsx|vue|svelte)$/i.test(value)) return true;
  if (/(^|\/)(?:web|webapp|frontend|components?|pages|views|screens)\//i.test(value)) return true;
  return /\b(?:React|useState|useEffect|createElement|render\s*\()/.test(String(content ?? ''));
}

function formatLanguages(stats) {
  const list = [...stats.values()].sort((a, b) => b.loc - a.loc).slice(0, 4);
  if (!list.length) return '未知';
  return list.map((item) => `${item.language.toUpperCase()} ${item.files}`).join(' · ');
}

function normalizeFileInput(files) {
  const raw = Array.isArray(files)
    ? files
    : Array.isArray(files?.files) ? files.files : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const source = typeof item === 'string' ? { path: item } : (item && typeof item === 'object' ? item : null);
    if (!source) continue;
    const path = normalizeRel(String(source.path ?? source.file ?? ''));
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const loc = source.loc != null && Number.isFinite(Number(source.loc)) ? Number(source.loc) : null;
    out.push({
      path,
      loc,
      content: typeof source.content === 'string' ? source.content : null,
    });
  }
  return out;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function walkSourceFiles(root) {
  const base = String(root ?? '').trim();
  if (!base) return [];
  const out = [];
  const queue = [''];
  while (queue.length && out.length < MAX_WALK_FILES) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(join(base, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= MAX_WALK_FILES) break;
      if (!entry || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const child = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        queue.push(child);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        if (/\.(?:min|bundle)\.js$/i.test(entry.name)) continue;
        out.push(child);
      }
    }
  }
  return out;
}

/**
 * Reads project files through the caller's `readFile` (or fs as a fallback),
 * enforces the 256KB contract limit and remembers failures for `summary.errors`.
 */
function createReader({ project, readFile }) {
  const root = project?.path ? posixPath(project.path).replace(/\/+$/, '') : '';
  const cache = new Map();
  const failures = new Map();
  async function read(path, knownContent = null) {
    const key = normalizeRel(path);
    if (!key) return null;
    if (typeof knownContent === 'string') {
      if (Buffer.byteLength(knownContent, 'utf8') > MAX_READ_BYTES) {
        failures.set(key, '超过 256KB，已跳过');
        return null;
      }
      cache.set(key, knownContent);
      return knownContent;
    }
    if (cache.has(key)) return cache.get(key);
    const candidates = [];
    if (isAbsolute(posixPath(key))) candidates.push(key);
    else {
      if (root) candidates.push(join(root, key));
      candidates.push(key);
    }
    let text = null;
    let lastError = null;
    for (const candidate of candidates) {
      try {
        const value = typeof readFile === 'function'
          ? await readFile(candidate)
          : await fsReadFile(candidate, 'utf8');
        if (value == null) continue;
        if (typeof value === 'string') text = value;
        else if (Buffer.isBuffer(value)) text = value.toString('utf8');
        else if (typeof value.content === 'string') text = value.content;
        if (text !== null) break;
      } catch (error) {
        lastError = error;
      }
    }
    if (text === null) {
      failures.set(key, lastError ? errorText(lastError) : '文件不存在或不可读');
      return null;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_READ_BYTES) {
      failures.set(key, '超过 256KB，已跳过');
      return null;
    }
    cache.set(key, text);
    return text;
  }
  return { read, failures };
}

// ---------------------------------------------------------------------------
// Import parsing (JS/TS, Python, Go, Java/Kotlin, Rust, PHP, Ruby)
// ---------------------------------------------------------------------------

const JS_IMPORT_RE = /\bimport\s+(?:type\s+)?(?:[^'";]*?\bfrom\s+)?['"]([^'"\n]+)['"]/g;
const JS_EXPORT_FROM_RE = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*['"]([^'"\n]+)['"]/g;
const JS_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const JS_REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

/** Raw import/require statements of one file, with real line numbers. */
function parseImports(path, content, lang) {
  const out = [];
  const lineAt = createLineAt(content);
  const push = (spec, index, kind, derived = false) => {
    const value = String(spec ?? '').trim();
    if (!value) return;
    if (/^(?:https?:|data:|mailto:)/i.test(value)) return;
    if (ASSET_EXTS.has(extname(value).toLowerCase())) return;
    out.push({ spec: value, kind, line: lineAt(index), derived });
  };
  if (lang === 'js' || lang === 'ts') {
    for (const match of content.matchAll(JS_IMPORT_RE)) push(match[1], match.index, 'import');
    for (const match of content.matchAll(JS_EXPORT_FROM_RE)) push(match[1], match.index, 'import');
    for (const match of content.matchAll(JS_DYNAMIC_IMPORT_RE)) push(match[1], match.index, 'dynamic');
    for (const match of content.matchAll(JS_REQUIRE_RE)) push(match[1], match.index, 'require');
    return out;
  }
  if (lang === 'py') {
    for (const match of content.matchAll(/^[ \t]*import[ \t]+([^\n#;]+)/gm)) {
      for (const token of match[1].split(',')) {
        const spec = token.trim().split(/\s+as\s+/)[0].trim();
        if (spec) push(spec, match.index + match[0].indexOf(spec), 'import');
      }
    }
    for (const match of content.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+([^\n#;]+)/gm)) {
      const base = match[1];
      const index = match.index + match[0].indexOf(base);
      if (base) push(base, index, 'from');
      const names = match[2].replace(/[()]/g, '').split(',');
      for (const rawName of names) {
        const name = rawName.trim().split(/\s+as\s+/)[0].trim();
        if (!name || name === '*') continue;
        if (base.startsWith('.')) push(`${base}${name}`, index, 'from', true);
        else if (base) push(`${base}.${name}`, index, 'from', true);
      }
    }
    return out;
  }
  if (lang === 'go') {
    for (const match of content.matchAll(/^[ \t]*import[ \t]+(?:[\w.]+\s+)?"([^"\n]+)"[ \t]*;?[ \t]*$/gm)) {
      push(match[1], match.index, 'import');
    }
    for (const match of content.matchAll(/^[ \t]*import[ \t]*\(([\s\S]*?)^[ \t]*\)/gm)) {
      const open = match.index + match[0].indexOf('(');
      for (const quoted of match[1].matchAll(/"([^"\n]+)"/g)) push(quoted[1], open + quoted.index, 'import');
    }
    return out;
  }
  if (lang === 'java' || lang === 'kotlin') {
    for (const match of content.matchAll(/^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)(?:\.\*)?[ \t]*;?/gm)) {
      push(match[1], match.index, 'import');
    }
    return out;
  }
  if (lang === 'rust') {
    for (const match of content.matchAll(/^[ \t]*(?:pub[ \t]+)?use[ \t]+([\w:]+)/gm)) {
      push(match[1].replace(/::$/, ''), match.index, 'import');
    }
    for (const match of content.matchAll(/^[ \t]*(?:pub[ \t]+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm)) {
      push(`./${match[1]}`, match.index, 'mod');
    }
    return out;
  }
  if (lang === 'php') {
    for (const match of content.matchAll(/^[ \t]*use[ \t]+([\\\w]+)(?:[ \t]+as[ \t]+\w+)?[ \t]*;/gm)) {
      push(match[1], match.index, 'import');
    }
    for (const match of content.matchAll(/\b(?:require|require_once|include|include_once)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      push(match[1], match.index, 'require');
    }
    return out;
  }
  if (lang === 'ruby') {
    for (const match of content.matchAll(/^[ \t]*require_relative[ \t]*\(?[ \t]*['"]([^'"]+)['"]/gm)) {
      push(match[1], match.index, 'require_relative');
    }
    for (const match of content.matchAll(/^[ \t]*require[ \t]*\(?[ \t]*['"]([^'"]+)['"]/gm)) {
      push(match[1], match.index, 'require');
    }
    return out;
  }
  return out;
}

/** File/dir indexes so import resolution never scans the whole project per edge. */
function buildIndex(paths) {
  const fileSet = new Set();
  const dirSet = new Set(['']);
  const dirSample = new Map();
  const baseMap = new Map();
  for (const rawPath of paths) {
    const path = normalizeRel(rawPath);
    if (!path || fileSet.has(path)) continue;
    fileSet.add(path);
    let dir = dirOf(path);
    if (!dirSample.has(dir)) dirSample.set(dir, path);
    while (dir) {
      if (!dirSet.has(dir)) dirSet.add(dir);
      dir = dirOf(dir);
    }
    const base = baseOf(path);
    const names = [base];
    const bare = base.slice(0, base.length - extname(base).length);
    if (bare && bare !== base) names.push(bare);
    for (const name of names) {
      const list = baseMap.get(name);
      if (!list) baseMap.set(name, [path]);
      else if (list.length < 24 && !list.includes(path)) list.push(path);
    }
  }
  return { fileSet, dirSet, dirSample, baseMap };
}

function firstExisting(candidates, fileSet) {
  for (const candidate of candidates) {
    const value = normalizeRel(candidate);
    if (value && fileSet.has(value)) return value;
  }
  return null;
}

function resolveSuffix(spec, index, extensions) {
  const parts = posixPath(spec).split('/').filter(Boolean);
  if (!parts.length) return null;
  for (let start = 0; start < parts.length; start += 1) {
    const suffix = parts.slice(start).join('/');
    const dirHit = index.dirSample.get(suffix);
    if (dirHit) return dirHit;
    const last = parts[parts.length - 1];
    for (const extension of extensions) {
      const candidate = `${suffix}${extension}`;
      for (const baseHit of index.baseMap.get(last) ?? []) {
        if (baseHit === candidate || baseHit.endsWith(`/${candidate}`)) return baseHit;
      }
    }
  }
  return null;
}

function resolveJs(fromPath, spec, index) {
  // Keep a leading `./` intact: normalizeRel would collapse it and turn a
  // relative import into a bare/package specifier.
  const clean = String(spec ?? '').replace(/[?#].*$/, '').trim();
  if (!clean) return null;
  const exts = JS_EXTS;
  if (clean.startsWith('.') || clean.startsWith('/')) {
    const base = clean.startsWith('/')
      ? clean.slice(1)
      : posix.normalize(posix.join(dirOf(fromPath), clean));
    return firstExisting([base, ...exts.map((ext) => base + ext), ...exts.map((ext) => `${base}/index${ext}`)], index.fileSet);
  }
  if (clean.startsWith('@/') || clean.startsWith('~/') || clean.startsWith('#/')) {
    const base = clean.slice(2);
    return firstExisting([base, ...exts.map((ext) => base + ext), ...exts.map((ext) => `${base}/index${ext}`)], index.fileSet);
  }
  // Bare specifier: only accept it when it maps back into the project
  // (path alias or workspace package), never node_modules.
  const roots = [clean, `src/${clean}`];
  for (const root of roots) {
    const hits = extname(root) ? [root] : [root, ...exts.map((ext) => root + ext), ...exts.map((ext) => `${root}/index${ext}`)];
    const hit = firstExisting(hits, index.fileSet);
    if (hit) return hit;
  }
  return null;
}

function resolvePython(fromPath, spec, index) {
  const clean = String(spec ?? '').trim();
  if (!clean) return null;
  if (clean.startsWith('.')) {
    const match = /^(\.+)(.*)$/.exec(clean);
    if (!match) return null;
    const dots = match[1].length;
    let baseDir = dirOf(fromPath);
    for (let step = 0; step < dots - 1; step += 1) baseDir = dirOf(baseDir);
    const rest = match[2].replace(/\./g, '/');
    const target = rest ? joinRel(baseDir, rest) : baseDir;
    return firstExisting([`${target}.py`, `${target}/__init__.py`, target], index.fileSet);
  }
  const target = clean.replace(/\./g, '/');
  return firstExisting([
    `${target}.py`,
    `${target}/__init__.py`,
    `src/${target}.py`,
    `src/${target}/__init__.py`,
  ], index.fileSet);
}

function resolveRust(fromPath, spec, index) {
  let clean = String(spec ?? '').replace(/::\{.*$/, '').replace(/::$/g, '');
  let base = '';
  if (clean.startsWith('crate::')) {
    base = `src/${clean.slice(7).replace(/::/g, '/')}`;
  } else if (clean.startsWith('super::')) {
    base = posix.normalize(posix.join(dirOf(fromPath), '..', clean.slice(7).replace(/::/g, '/')));
  } else if (clean.startsWith('self::')) {
    base = posix.normalize(posix.join(dirOf(fromPath), clean.slice(6).replace(/::/g, '/')));
  } else if (/^(?:std|core|alloc)::/.test(clean)) {
    return null;
  } else {
    base = `src/${clean.replace(/::/g, '/')}`;
  }
  if (!base) return null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const hit = firstExisting([`${base}.rs`, `${base}/mod.rs`, base], index.fileSet)
      ?? resolveSuffix(base, index, ['.rs']);
    if (hit) return hit;
    const parent = dirOf(base);
    if (!parent || parent === base) break;
    base = parent;
  }
  return null;
}

function resolveRustMod(fromPath, spec, index) {
  const name = String(spec ?? '').replace(/^\.\//, '');
  if (!name) return null;
  const base = dirOf(fromPath) ? `${dirOf(fromPath)}/${name}` : name;
  return firstExisting([`${base}.rs`, `${base}/mod.rs`], index.fileSet);
}

function resolvePhp(fromPath, spec, index) {
  const clean = String(spec ?? '').trim();
  if (!clean) return null;
  if (clean.startsWith('.') || clean.startsWith('/')) {
    const base = clean.startsWith('/')
      ? clean.slice(1)
      : posix.normalize(posix.join(dirOf(fromPath), clean.replace(/^\.\.?\//, '../')));
    return firstExisting([`${base}.php`, `${base}/index.php`, base], index.fileSet);
  }
  const slash = clean.replace(/\\/g, '/');
  const suffixHit = resolveSuffix(slash, index, ['.php']);
  if (suffixHit) return suffixHit;
  return firstExisting([`${slash}.php`, `${slash}/index.php`], index.fileSet);
}

function resolveRuby(fromPath, spec, kind, index) {
  const clean = String(spec ?? '').replace(/\.rb$/, '');
  if (!clean) return null;
  if (kind === 'require_relative' || clean.startsWith('.')) {
    const base = posix.normalize(posix.join(dirOf(fromPath), clean));
    return firstExisting([`${base}.rb`, base], index.fileSet);
  }
  const base = clean.replace(/^\//, '');
  return firstExisting([`${base}.rb`, `lib/${base}.rb`, `${base}/index.rb`], index.fileSet);
}

/** Resolve one import statement to a project-relative file path (or null). */
function resolveImport(fromPath, statement, index) {
  const lang = languageOf(fromPath);
  const spec = statement?.spec;
  if (!spec) return null;
  if (lang === 'js' || lang === 'ts') return resolveJs(fromPath, spec, index);
  if (lang === 'py') return resolvePython(fromPath, spec, index);
  if (lang === 'go') return resolveSuffix(spec, index, ['.go']);
  if (lang === 'java') return resolveSuffix(spec.replace(/\./g, '/'), index, ['.java']);
  if (lang === 'kotlin') return resolveSuffix(spec.replace(/\./g, '/'), index, ['.kt', '.kts']);
  if (lang === 'rust') {
    return statement.kind === 'mod'
      ? resolveRustMod(fromPath, spec, index)
      : resolveRust(fromPath, spec, index);
  }
  if (lang === 'php') return resolvePhp(fromPath, spec, index);
  if (lang === 'ruby') return resolveRuby(fromPath, spec, statement.kind, index);
  return null;
}

// ---------------------------------------------------------------------------
// Tarjan SCC (module cycles) and helpers
// ---------------------------------------------------------------------------

/**
 * Tarjan strong components; returns only real cycles (multi-node SCCs or a
 * self-loop), each as an id array. Input ids are sorted for stable output.
 */
function tarjanCycles(nodeIds, adjacency) {
  const indexes = new Map();
  const lowLinks = new Map();
  const onStack = new Set();
  const stack = [];
  const result = [];
  let counter = 0;

  const visit = (node) => {
    indexes.set(node, counter);
    lowLinks.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    const next = adjacency.get(node);
    if (next) {
      for (const target of next) {
        if (!indexes.has(target)) {
          visit(target);
          lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
        } else if (onStack.has(target)) {
          lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(target)));
        }
      }
    }
    if (lowLinks.get(node) === indexes.get(node)) {
      const component = [];
      let member = null;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      const selfLoop = component.length === 1 && adjacency.get(component[0])?.has(component[0]);
      if (component.length > 1 || selfLoop) result.push(component);
    }
  };

  for (const id of nodeIds) {
    if (!indexes.has(id)) visit(id);
  }
  return result;
}

function orderCycle(ids, adjacency) {
  if (ids.length <= 1) return ids.slice();
  const members = new Set(ids);
  const ordered = [ids[0]];
  const seen = new Set([ids[0]]);
  let cursor = ids[0];
  while (ordered.length < ids.length) {
    const next = [...(adjacency.get(cursor) ?? [])].find((id) => members.has(id) && !seen.has(id));
    if (!next) break;
    ordered.push(next);
    seen.add(next);
    cursor = next;
  }
  for (const id of ids) {
    if (!seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Architecture analysis
// ---------------------------------------------------------------------------

export async function analyzeArchitecture({ project, files, readFile } = {}) {
  const startedAt = Date.now();
  const log = makeLog();
  const projectName = projectNameOf(project);
  const normalized = normalizeFileInput(files);
  let candidates = normalized;
  if (!candidates.length && project?.path) {
    const walked = await walkSourceFiles(project.path);
    candidates = walked.map((path) => ({ path, loc: null, content: null }));
  }
  log.info(`载入项目 ${projectName}：${candidates.length} 个候选文件`);

  const reader = createReader({ project, readFile });
  const loaded = await mapLimit(candidates, 8, async (file) => {
    const content = await reader.read(file.path, file.content);
    return {
      path: file.path,
      loc: file.loc != null ? file.loc : countLines(content),
      content,
    };
  });

  const readable = loaded.filter((file) => typeof file.content === 'string');
  const testFiles = new Set(loaded.filter((file) => isTestFile(file.path)).map((file) => file.path));
  // Tests import the whole world; keeping them in the dependency graph would
  // invent cycles and inflate fan-in. They still feed the missing-test rule.
  const sourceFiles = readable.filter((file) => languageOf(file.path) && !isTestFile(file.path));
  const languageStats = new Map();
  for (const file of sourceFiles) {
    const lang = languageOf(file.path);
    if (!lang) continue;
    const stats = languageStats.get(lang) ?? { language: lang, files: 0, loc: 0 };
    stats.files += 1;
    stats.loc += file.loc;
    languageStats.set(lang, stats);
  }
  log.info(`解析 ${sourceFiles.length} 个源文件，语言分布 ${formatLanguages(languageStats)}`);
  const index = buildIndex(sourceFiles.map((file) => file.path));

  const importRecords = [];
  for (const file of sourceFiles) {
    const lang = languageOf(file.path);
    if (!lang) continue;
    for (const statement of parseImports(file.path, file.content, lang)) {
      importRecords.push({
        ...statement,
        fromPath: file.path,
        lang,
        resolved: resolveImport(file.path, statement, index),
      });
    }
  }
  log.info(`抽取 ${importRecords.length} 条 import/require 语句`);

  const fileLoc = new Map();
  for (const file of readable) fileLoc.set(file.path, file.loc);

  const moduleNameOf = (path) => moduleOfPath(path) || 'root';
  const modules = new Map();
  for (const file of sourceFiles) {
    const name = moduleNameOf(file.path);
    let record = modules.get(name);
    if (!record) {
      record = { name, files: [], loc: 0, entryFiles: [], dirs: new Set() };
      modules.set(name, record);
    }
    record.files.push(file.path);
    record.loc += file.loc;
    record.dirs.add(moduleDirOfPath(file.path));
    if (isEntryFile(file.path)) record.entryFiles.push(file.path);
  }

  const edgeMap = new Map();
  const edgeDetails = new Map();
  const adjacency = new Map();
  for (const name of modules.keys()) adjacency.set(name, new Set());
  for (const record of importRecords) {
    if (!record.resolved) continue;
    const from = moduleNameOf(record.fromPath);
    const to = moduleNameOf(record.resolved);
    if (!modules.has(from) || !modules.has(to) || from === to) continue;
    const key = `${from}\u0000${to}`;
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { from, to, count: 0, kinds: new Set() };
      edgeMap.set(key, edge);
      let details = edgeDetails.get(key);
      if (!details) {
        details = [];
        edgeDetails.set(key, details);
      }
    }
    edge.count += 1;
    edge.kinds.add(record.kind);
    const details = edgeDetails.get(key);
    if (details.length < 8) details.push({ path: record.fromPath, line: record.line });
  }
  const moduleEdges = [...edgeMap.values()];
  for (const edge of moduleEdges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from).add(edge.to);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
  }

  const fanIn = new Map();
  const fanOut = new Map();
  for (const name of modules.keys()) {
    fanIn.set(name, 0);
    fanOut.set(name, 0);
  }
  for (const edge of moduleEdges) {
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  }
  const instabilityOf = (name) => {
    const incoming = fanIn.get(name) ?? 0;
    const outgoing = fanOut.get(name) ?? 0;
    return incoming + outgoing === 0 ? 0 : outgoing / (incoming + outgoing);
  };

  const moduleIds = [...modules.keys()].sort();
  const cycles = tarjanCycles(moduleIds, adjacency)
    .map((component) => orderCycle(component.slice().sort(), adjacency))
    .sort((a, b) => b.length - a.length || a.join(',').localeCompare(b.join(',')));
  log[cycles.length ? 'warn' : 'success'](
    cycles.length ? `Tarjan 强连通分析：发现 ${cycles.length} 组循环依赖` : 'Tarjan 强连通分析：未发现循环依赖',
  );

  const moduleList = [...modules.values()];
  const totalFiles = moduleList.reduce((sum, record) => sum + record.files.length, 0);
  const totalLoc = moduleList.reduce((sum, record) => sum + record.loc, 0);
  const avgFiles = totalFiles / Math.max(1, moduleList.length);
  const avgLoc = totalLoc / Math.max(1, moduleList.length);
  const moduleEdgeKeys = new Set(moduleEdges.map((edge) => `${edge.from}\u0000${edge.to}`));

  const findings = [];
  const addFinding = (input) => findings.push(finding({ ...input, source: 'structural' }));

  const cycleSpot = (cycle) => {
    for (let index = 0; index < cycle.length; index += 1) {
      const from = cycle[index];
      const to = cycle[(index + 1) % cycle.length];
      const details = edgeDetails.get(`${from}\u0000${to}`);
      if (details?.length) return details[0];
    }
    const record = modules.get(cycle[0]);
    return { path: record?.files[0] ?? '', line: 1 };
  };
  for (const cycle of cycles.slice(0, 8)) {
    const spot = cycleSpot(cycle);
    const labels = cycle.map((id) => modules.get(id)?.name ?? id);
    addFinding({
      severity: 'high',
      category: 'maintainability',
      path: spot.path,
      startLine: spot.line,
      endLine: spot.line,
      title: trimText(`循环依赖：${labels.join(' ↔ ')}`, 120),
      content: `${labels.join(' → ')} → ${labels[0]} 形成模块级循环依赖（${cycle.length} 个模块互相 import）。循环会让构建顺序、类型推断与测试隔离都变脆，建议把共享逻辑下沉到新的基础模块，或用接口/事件反转依赖方向。`,
      rule: 'arch.cycle',
      module: cycle[0],
    });
  }

  const largestFileOf = (record) => {
    let best = record.files[0] ?? '';
    for (const file of record.files) {
      if ((fileLoc.get(file) ?? 0) > (fileLoc.get(best) ?? 0)) best = file;
    }
    return best;
  };

  const godModules = moduleList
    .filter((record) => (
      record.files.length >= Math.max(8, avgFiles * 1.8)
      && record.loc >= Math.max(600, avgLoc * 1.8)
    ))
    .sort((a, b) => b.loc - a.loc)
    .slice(0, 8);
  for (const record of godModules) {
    addFinding({
      severity: 'medium',
      category: 'maintainability',
      path: largestFileOf(record),
      startLine: 1,
      endLine: 1,
      title: `god module：${record.name} 文件与代码量双高`,
      content: `${record.name} 有 ${record.files.length} 个文件 / ${record.loc} 行（项目均值 ${Math.round(avgFiles)} 文件 / ${Math.round(avgLoc)} 行），扇入 ${fanIn.get(record.name) ?? 0}、扇出 ${fanOut.get(record.name) ?? 0}。职责过多会让改动相互牵连，建议按子领域拆分并收敛对外入口。`,
      rule: 'arch.god-module',
      module: record.name,
    });
  }

  // A module that several others depend on (stable, low I) reaching into a
  // module with high I means change ripples back up the graph.
  const unstableEdges = moduleEdges.filter((edge) => (
    (fanIn.get(edge.from) ?? 0) >= 2
    && instabilityOf(edge.from) <= 0.4
    && instabilityOf(edge.to) >= 0.55
  ));
  for (const edge of unstableEdges.slice(0, 6)) {
    const spot = edgeDetails.get(`${edge.from}\u0000${edge.to}`)?.[0]
      ?? { path: modules.get(edge.from)?.files[0] ?? '', line: 1 };
    addFinding({
      severity: 'medium',
      category: 'maintainability',
      path: spot.path,
      startLine: spot.line,
      endLine: spot.line,
      title: `不稳定依赖：${edge.from} → ${edge.to}`,
      content: `${edge.from} 被 ${fanIn.get(edge.from) ?? 0} 个模块依赖（不稳定度 ${round2(instabilityOf(edge.from))}），却依赖了不稳定度 ${round2(instabilityOf(edge.to))} 的 ${edge.to}。稳定模块被不稳定模块拖住后，任何改动都会沿着依赖向上扩散；建议把 ${edge.to} 的易变部分抽象成接口或事件。`,
      rule: 'arch.unstable-dependency',
      module: edge.from,
    });
  }

  const orphanModules = moduleList
    .filter((record) => (
      (fanIn.get(record.name) ?? 0) === 0
      && !record.entryFiles.length
    ))
    .sort((a, b) => b.loc - a.loc)
    .slice(0, 5);
  for (const record of orphanModules) {
    addFinding({
      severity: 'low',
      category: 'maintainability',
      path: largestFileOf(record),
      startLine: 1,
      endLine: 1,
      title: `孤儿模块：${record.name} 没有任何入边`,
      content: `${record.name}（${record.files.length} 个文件 / ${record.loc} 行）既不被其他模块 import，也不是入口文件。可能是死代码、待接入的实验模块，或入口在运行时动态加载；建议确认后删除或补充接入点。`,
      rule: 'arch.orphan-module',
      module: record.name,
    });
  }

  const testModules = new Set([...testFiles].map((path) => moduleNameOf(path)));
  for (const testPath of testFiles) {
    const segments = posixPath(testPath).toLowerCase().split('/');
    const stem = baseOf(testPath).toLowerCase();
    for (const record of moduleList) {
      const name = record.name.toLowerCase();
      if (name === record.name && (segments.includes(name) || stem.startsWith(`${name}.`) || stem.startsWith(`${name}-`))) {
        testModules.add(record.name);
      }
    }
  }
  const missingTestModules = moduleList
    .filter((record) => !testModules.has(record.name))
    .sort((a, b) => b.loc - a.loc)
    .slice(0, 6);
  for (const record of missingTestModules) {
    addFinding({
      severity: 'low',
      category: 'test',
      path: largestFileOf(record),
      startLine: 1,
      endLine: 1,
      title: `缺少测试：${record.name} 模块没有测试文件`,
      content: `${record.name} 有 ${record.files.length} 个源文件 / ${record.loc} 行，但没有 *.test.*、*.spec.*、test_*.py 或 *_test.go 文件。建议至少覆盖对外入口与错误分支。`,
      rule: 'arch.missing-tests',
      module: record.name,
    });
  }

  const deepFiles = loaded
    .filter((file) => dirDepth(file.path) > 6)
    .sort((a, b) => dirDepth(b.path) - dirDepth(a.path))
    .slice(0, 5);
  for (const file of deepFiles) {
    addFinding({
      severity: 'low',
      category: 'maintainability',
      path: file.path,
      startLine: 1,
      endLine: 1,
      title: `目录层级过深（${dirDepth(file.path)} 层）`,
      content: `${file.path} 所在目录已有 ${dirDepth(file.path)} 层，超过 6 层的目录通常意味着模块划分过细或命名重复；建议合并中间层或按领域重新组织。`,
      rule: 'arch.deep-directory',
      module: moduleNameOf(file.path),
    });
  }

  const dirFiles = new Map();
  for (const file of readable) {
    const dir = dirOf(file.path);
    if (!dir) continue;
    if (!dirFiles.has(dir)) dirFiles.set(dir, file.path);
  }
  const dirsByName = new Map();
  for (const [dir, file] of dirFiles) {
    const name = baseOf(dir);
    if (!name || name.length < 2 || SOURCE_ROOTS.has(name) || CONVENTIONAL_DIRS.has(name)) continue;
    const list = dirsByName.get(name) ?? [];
    list.push({ dir, file });
    dirsByName.set(name, list);
  }
  const duplicateDirs = [...dirsByName.entries()]
    .filter(([, list]) => list.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);
  for (const [name, list] of duplicateDirs) {
    addFinding({
      severity: 'medium',
      category: 'maintainability',
      path: list[1].file,
      startLine: 1,
      endLine: 1,
      title: `重复模块名：${list.length} 个目录都叫 ${name}`,
      content: `以下目录同名，容易被 import 路径和模块归属混淆：${list.map((item) => item.dir).join('、')}。建议给它们更具体的领域命名，避免「同名不同职责」。`,
      rule: 'arch.duplicate-module-name',
      module: moduleNameOf(list[1].file),
    });
  }

  const riskByModule = new Map();
  for (const item of findings) {
    if (!item.module) continue;
    riskByModule.set(item.module, worseRisk(riskByModule.get(item.module), item.severity));
  }

  const cycleEdgeKeys = new Set();
  for (const cycle of cycles) {
    for (let index = 0; index < cycle.length; index += 1) {
      cycleEdgeKeys.add(`${cycle[index]}\u0000${cycle[(index + 1) % cycle.length]}`);
    }
  }
  const unstableEdgeKeys = new Set(unstableEdges.map((edge) => `${edge.from}\u0000${edge.to}`));

  const moduleRank = moduleList
    .slice()
    .sort((a, b) => b.loc - a.loc || b.files.length - a.files.length || a.name.localeCompare(b.name));
  const keptModules = moduleRank.slice(0, MAX_ARCH_MODULES);
  const keptNames = new Set(keptModules.map((record) => record.name));
  const nodes = keptModules.map((record) => ({
    id: record.name,
    label: record.name,
    kind: 'module',
    path: record.dirs.size ? [...record.dirs][0] : dirOf(record.files[0] ?? ''),
    files: record.files.length,
    loc: record.loc,
    risk: riskByModule.get(record.name) ?? 'low',
    entryFiles: record.entryFiles.slice(0, 3),
    meta: {
      fanIn: fanIn.get(record.name) ?? 0,
      fanOut: fanOut.get(record.name) ?? 0,
      instability: round2(instabilityOf(record.name)),
      testFiles: [...testFiles].filter((path) => moduleNameOf(path) === record.name).length,
    },
  }));
  const edges = moduleEdges
    .filter((edge) => keptNames.has(edge.from) && keptNames.has(edge.to))
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: 'import',
      count: edge.count,
      risk: cycleEdgeKeys.has(`${edge.from}\u0000${edge.to}`)
        ? 'high'
        : unstableEdgeKeys.has(`${edge.from}\u0000${edge.to}`) ? 'medium' : 'low',
    }));
  const graph = {
    nodes,
    edges,
    cycles: cycles.filter((cycle) => cycle.every((id) => keptNames.has(id))),
    meta: {
      totalModules: modules.size,
      otherCount: Math.max(0, modules.size - keptModules.length),
      moduleEdges: moduleEdges.length,
    },
  };
  log.info('计算扇入/扇出与不稳定度，构建模块依赖图');
  log.info(`识别 ${godModules.length} 个 god module、${orphanModules.length} 个孤儿模块、${duplicateDirs.length} 组重名目录`);
  log.info(`执行 7 条结构规则，产出 ${findings.length} 个 finding`);

  const sorted = sortFindings(findings);
  const counts = countFindings(sorted);
  const maxFanIn = Math.max(0, ...moduleList.map((record) => fanIn.get(record.name) ?? 0));
  const maxFanOut = Math.max(0, ...moduleList.map((record) => fanOut.get(record.name) ?? 0));
  const avgInstability = moduleList.length
    ? moduleList.reduce((sum, record) => sum + instabilityOf(record.name), 0) / moduleList.length
    : 0;
  const largestModules = moduleRank.slice(0, 5).map((record) => ({
    id: record.name,
    name: record.name,
    files: record.files.length,
    loc: record.loc,
    fanIn: fanIn.get(record.name) ?? 0,
    fanOut: fanOut.get(record.name) ?? 0,
    instability: round2(instabilityOf(record.name)),
  }));
  const metrics = {
    files: sourceFiles.length,
    tests: testFiles.size,
    loc: totalLoc,
    modules: modules.size,
    edges: moduleEdges.length,
    cycles: cycles.length,
    maxFanIn,
    maxFanOut,
    avgInstability: round2(avgInstability),
    largestModules,
    languages: [...languageStats.values()].sort((a, b) => b.loc - a.loc),
    unresolvedImports: importRecords.filter((record) => !record.resolved && !record.derived).length,
    entryModules: moduleList.filter((record) => record.entryFiles.length).length,
    skippedFiles: reader.failures.size,
  };

  const cycleLabels = cycles.slice(0, 3).map((cycle) => cycle.map((id) => modules.get(id)?.name ?? id).join('↔'));
  const notes = [];
  notes.push(`共解析 ${sourceFiles.length} 个源文件（${totalLoc} 行），归并为 ${modules.size} 个顶层模块、${moduleEdges.length} 条模块依赖。`);
  if (cycles.length) {
    notes.push(`循环依赖 ${cycles.length} 组：${cycleLabels.join('；')}${cycles.length > 3 ? ' 等' : ''}，优先按接口/事件反转依赖。`);
  } else {
    notes.push('未发现模块级循环依赖，依赖方向清晰。');
  }
  if (godModules.length) {
    notes.push(`god module：${godModules.slice(0, 3).map((record) => `${record.name}（${record.files.length} 文件 / ${record.loc} 行）`).join('、')}，建议按子领域拆分。`);
  } else {
    notes.push(`最大模块 ${largestModules[0]?.name ?? '—'}（${largestModules[0]?.files ?? 0} 文件 / ${largestModules[0]?.loc ?? 0} 行），规模分布正常。`);
  }
  if (unstableEdges.length) notes.push(`${unstableEdges.length} 条稳定→不稳定的依赖，容易把易变实现扩散到稳定模块。`);
  if (orphanModules.length || duplicateDirs.length || deepFiles.length) {
    notes.push(`另有 ${orphanModules.length} 个孤儿模块、${duplicateDirs.length} 组重名目录、${deepFiles.length} 个超深目录待清理。`);
  }
  if (missingTestModules.length) notes.push(`${missingTestModules.length} 个模块没有测试文件（${missingTestModules.slice(0, 3).map((record) => record.name).join('、')}）。`);
  if (reader.failures.size) notes.push(`${reader.failures.size} 个文件读取失败或超过 256KB，结论可能不完整。`);
  notes.push(`图表保留 ${keptModules.length}/${modules.size} 个模块节点，其余 ${Math.max(0, modules.size - keptModules.length)} 个按 LOC 合并计数。`);
  if (reader.failures.size) log.warn(`${reader.failures.size} 个文件读取失败/超限`);

  const headline = cycles.length
    ? `发现 ${cycles.length} 组循环依赖、${counts.high} 项高风险`
    : `未发现循环依赖，${modules.size} 个模块边界基本清晰`;
  log.success(`架构分析完成，耗时 ${Date.now() - startedAt}ms`);

  return {
    findings: sorted,
    metrics,
    graph,
    summary: {
      headline: trimText(headline, 40),
      notes: notes.slice(0, 6),
      stats: {
        files: sourceFiles.length,
        modules: modules.size,
        edges: moduleEdges.length,
        cycles: cycles.length,
        findings: counts,
        maxFanIn,
        maxFanOut,
        avgInstability: round2(avgInstability),
      },
      errors: [...reader.failures.entries()].slice(0, 10).map(([path, message]) => `${path}: ${message}`),
    },
    activity: log.finish([
      '扫描项目文件并归并顶层模块',
      '解析多语言 import/require 关系',
      '执行 Tarjan 强连通分量检测',
      '汇总架构健康度指标',
    ]),
  };
}

function moduleDirOfPath(path) {
  const parts = posixPath(path).split('/');
  if (parts.length <= 1) return '';
  if (SOURCE_ROOTS.has(parts[0])) return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
  return parts[0];
}

// ---------------------------------------------------------------------------
// Generic source scanners (shared by module / flow / diff analyzers)
// ---------------------------------------------------------------------------

function skipQuoted(content, start) {
  const quote = content[start];
  for (let index = start + 1; index < content.length; index += 1) {
    const ch = content[index];
    if (ch === '\\') {
      index += 1;
      continue;
    }
    if (ch === quote) return index;
    if (quote !== '`' && ch === '\n') return index;
  }
  return content.length - 1;
}

/** Index of the `}` matching the `{` at `start`, skipping strings/comments. */
function matchBrace(content, start) {
  let depth = 0;
  for (let index = start; index < content.length; index += 1) {
    const ch = content[index];
    if (ch === '"' || ch === "'" || ch === '`') {
      index = skipQuoted(content, index);
      continue;
    }
    if (ch === '/' && content[index + 1] === '/') {
      const end = content.indexOf('\n', index);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (ch === '/' && content[index + 1] === '*') {
      const end = content.indexOf('*/', index + 2);
      if (end < 0) return -1;
      index = end + 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function countComplexity(text) {
  let score = 0;
  for (const _match of String(text ?? '').matchAll(/\b(?:if|for|while|case|catch)\b|&&|\|\||\?(?![.?])/g)) {
    score += 1;
  }
  return score;
}

function indentSpan(content, matchIndex, indent) {
  const declarationEnd = content.indexOf('\n', matchIndex);
  if (declarationEnd < 0) return { endIndex: content.length, text: content.slice(matchIndex) };
  let cursor = declarationEnd + 1;
  let end = content.length;
  while (cursor < content.length) {
    const nextNewline = content.indexOf('\n', cursor);
    const lineEnd = nextNewline < 0 ? content.length : nextNewline;
    const line = content.slice(cursor, lineEnd);
    if (line.trim() && !/^\s*#/.test(line)) {
      const lineIndent = /^[ \t]*/.exec(line)[0].length;
      if (lineIndent <= indent) {
        end = cursor;
        break;
      }
    }
    cursor = lineEnd + 1;
  }
  return { endIndex: end, text: content.slice(matchIndex, end) };
}

/** Heuristic function inventory for one file: span, line range, complexity. */
function extractFunctions(path, content, lang) {
  const results = [];
  const lineAt = createLineAt(content);
  const seen = new Set();
  const push = (name, matchIndex, span) => {
    if (!name || FUNCTION_KEYWORDS.has(name)) return;
    const startLine = lineAt(matchIndex);
    const endLine = span ? lineAt(span.endIndex) : startLine;
    const key = `${name}:${startLine}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      name,
      file: path,
      line: startLine,
      startLine,
      endLine,
      lines: Math.max(1, endLine - startLine + 1),
      complexity: countComplexity(span?.text),
    });
  };
  const braceSpan = (fromIndex) => {
    const brace = content.indexOf('{', fromIndex);
    if (brace < 0) return null;
    const end = matchBrace(content, brace);
    if (end < 0) return null;
    return { endIndex: end, text: content.slice(brace, end + 1) };
  };

  if (lang === 'js' || lang === 'ts') {
    for (const match of content.matchAll(/^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm)) {
      push(match[1], match.index, braceSpan(match.index + match[0].length));
    }
    for (const match of content.matchAll(/^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm)) {
      push(match[1], match.index, braceSpan(match.index + match[0].length));
    }
    for (const match of content.matchAll(/^[ \t]*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
      push(match[1], match.index, braceSpan(match.index + match[0].length - 1));
    }
    return results;
  }
  if (lang === 'py') {
    for (const match of content.matchAll(/^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm)) {
      push(match[2], match.index, indentSpan(content, match.index, match[1].length));
    }
    return results;
  }
  if (lang === 'go') {
    for (const match of content.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm)) {
      push(match[1], match.index, braceSpan(match.index + match[0].length));
    }
    return results;
  }
  if (lang === 'java') {
    for (const match of content.matchAll(/^[ \t]*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)+(?:[\w$<>\[\],.?&\s]+?)\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws[^{]+)?\{/gm)) {
      push(match[1], match.index, braceSpan(match.index + match[0].length - 1));
    }
    return results;
  }
  if (lang === 'kotlin') {
    for (const match of content.matchAll(/^[ \t]*(?:(?:public|private|protected|internal|open|override|suspend|inline|operator|infix|tailrec|external|abstract|final|actual|expect)\s+)*fun\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)\s*\(/gm)) {
      push(match[1], match.index, braceSpan(match.index + match[0].length));
    }
    return results;
  }
  if (lang === 'rust') {
    for (const match of content.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/gm)) {
      push(match[1], match.index, braceSpan(match.index + match[0].length));
    }
    return results;
  }
  if (lang === 'php') {
    for (const match of content.matchAll(/^[ \t]*(?:(?:public|private|protected|static|final|abstract|var)\s+)*function\s+([A-Za-z_]\w*)\s*\(/gm)) {
      push(match[1], match.index, braceSpan(match.index + match[0].length));
    }
    return results;
  }
  if (lang === 'ruby') {
    for (const match of content.matchAll(/^([ \t]*)def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/gm)) {
      const indent = match[1].length;
      const declarationEnd = content.indexOf('\n', match.index);
      const text = declarationEnd < 0 ? content.slice(match.index) : content.slice(match.index, declarationEnd);
      push(match[2], match.index, { endIndex: declarationEnd < 0 ? content.length : declarationEnd, text });
    }
    return results;
  }
  return results;
}

/** Normalized code line used by the duplicate-window detector. */
function normalizeCodeLine(line) {
  return String(line ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectDuplicateWindows(files, windowSize = DUPLICATE_WINDOW) {
  const ledger = new Map();
  const lastReported = new Map();
  const groups = [];
  for (const file of files) {
    if (typeof file.content !== 'string') continue;
    const lines = file.content.split('\n');
    const normalized = [];
    const lineNumbers = [];
    for (let index = 0; index < lines.length; index += 1) {
      const value = normalizeCodeLine(lines[index]);
      if (!value || value.length < 4) continue;
      if (/^(?:\{|\}|\);?|\);|\]|,|<\/?\w+[^>]*>)$/.test(value)) continue;
      if (/^[*#]/.test(value)) continue;
      if (/^(?:import|from|require|use|package|namespace)\b/.test(value)) continue;
      normalized.push(value);
      lineNumbers.push(index + 1);
    }
    for (let start = 0; start + windowSize <= normalized.length; start += 1) {
      const windowText = normalized.slice(start, start + windowSize).join('\n');
      if (windowText.length < 120) continue;
      const key = hash(windowText, 16);
      const entry = ledger.get(key);
      const spot = { file: file.path, line: lineNumbers[start] };
      if (!entry) {
        ledger.set(key, { spot, reported: false });
        continue;
      }
      if (entry.reported) continue;
      if (entry.spot.file === spot.file && Math.abs(entry.spot.line - spot.line) < windowSize) continue;
      // Overlapping windows would otherwise report the same duplicated block
      // once per shifted position; keep one finding per block region.
      const previous = lastReported.get(spot.file);
      if (previous != null && Math.abs(previous - spot.line) < windowSize) continue;
      entry.reported = true;
      lastReported.set(spot.file, spot.line);
      groups.push({ first: entry.spot, second: spot, lines: windowSize });
    }
  }
  return groups;
}

const LOG_ONLY_RE = /^(?:(?:console|logger|log|this\.logger|LOGGER)\s*\.\s*(?:log|info|warn|error|debug|trace)\s*\([^;]*\)\s*;?|(?:print|println|puts|fmt\.\w+)\s*\([^;]*\)\s*;?|(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*$/;

/** True when a catch/except body only logs (or is comment-only): silent failure. */
function isLogOnlyBody(body) {
  const trimmed = String(body ?? '').trim();
  if (!trimmed) return false;
  if (/\b(?:throw|raise|reject|next|process\.exit|return|res\.(?:status|send|json)|panic|log\.fatal)\b/.test(trimmed)) return false;
  const stripped = trimmed
    .replace(/(?:console|logger|log|this\.logger)\s*\.\s*(?:log|info|warn|error|debug|trace)\s*\([^;]*\)\s*;?/g, '')
    .replace(/\b(?:print|println|puts|fmt\.\w+)\s*\([^;]*\)\s*;?/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .trim();
  if (!stripped || /^[;\s]*$/.test(stripped)) return true;
  return LOG_ONLY_RE.test(stripped);
}

const SECRET_PATTERN = /(?:api[_-]?key|secret|token|passwd|password|pwd|access[_-]?key)\s*(?::|=>|=)\s*(['"`])([^'"`\n]{6,})\1/gi;

function isPlaceholderSecret(value) {
  const text = String(value ?? '').trim();
  if (!text) return true;
  return /^(?:process\.env|x{3,}|\*{3,}|\$\{|<|your[-_ ]|test[-_]?|dummy|example|placeholder|changeme|replace|todo|none|null|undefined|sk-test|abc123|123456)/i.test(text);
}

function countExports(content, lang) {
  if (lang === 'js' || lang === 'ts') {
    let total = 0;
    for (const _match of content.matchAll(/^[ \t]*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\b/gm)) total += 1;
    for (const _match of content.matchAll(/\bmodule\.exports\b/g)) total += 1;
    return total;
  }
  if (lang === 'py') {
    let total = 0;
    for (const match of content.matchAll(/^[ \t]*(?:async\s+)?def\s+([A-Za-z]\w*)/gm)) if (!match[1].startsWith('_')) total += 1;
    for (const match of content.matchAll(/^[ \t]*class\s+([A-Za-z]\w*)/gm)) if (!match[1].startsWith('_')) total += 1;
    return total;
  }
  if (lang === 'go') {
    let total = 0;
    for (const _match of content.matchAll(/^func\s+(?:\([^)]*\)\s*)?[A-Z]\w*\s*\(/gm)) total += 1;
    return total;
  }
  if (lang === 'java' || lang === 'kotlin') {
    let total = 0;
    for (const _match of content.matchAll(/^[ \t]*public\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum|fun|[\w<>\[\]]+)\s+/gm)) total += 1;
    return total;
  }
  if (lang === 'rust') {
    let total = 0;
    for (const _match of content.matchAll(/^[ \t]*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|const|mod)\b/gm)) total += 1;
    return total;
  }
  if (lang === 'php') {
    let total = 0;
    for (const _match of content.matchAll(/^[ \t]*(?:(?:public|protected)\s+)?function\s+\w+/gm)) total += 1;
    return total;
  }
  if (lang === 'ruby') {
    let total = 0;
    for (const _match of content.matchAll(/^[ \t]*def\s+\w+/gm)) total += 1;
    return total;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Module analysis
// ---------------------------------------------------------------------------

export async function analyzeModule({ project, modulePath, files, readFile } = {}) {
  const startedAt = Date.now();
  const log = makeLog();
  const projectName = projectNameOf(project);
  const targetPath = normalizeRel(modulePath ?? '');
  const moduleLabel = targetPath || projectName;

  let normalized = normalizeFileInput(files);
  if (targetPath) {
    const under = normalized.filter((file) => file.path === targetPath || file.path.startsWith(`${targetPath}/`));
    if (under.length) normalized = under;
  }
  if (!normalized.length && project?.path) {
    const root = targetPath ? joinRel(project.path, targetPath) : project.path;
    const walked = await walkSourceFiles(root);
    normalized = walked.map((path) => ({
      path: targetPath ? joinRel(targetPath, path) : path,
      loc: null,
      content: null,
    }));
  }
  log.info(`载入模块 ${moduleLabel}：${normalized.length} 个候选文件`);

  const reader = createReader({ project, readFile });
  const loaded = await mapLimit(normalized, 8, async (file) => {
    const content = await reader.read(file.path, file.content);
    return {
      path: file.path,
      language: languageOf(file.path),
      loc: file.loc != null ? file.loc : countLines(content),
      content,
    };
  });
  const analyzed = loaded.filter((file) => typeof file.content === 'string');
  const totalLoc = loaded.reduce((sum, file) => sum + file.loc, 0);
  log.info(`读取 ${analyzed.length} 个文件内容（单文件上限 256KB）`);

  const functions = [];
  const importRecords = [];
  const fileSummaries = [];
  let exportsTotal = 0;
  for (const file of analyzed) {
    const lang = file.language || languageOf(file.path);
    const fileFunctions = extractFunctions(file.path, file.content, lang);
    functions.push(...fileFunctions);
    const imports = lang ? parseImports(file.path, file.content, lang) : [];
    importRecords.push(...imports.map((item) => ({ ...item, fromPath: file.path })));
    const exportsCount = countExports(file.content, lang);
    exportsTotal += exportsCount;
    fileSummaries.push({ file, lang, imports: imports.length, exports: exportsCount, functions: fileFunctions });
  }
  const totalComplexity = functions.reduce((sum, item) => sum + item.complexity, 0);
  log.info(`解析 ${functions.length} 个函数，圈复杂度合计 ${totalComplexity}`);

  const findings = [];
  const addFinding = (input) => findings.push(finding({ ...input, source: 'structural' }));
  const magicCandidates = [];
  let todoCount = 0;

  const largestFile = analyzed
    .slice()
    .sort((a, b) => b.loc - a.loc)[0] ?? { path: '', loc: 0 };

  for (const file of analyzed) {
    const lang = file.language || languageOf(file.path);
    const content = file.content;
    const lines = content.split('\n');
    const moduleName = targetPath ? moduleOfPath(file.path) || moduleLabel : moduleOfPath(file.path) || '';
    const lineAt = createLineAt(content);

    if (file.loc > 800) {
      addFinding({
        severity: 'medium',
        category: 'maintainability',
        path: file.path,
        startLine: 1,
        endLine: Math.min(3, lines.length),
        title: `超大文件：${file.loc} 行`,
        content: `${file.path} 有 ${file.loc} 行，超过 800 行阈值，单文件理解与改动成本都偏高；建议按职责拆分为多个文件。`,
        rule: 'module.large-file',
        module: moduleName,
      });
    }

    for (const item of functions.filter((fn) => fn.file === file.path && fn.lines > 80).slice(0, 6)) {
      addFinding({
        severity: 'medium',
        category: 'maintainability',
        path: item.file,
        startLine: item.startLine,
        endLine: item.endLine,
        title: `超长函数：${item.name}（${item.lines} 行）`,
        content: `函数 ${item.name} 跨越 ${item.lines} 行、圈复杂度约 ${item.complexity}，超过 80 行阈值。建议拆成小函数，把校验、IO 与业务分支分开，便于单测。`,
        rule: 'module.long-function',
        module: moduleName,
      });
    }

    const todoLines = [];
    for (const match of content.matchAll(/\b(TODO|FIXME|HACK)\b[^\n]{0,120}/g)) {
      todoCount += 1;
      if (todoLines.length < 20) todoLines.push({ line: lineAt(match.index), text: trimText(match[0], 140) });
    }
    for (const item of todoLines) {
      addFinding({
        severity: 'low',
        category: 'maintainability',
        path: file.path,
        startLine: item.line,
        endLine: item.line,
        title: trimText(`遗留标记：${item.text}`, 120),
        content: `遗留标记：${item.text}。TODO/FIXME/HACK 会随着时间腐化，建议转成 issue 或补齐实现。`,
        rule: 'module.todo',
        module: moduleName,
      });
    }

    const debugPattern = lang === 'py'
      ? /(?:^|\s)(?:print|breakpoint)\s*\(/gm
      : /console\s*\.\s*(?:log|debug|info)\s*\(|\bdebugger\b|\bfmt\.Print(?:ln|f)?\s*\(|\bvar_dump\s*\(|\bSystem\.out\.print(?:ln)?\s*\(/gm;
    const debugLines = [];
    for (const match of content.matchAll(debugPattern)) {
      if (debugLines.length < 8) debugLines.push(lineAt(match.index));
    }
    if (debugLines.length) {
      addFinding({
        severity: 'low',
        category: 'style',
        path: file.path,
        startLine: debugLines[0],
        endLine: debugLines[debugLines.length - 1],
        title: `调试残留 ${debugLines.length} 处`,
        content: `文件中有 ${debugLines.length} 处调试输出（行 ${debugLines.join('、')}）。提交前建议清理，或改用项目统一的 logger 并降低级别。`,
        rule: 'module.debug-leftover',
        module: moduleName,
      });
    }

    for (const match of content.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) {
      addFinding({
        severity: 'high',
        category: 'bug',
        path: file.path,
        startLine: lineAt(match.index),
        endLine: lineAt(match.index),
        title: '空 catch 块吞掉了错误',
        content: 'catch 块为空：异常被完全忽略，调用方无法感知失败，容易造成数据不一致或静默丢请求。至少记录日志并向上抛出/返回错误码。',
        rule: 'module.empty-catch',
        module: moduleName,
      });
    }
    for (const match of content.matchAll(/except[^\n:]*:\s*pass\b/g)) {
      addFinding({
        severity: 'high',
        category: 'bug',
        path: file.path,
        startLine: lineAt(match.index),
        endLine: lineAt(match.index),
        title: 'except: pass 吞掉了错误',
        content: 'Python 异常被 pass 静默忽略；建议捕获具体异常、记录上下文并重新抛出或返回错误。',
        rule: 'module.empty-catch',
        module: moduleName,
      });
    }

    for (const match of content.matchAll(/catch\s*(?:\([^)]*\))?\s*\{([^{}]{0,500})\}/g)) {
      if (!isLogOnlyBody(match[1])) continue;
      addFinding({
        severity: 'medium',
        category: 'bug',
        path: file.path,
        startLine: lineAt(match.index),
        endLine: lineAt(match.index),
        title: 'catch 只记录日志，异常被吞掉',
        content: 'catch 块里只有日志输出，没有向上抛出、没有错误码、也没有补偿动作；调用方会以为成功。建议记录后重新抛出，或返回显式失败结果。',
        rule: 'module.swallowed-error',
        module: moduleName,
      });
    }
    for (const match of content.matchAll(/except[^\n:]*:\s*\n((?:[ \t]+[^\n]*\n?)+)/g)) {
      if (!isLogOnlyBody(match[1])) continue;
      addFinding({
        severity: 'medium',
        category: 'bug',
        path: file.path,
        startLine: lineAt(match.index),
        endLine: lineAt(match.index),
        title: 'except 只记录日志，异常被吞掉',
        content: 'except 块只打印日志后继续执行，失败被静默降级；建议重新抛出或返回明确错误状态。',
        rule: 'module.swallowed-error',
        module: moduleName,
      });
    }

    for (const match of content.matchAll(SECRET_PATTERN)) {
      if (isPlaceholderSecret(match[2])) continue;
      addFinding({
        severity: 'high',
        category: 'security',
        path: file.path,
        startLine: lineAt(match.index),
        endLine: lineAt(match.index),
        title: '疑似硬编码密钥/口令',
        content: `代码中直接写入了疑似凭据（${trimText(match[1] + '=***', 40)}）。应改为环境变量或密钥管理服务，并立即轮换已泄漏的值。`,
        rule: 'module.hardcoded-secret',
        module: moduleName,
      });
    }

    for (const match of content.matchAll(/\beval\s*\(|new\s+Function\s*\(/g)) {
      addFinding({
        severity: 'high',
        category: 'security',
        path: file.path,
        startLine: lineAt(match.index),
        endLine: lineAt(match.index),
        title: '使用 eval / new Function 执行动态代码',
        content: '动态执行字符串代码会放大注入风险，且让静态分析与压缩失效。建议改用显式映射表或安全的解析器。',
        rule: 'module.dangerous-eval',
        module: moduleName,
      });
    }

    for (const match of content.matchAll(/\.innerHTML\s*=|dangerouslySetInnerHTML|document\.write\s*\(/g)) {
      addFinding({
        severity: 'medium',
        category: 'security',
        path: file.path,
        startLine: lineAt(match.index),
        endLine: lineAt(match.index),
        title: '直接写入 HTML（XSS 风险）',
        content: '把数据拼进 innerHTML / dangerouslySetInnerHTML 会引入 XSS。建议使用 textContent 或先做白名单转义。',
        rule: 'module.innerHTML',
        module: moduleName,
      });
    }

    const anyLines = [];
    for (const match of content.matchAll(/(?::\s*any\b|\bas\s+any\b|@ts-ignore|@ts-expect-error|<any>)/g)) {
      if (anyLines.length < 8) anyLines.push(lineAt(match.index));
    }
    if (anyLines.length) {
      addFinding({
        severity: 'low',
        category: 'maintainability',
        path: file.path,
        startLine: anyLines[0],
        endLine: anyLines[anyLines.length - 1],
        title: `显式 any / ts-ignore ${anyLines.length} 处`,
        content: `文件中有 ${anyLines.length} 处显式 any 或 @ts-ignore（行 ${anyLines.join('、')}）。类型逃逸会掩盖真实错误，建议补充精确类型或局部收窄。`,
        rule: 'module.explicit-any',
        module: moduleName,
      });
    }

    for (let index = 0; index < lines.length && magicCandidates.length < 12; index += 1) {
      const line = lines[index];
      if (/^\s*(?:\/\/|#|\*|\/\*)/.test(line)) continue;
      if (/\b(?:const|let|var|enum|import|from|require|export)\b/.test(line)) continue;
      if (!/[=<>+\-*/%]|\(/.test(line)) continue;
      const match = /(?<![\w$.])(\d{2,})(?![\w.%])/.exec(line);
      if (!match) continue;
      magicCandidates.push({ path: file.path, line: index + 1, value: match[1], text: line.trim(), module: moduleName });
    }
  }

  // Magic numbers are the noisiest rule: keep at most three across the module.
  for (const candidate of magicCandidates.slice(0, 3)) {
    addFinding({
      severity: 'low',
      category: 'maintainability',
      path: candidate.path,
      startLine: candidate.line,
      endLine: candidate.line,
      title: `魔法数字 ${candidate.value}`,
      content: `数字 ${candidate.value} 直接出现在逻辑里（${trimText(candidate.text, 120)}）。建议提取为有名字的常量，解释其业务含义。`,
      rule: 'module.magic-number',
      module: candidate.module,
    });
  }

  const duplicateGroups = collectDuplicateWindows(analyzed);
  for (const group of duplicateGroups.slice(0, 5)) {
    addFinding({
      severity: 'medium',
      category: 'maintainability',
      path: group.second.file,
      startLine: group.second.line,
      endLine: group.second.line + group.lines - 1,
      title: `重复代码窗口（${group.lines} 行）`,
      content: `${group.second.file}:${group.second.line} 起的 ${group.lines} 行与 ${group.first.file}:${group.first.line} 起完全重复（忽略缩进与注释）。建议抽成共享函数，避免两处逻辑逐渐分叉。`,
      rule: 'module.duplicate-code',
      module: targetPath ? moduleOfPath(group.second.file) || moduleLabel : moduleOfPath(group.second.file) || '',
    });
  }
  log.info(`扫描 TODO/调试残留/危险模式/重复代码，命中 ${findings.length} 个问题`);

  // ---- module file dependency graph -------------------------------------
  const index = buildIndex(analyzed.map((file) => file.path));
  const edgeMap = new Map();
  const adjacency = new Map();
  for (const file of analyzed) adjacency.set(file.path, new Set());
  for (const record of importRecords) {
    const resolved = resolveImport(record.fromPath, record, index);
    if (!resolved || resolved === record.fromPath) continue;
    const key = `${record.fromPath}\u0000${resolved}`;
    edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
    adjacency.get(record.fromPath)?.add(resolved);
    if (!adjacency.has(resolved)) adjacency.set(resolved, new Set());
  }
  const internalEdges = [...edgeMap.entries()].map(([key, count]) => {
    const [from, to] = key.split('\u0000');
    return { from, to, count };
  });
  const cycles = tarjanCycles([...adjacency.keys()].sort(), adjacency)
    .map((component) => orderCycle(component.slice().sort(), adjacency));

  const riskByFile = new Map();
  for (const item of findings) {
    riskByFile.set(item.path, worseRisk(riskByFile.get(item.path), item.severity));
  }
  const keptFiles = analyzed
    .slice()
    .sort((a, b) => b.loc - a.loc || a.path.localeCompare(b.path))
    .slice(0, MAX_MODULE_GRAPH_FILES);
  const keptPaths = new Set(keptFiles.map((file) => file.path));
  const fileSummaryByPath = new Map(fileSummaries.map((item) => [item.file.path, item]));
  const nodes = keptFiles.map((file) => ({
    id: file.path,
    label: baseOf(file.path),
    kind: 'file',
    path: file.path,
    files: 1,
    loc: file.loc,
    risk: riskByFile.get(file.path) ?? 'low',
    entryFiles: isEntryFile(file.path) ? [file.path] : [],
    meta: {
      language: file.language || languageOf(file.path),
      imports: fileSummaryByPath.get(file.path)?.imports ?? 0,
      exports: fileSummaryByPath.get(file.path)?.exports ?? 0,
      functions: fileSummaryByPath.get(file.path)?.functions.length ?? 0,
    },
  }));
  const cycleEdgeKeys = new Set();
  for (const cycle of cycles) {
    for (let index2 = 0; index2 < cycle.length; index2 += 1) {
      cycleEdgeKeys.add(`${cycle[index2]}\u0000${cycle[(index2 + 1) % cycle.length]}`);
    }
  }
  const edges = internalEdges
    .filter((edge) => keptPaths.has(edge.from) && keptPaths.has(edge.to))
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: 'import',
      count: edge.count,
      risk: cycleEdgeKeys.has(`${edge.from}\u0000${edge.to}`) ? 'high' : 'low',
    }));
  const graph = {
    nodes,
    edges,
    cycles: cycles.filter((cycle) => cycle.every((id) => keptPaths.has(id))),
    meta: {
      totalFiles: analyzed.length,
      otherCount: Math.max(0, analyzed.length - keptFiles.length),
      fileEdges: internalEdges.length,
    },
  };

  const sorted = sortFindings(findings);
  const counts = countFindings(sorted);
  const metrics = {
    files: analyzed.length,
    loc: totalLoc,
    functions: functions.length,
    largestFile: { path: largestFile.path, loc: largestFile.loc },
    complexity: totalComplexity,
    duplicateWindows: duplicateGroups.length,
    todoCount,
    exports: exportsTotal,
    imports: importRecords.length,
    averageComplexity: round2(totalComplexity / Math.max(1, functions.length)),
    fileEdges: internalEdges.length,
    cycles: cycles.length,
    skippedFiles: reader.failures.size,
  };
  const topRules = countByRule(sorted);
  const notes = [];
  notes.push(`${analyzed.length} 个文件 / ${totalLoc} 行，${functions.length} 个函数，圈复杂度合计 ${totalComplexity}（均值 ${metrics.averageComplexity}）。`);
  notes.push(`最大文件 ${largestFile.path || '—'}（${largestFile.loc} 行）；重复窗口 ${duplicateGroups.length} 组。`);
  if (counts.high) notes.push(`${counts.high} 个高严重度问题：${topRules.filter((item) => ['module.empty-catch', 'module.hardcoded-secret', 'module.dangerous-eval'].includes(item.rule)).map((item) => item.rule).join('、') || '见 findings'}。`);
  else notes.push('未命中空 catch / 硬编码密钥 / eval 等高危规则。');
  if (todoCount || metrics.files) notes.push(`TODO/FIXME/HACK ${todoCount} 处，调试残留与类型逃逸按文件聚合，建议清理后再合并。`);
  if (reader.failures.size) notes.push(`${reader.failures.size} 个文件读取失败或超限（${[...reader.failures.keys()].slice(0, 3).join('、')}）。`);
  notes.push(`文件依赖图保留 ${keptFiles.length}/${analyzed.length} 个节点，${internalEdges.length} 条内部 import 边。`);
  const headline = findings.length
    ? `模块 ${trimText(moduleLabel, 16)}：${analyzed.length} 文件，${findings.length} 个问题（${counts.high} 高）`
    : `模块 ${trimText(moduleLabel, 16)}：${analyzed.length} 文件 / ${totalLoc} 行，未发现问题`;
  log.success(`模块分析完成，耗时 ${Date.now() - startedAt}ms`);

  return {
    findings: sorted,
    metrics,
    graph,
    summary: {
      headline: trimText(headline, 40),
      notes: notes.slice(0, 6),
      stats: {
        files: analyzed.length,
        loc: totalLoc,
        functions: functions.length,
        complexity: totalComplexity,
        duplicateWindows: duplicateGroups.length,
        findings: counts,
      },
      errors: [...reader.failures.entries()].slice(0, 10).map(([path, message]) => `${path}: ${message}`),
    },
    activity: log.finish([
      '解析模块内文件与函数结构',
      '统计复杂度与重复代码窗口',
      '执行模块级代码质量规则',
      '构建模块内部文件依赖图',
    ]),
  };
}

// ---------------------------------------------------------------------------
// Information-flow analysis
// ---------------------------------------------------------------------------

/** Named imports per file, so a handler body can be traced to other modules. */
function parseBindings(path, content, lang) {
  const out = [];
  const push = (spec, local, imported) => {
    const value = String(spec ?? '').trim();
    const name = String(local ?? '').trim();
    if (!value || !name) return;
    out.push({ spec: value, local: name, imported: String(imported ?? name).trim(), file: null });
  };
  if (lang === 'js' || lang === 'ts') {
    for (const match of content.matchAll(/\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
      const clause = match[1].trim();
      const spec = match[2];
      const defaultMatch = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
      if (defaultMatch) push(spec, defaultMatch[1], 'default');
      const namespaceMatch = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
      if (namespaceMatch) push(spec, namespaceMatch[1], '*');
      const named = /\{([^}]*)\}/.exec(clause);
      if (named) {
        for (const part of named[1].split(',')) {
          const [importedRaw, localRaw] = part.trim().split(/\s+as\s+/);
          const imported = importedRaw?.trim();
          const local = (localRaw ?? imported)?.trim();
          if (imported && local) push(spec, local, imported);
        }
      }
    }
    for (const match of content.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      push(match[2], match[1], 'default');
    }
    for (const match of content.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s*:\s*/)[0].trim();
        if (name) push(match[2], name, name);
      }
    }
    return out;
  }
  if (lang === 'py') {
    for (const match of content.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+([^\n#;]+)/gm)) {
      for (const part of match[2].replace(/[()]/g, '').split(',')) {
        const [importedRaw, localRaw] = part.trim().split(/\s+as\s+/);
        if (importedRaw) push(match[1], (localRaw ?? importedRaw).trim(), importedRaw.trim());
      }
    }
    for (const match of content.matchAll(/^[ \t]*import[ \t]+([^\n#;]+)/gm)) {
      for (const token of match[1].split(',')) {
        const [specRaw, aliasRaw] = token.trim().split(/\s+as\s+/);
        if (!specRaw) continue;
        const local = aliasRaw?.trim() ?? specRaw.split('.')[0];
        push(specRaw, local, specRaw);
      }
    }
    return out;
  }
  if (lang === 'go') {
    const importLines = [];
    for (const match of content.matchAll(/^[ \t]*import[ \t]+(?:([\w.]+)\s+)?"([^"\n]+)"/gm)) {
      importLines.push({ alias: match[1], spec: match[2] });
    }
    for (const match of content.matchAll(/^[ \t]*import[ \t]*\(([\s\S]*?)^[ \t]*\)/gm)) {
      for (const line of match[1].split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        const parsed = /^(?:([\w.]+)\s+)?"([^"]+)"/.exec(trimmed);
        if (parsed) importLines.push({ alias: parsed[1], spec: parsed[2] });
      }
    }
    for (const item of importLines) {
      if (item.alias === '_' || item.alias === '.') continue;
      const name = item.alias || baseOf(item.spec);
      push(item.spec, name, name);
    }
    return out;
  }
  if (lang === 'java' || lang === 'kotlin') {
    for (const match of content.matchAll(/^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)(?:\.\*)?/gm)) {
      const parts = match[1].split('.');
      push(match[1], parts[parts.length - 1], parts[parts.length - 1]);
    }
    return out;
  }
  if (lang === 'rust') {
    for (const match of content.matchAll(/^[ \t]*(?:pub[ \t]+)?use[ \t]+([\w:]+)/gm)) {
      const spec = match[1].replace(/::$/, '');
      const parts = spec.split('::');
      push(spec, parts[parts.length - 1], parts[parts.length - 1]);
    }
    return out;
  }
  if (lang === 'php') {
    for (const match of content.matchAll(/^[ \t]*use[ \t]+([\\\w]+)/gm)) {
      const parts = match[1].split('\\');
      push(match[1], parts[parts.length - 1], parts[parts.length - 1]);
    }
    return out;
  }
  return out;
}

function extractEntryBody(content, startIndex, lang) {
  if (lang === 'py' || lang === 'ruby') {
    const defMatch = /^([ \t]*)(?:async\s+)?(?:def|class)\s+\w+/m;
    const rest = content.slice(startIndex, Math.min(content.length, startIndex + 600));
    const def = defMatch.exec(rest);
    if (def) {
      const defIndex = startIndex + def.index;
      const span = indentSpan(content, defIndex, def[1].length);
      return { text: span.text.slice(0, 12000), start: defIndex };
    }
    return { text: content.slice(startIndex, startIndex + 1200), start: startIndex };
  }
  const brace = content.indexOf('{', startIndex);
  if (brace >= 0 && brace - startIndex < 600) {
    const end = matchBrace(content, brace);
    if (end > brace) return { text: content.slice(brace, Math.min(end + 1, brace + 12000)), start: brace };
  }
  return { text: content.slice(startIndex, startIndex + 600), start: startIndex };
}

function detectEntries(file) {
  const { path: filePath, content, language: lang } = file;
  const entries = [];
  const lineAt = createLineAt(content);
  const add = (kind, name, index) => {
    const clean = trimText(String(name ?? '').replace(/\s+/g, ' ').trim(), 80);
    if (!clean) return;
    entries.push({ kind, name: clean, file: filePath, line: lineAt(index), index, language: lang });
  };
  if (lang === 'js' || lang === 'ts') {
    for (const match of content.matchAll(/\b(?:app|router|server|api|route|fastify)\s*\.\s*(get|post|put|patch|delete|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      add('http', `${match[1].toUpperCase()} ${match[2]}`, match.index);
    }
    for (const match of content.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?function\s+(handler|GET|POST|PUT|PATCH|DELETE)\b/g)) {
      add('http', `${match[1]} handler`, match.index);
    }
    for (const match of content.matchAll(/\bexport\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*(?:async\s*)?\(/g)) {
      add('http', `${match[1]} route handler`, match.index);
    }
    if (/(?:feishu|lark|event_type|im\.message|dingtalk|wecom|slack)/i.test(content)) {
      for (const match of content.matchAll(/\b[\w$.]+\s*\.\s*on\s*\(\s*['"]([^'"]+)['"]/g)) {
        add('event', match[1], match.index);
      }
      for (const match of content.matchAll(/\bevent_type\s*[:=]\s*['"]([^'"]+)['"]/g)) {
        add('event', match[1], match.index);
      }
    }
    if (isUiFile(filePath, content)) {
      for (const match of content.matchAll(/\bfetch\s*\(\s*[`'"]([^`'"]*)[`'"]/g)) {
        add('frontend', `fetch ${match[1]}`, match.index);
      }
      for (const match of content.matchAll(/\baxios\s*\.\s*(get|post|put|patch|delete)\s*\(\s*[`'"]([^`'"]*)[`'"]/g)) {
        add('frontend', `axios ${match[1]} ${match[2]}`, match.index);
      }
      for (const match of content.matchAll(/\buseSWR\s*\(\s*[`'"]([^`'"]*)[`'"]/g)) {
        add('frontend', `useSWR ${match[1]}`, match.index);
      }
    }
    return entries;
  }
  if (lang === 'py') {
    for (const match of content.matchAll(/@(?:app|router|bp|api|blueprint)\s*\.\s*(get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)/g)) {
      add('http', `${match[1].toUpperCase()} ${match[2]}`, match.index);
    }
    for (const match of content.matchAll(/^if\s+__name__\s*==\s*['"]__main__['"]\s*:/gm)) {
      add('cli', 'python __main__', match.index);
    }
    return entries;
  }
  if (lang === 'go') {
    for (const match of content.matchAll(/(?:http\.)?HandleFunc\s*\(\s*['"]([^'"]+)['"]/g)) {
      add('http', match[1], match.index);
    }
    for (const match of content.matchAll(/\b[\w.]+\s*\.\s*(GET|POST|PUT|PATCH|DELETE)\s*\(\s*['"]([^'"]+)['"]/g)) {
      add('http', `${match[1]} ${match[2]}`, match.index);
    }
    return entries;
  }
  if (lang === 'java' || lang === 'kotlin') {
    for (const match of content.matchAll(/@(Get|Post|Put|Patch|Delete|Request)Mapping\s*(?:\(\s*(?:value\s*=\s*)?['"]([^'"]*)['"]\s*)?/g)) {
      const route = match[2] ? `${match[1]} ${match[2]}` : `${match[1]}Mapping`;
      add('http', route, match.index);
    }
    return entries;
  }
  if (lang === 'php') {
    for (const match of content.matchAll(/\bRoute\s*::\s*(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g)) {
      add('http', `${match[1].toUpperCase()} ${match[2]}`, match.index);
    }
    return entries;
  }
  if (lang === 'ruby') {
    for (const match of content.matchAll(/^[ \t]*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gm)) {
      add('http', `${match[1].toUpperCase()} ${match[2]}`, match.index);
    }
    return entries;
  }
  return entries;
}

function extractCalls(text) {
  const out = [];
  const seen = new Set();
  for (const match of text.matchAll(/(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const receiver = match[1] ?? '';
    const symbol = match[2] ?? '';
    if (!symbol) continue;
    const key = `${receiver}:${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ receiver, symbol, index: match.index });
  }
  return out;
}

/** SQL / ORM / Redis / queue / external HTTP accesses, line by line. */
function scanData(file) {
  const content = String(file.content ?? '');
  const items = [];
  const seen = new Set();
  const lines = content.split('\n');
  const push = (kind, mode, name, lineIndex, external) => {
    const key = `${kind}:${mode}:${lineIndex}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      kind,
      mode,
      name: trimText(String(name ?? '').trim(), 100),
      file: file.path,
      line: lineIndex + 1,
      external: Boolean(external),
    });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#') || trimmed.startsWith('/*')) continue;
    const sqlMatch = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|CREATE\s+TABLE)\b/i.exec(line);
    if (sqlMatch && (/['"`]/.test(line) || /\b(?:FROM|INTO|WHERE|SET|VALUES)\b/i.test(line))) {
      push('sql', /^select/i.test(sqlMatch[1]) ? 'read' : 'write', line, index, false);
      continue;
    }
    if (/\b(?:prisma|db|database|repo|repository|model|sequelize|mongoose|typeorm|knex|drizzle|session|tx|trx)\b[\w\s.$]{0,48}\.(?:create|insert|insertOne|insertMany|update|updateOne|updateMany|upsert|delete|deleteOne|deleteMany|save|remove)\s*\(/i.test(line)) {
      push('orm', 'write', line, index, false);
      continue;
    }
    if (/\b(?:prisma|db|database|repo|repository|model|sequelize|mongoose|typeorm|knex|drizzle|session|tx|trx)\b[\w\s.$]{0,48}\.(?:find|findOne|findAll|findMany|findUnique|findById|select|query|aggregate|get)\s*\(/i.test(line)) {
      push('orm', 'read', line, index, false);
      continue;
    }
    if (/\b(?:redis|ioredis|createClient)\b/i.test(line)) {
      push('redis', /\b(?:set|hset|lpush|sadd|del|expire|incr)\b/i.test(line) ? 'write' : 'read', line, index, false);
      continue;
    }
    if (/\b(?:kafka|rabbitmq|amqp|sqs|bullmq|sendToQueue|producer\.send|publish|enqueue)\b/i.test(line)) {
      push('queue', 'emit', line, index, false);
      continue;
    }
    if (/\bfetch\s*\(|\baxios\s*\.\s*\w+\s*\(|\bgot\s*\(|\brequests\s*\.\s*(?:get|post|put|delete)\s*\(|\bhttpx\s*\.\w+\s*\(|\bhttp\s*\.\s*(?:Get|Post|Do)\s*\(|\bsuperagent\b|\bky\s*\(/i.test(line)) {
      const urlMatch = /['"`](https?:\/\/[^'"`\s]+)['"`]/.exec(line);
      push('http', 'http', urlMatch ? urlMatch[1] : line, index, true);
    }
  }
  return items;
}

const AUTH_PATTERN = /(?:\bauthenticate\b|\bauthMiddleware\b|\bverifyToken\b|\brequireAuth\b|\brequireUser\b|\bisAuthenticated\b|\bpassport\b|\bjwt\.verify\b|\bgetSession\b|\bcheckPermission\b|\bhasRole\b|\brole\s*[:=]\s*['"]|\bmiddleware\s*\(\s*(?:auth|jwt|session)|@PreAuthorize|@Secured|@RolesAllowed|\bcurrentUser\b|\bloginRequired\b|\b鉴权\b|\b登录态\b|\b权限校验\b)/i;
const VALIDATION_PATTERN = /\b(?:validate|validator|joi|zod|yup|ajv|class-validator|express-validator|checkSchema|isEmail|notEmpty|isEmpty|schema\.(?:parse|safeParse|validate)|pydantic|BaseModel|serializer|binding|ShouldBind|@Valid|@Validated|required|must\s+be|assert)\b/i;
const TRANSACTION_PATTERN = /\b(?:transaction|begin(?:Transaction)?|commit|rollback|atomic|idempoten\w*|upsert|on\s+conflict|findOrCreate|updateOrCreate|transact)\b/i;
const TIMEOUT_PATTERN = /\b(?:timeout|AbortController|abortSignal|signal\s*:|retry|retries|backoff|maxAttempts)\b/i;
const SENSITIVE_PATTERN = /(?:token|password|passwd|secret|authorization|api[_-]?key|id_?card|身份证|手机号|phone|email|credential|cookie)/i;

export async function analyzeFlow({ project, files, readFile } = {}) {
  const startedAt = Date.now();
  const log = makeLog();
  const projectName = projectNameOf(project);
  const normalized = normalizeFileInput(files);
  let candidates = normalized;
  if (!candidates.length && project?.path) {
    const walked = await walkSourceFiles(project.path);
    candidates = walked.map((path) => ({ path, loc: null, content: null }));
  }
  log.info(`载入项目 ${projectName}：${candidates.length} 个候选文件`);

  const reader = createReader({ project, readFile });
  const loaded = await mapLimit(candidates, 8, async (file) => {
    const content = await reader.read(file.path, file.content);
    return {
      path: file.path,
      language: languageOf(file.path),
      loc: file.loc != null ? file.loc : countLines(content),
      content,
    };
  });
  const analyzed = loaded.filter((file) => typeof file.content === 'string' && file.language);
  const byPath = new Map(analyzed.map((file) => [file.path, file]));
  const index = buildIndex(analyzed.map((file) => file.path));
  log.info(`读取 ${analyzed.length} 个源文件内容`);

  const bindingsByPath = new Map();
  const functionsByPath = new Map();
  for (const file of analyzed) {
    const bindings = parseBindings(file.path, file.content, file.language).map((item) => ({
      ...item,
      resolved: resolveImport(file.path, { spec: item.spec, kind: 'import' }, index),
    }));
    bindingsByPath.set(file.path, bindings);
    functionsByPath.set(file.path, extractFunctions(file.path, file.content, file.language));
  }

  const entries = [];
  const entryKeys = new Set();
  for (const file of analyzed) {
    for (const entry of detectEntries(file)) {
      const key = `${entry.kind}|${entry.file}|${entry.line}|${entry.name}`;
      if (entryKeys.has(key)) continue;
      entryKeys.add(key);
      entries.push(entry);
    }
  }
  log.info(`识别 ${entries.length} 个入口（路由 / 事件 / CLI / 前端请求）`);

  const nodeMap = new Map();
  const edgeMap = new Map();
  const addNode = (node) => {
    if (!nodeMap.has(node.id)) nodeMap.set(node.id, node);
    return node.id;
  };
  const addEdge = (from, to, kind, count = 1) => {
    if (!from || !to || from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    const edge = edgeMap.get(key);
    if (edge) edge.count += count;
    else edgeMap.set(key, { from, to, kind, count });
  };

  const findings = [];
  const findingKeys = new Set();
  const addFinding = (input) => {
    const item = finding({ ...input, source: 'structural' });
    const key = `${item.rule}|${item.path}|${item.startLine}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push(item);
  };

  const flows = [];
  const modeCounts = { read: 0, write: 0, emit: 0, http: 0 };
  for (const entry of entries.slice(0, 40)) {
    const entryFile = byPath.get(entry.file);
    if (!entryFile) continue;
    const captured = extractEntryBody(entryFile.content, entry.index, entry.language);
    const entryLineAt = createLineAt(entryFile.content);
    const calls = extractCalls(captured.text);
    const bindings = bindingsByPath.get(entry.file) ?? [];
    const localFunctions = functionsByPath.get(entry.file) ?? [];
    const services = [];
    const secondary = [];
    const addService = (file, label, line) => {
      if (!file || file === entry.file) return;
      if (services.some((item) => item.file === file)) return;
      if (services.length >= 4) return;
      services.push({ file, label: trimText(label, 40), line });
    };
    for (const call of calls) {
      if (BUILTIN_CALLS.has(call.symbol)) continue;
      let binding = bindings.find((item) => item.local === call.symbol);
      if (!binding && call.receiver) binding = bindings.find((item) => item.local === call.receiver);
      if (binding?.resolved) {
        const line = entryLineAt(captured.start + call.index);
        addService(binding.resolved, `${call.symbol}()`, line);
      } else if (localFunctions.some((fn) => fn.name === call.symbol)) {
        // Local helper: part of the entry file, its data access is scanned there.
        continue;
      }
      if (services.length >= 4) break;
    }
    for (const binding of bindings) {
      if (services.length >= 4) break;
      if (binding.resolved && binding.resolved !== entry.file && isServicePath(binding.resolved)
        && new RegExp(`\\b${binding.local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(captured.text)) {
        addService(binding.resolved, binding.local, entry.line);
      }
    }
    // One more hop: data access often lives in a client/repository imported by
    // the service (e.g. orderService -> client/upstream.js).
    for (const service of services.slice()) {
      const serviceBindings = bindingsByPath.get(service.file) ?? [];
      for (const binding of serviceBindings) {
        if (secondary.length >= 3) break;
        if (!binding.resolved) continue;
        if (binding.resolved === entry.file) continue;
        if (services.some((item) => item.file === binding.resolved)) continue;
        if (secondary.some((item) => item.file === binding.resolved)) continue;
        secondary.push({ file: binding.resolved, label: binding.local, via: service.file });
      }
    }

    const entryId = `entry:${hash(`${entry.file}|${entry.line}|${entry.name}`, 10)}`;
    addNode({
      id: entryId,
      label: entry.name,
      kind: 'entry',
      path: entry.file,
      files: 1,
      loc: entryFile.loc,
      risk: 'low',
      entryFiles: [entry.file],
      meta: { entryKind: entry.kind, language: entry.language, line: entry.line },
    });
    for (const service of services) {
      const file = byPath.get(service.file);
      const id = addNode({
        id: `svc:${service.file}`,
        label: service.label || baseOf(service.file),
        kind: 'service',
        path: service.file,
        files: 1,
        loc: file?.loc ?? 0,
        risk: 'low',
        entryFiles: isEntryFile(service.file) ? [service.file] : [],
        meta: { language: file?.language ?? '', line: service.line },
      });
      addEdge(entryId, id, 'call');
    }
    for (const item of secondary) {
      const file = byPath.get(item.file);
      const id = addNode({
        id: `svc:${item.file}`,
        label: item.label || baseOf(item.file),
        kind: 'service',
        path: item.file,
        files: 1,
        loc: file?.loc ?? 0,
        risk: 'low',
        entryFiles: isEntryFile(item.file) ? [item.file] : [],
        meta: { language: file?.language ?? '', line: 0 },
      });
      const viaId = nodeMap.has(`svc:${item.via}`) ? `svc:${item.via}` : entryId;
      addEdge(viaId, id, 'call');
    }

    const ownerFiles = [];
    const addOwner = (path) => {
      if (path && !ownerFiles.includes(path) && byPath.has(path)) ownerFiles.push(path);
    };
    addOwner(entry.file);
    for (const service of services) addOwner(service.file);
    for (const item of secondary) addOwner(item.file);
    const dataItems = [];
    for (const owner of ownerFiles.slice(0, 10)) {
      const file = byPath.get(owner);
      if (!file) continue;
      for (const item of scanData(file)) {
        dataItems.push(item);
        if (item.kind === 'http') modeCounts.http += 1;
        else if (item.kind === 'queue') modeCounts.emit += 1;
        else if (item.mode === 'write') modeCounts.write += 1;
        else modeCounts.read += 1;
        const dataId = addNode({
          id: `data:${hash(`${item.file}|${item.line}|${item.kind}|${item.mode}`, 10)}`,
          label: trimText(item.name || `${item.kind} 访问`, 48),
          kind: item.external ? 'external' : 'data',
          path: item.file,
          files: 1,
          loc: 0,
          risk: 'low',
          entryFiles: [],
          meta: { dataKind: item.kind, mode: item.mode, line: item.line },
        });
        const ownerId = owner === entry.file ? entryId : `svc:${owner}`;
        const edgeKinds = item.kind === 'queue' ? 'emit' : item.kind === 'http' ? 'http' : item.mode;
        addEdge(ownerId, dataId, edgeKinds);
      }
    }

    const steps = [];
    for (const service of services) {
      steps.push({ kind: 'service', label: service.label || baseOf(service.file), file: service.file, line: service.line });
    }
    for (const item of secondary) {
      steps.push({ kind: 'service', label: item.label || baseOf(item.file), file: item.file, line: 0 });
    }
    const flowData = [];
    const seenData = new Set();
    for (const item of dataItems.slice(0, 8)) {
      const key = `${item.file}|${item.line}|${item.kind}`;
      if (seenData.has(key)) continue;
      seenData.add(key);
      flowData.push({ kind: item.kind, name: trimText(item.name || item.kind, 80), file: item.file, line: item.line });
    }

    const flowId = `flow-${hash(`${entry.file}|${entry.line}|${entry.name}`, 8)}`;
    const flowFiles = [...new Set([
      entry.file,
      ...services.map((item) => item.file),
      ...secondary.map((item) => item.file),
      ...dataItems.map((item) => item.file),
    ])];
    const corpus = flowFiles
      .map((path) => byPath.get(path)?.content ?? '')
      .join('\n');
    const primary = services[0];
    const flow = {
      id: flowId,
      name: `${entry.name}${primary ? ` → ${primary.label}` : ''}`,
      entry: { kind: entry.kind, name: entry.name, file: entry.file, line: entry.line },
      steps,
      data: flowData,
    };
    flows.push(flow);

    // ---- flow-level findings ------------------------------------------
    const moduleName = moduleOfPath(entry.file) || '';
    const isUi = entry.kind === 'frontend';
    if (!isUi) {
      const usesInput = /\b(?:req\.(?:body|query|params)|request\.(?:json|args|form|body)|ctx\.request|params\[|r\.URL\.Query|r\.FormValue|c\.Query|event\.(?:body|message|data)|payload\b|input\b)/.test(captured.text);
      const validates = VALIDATION_PATTERN.test(captured.text)
        || /if\s*\(\s*!\s*(?:req\.(?:body|query|params)|body|input|data|payload)\b/.test(captured.text)
        || /\btypeof\s+\w+\s*(?:!==?|===?)\s*['"]/.test(captured.text);
      if (usesInput && !validates) {
        addFinding({
          severity: 'high',
          category: 'bug',
          path: entry.file,
          startLine: entry.line,
          endLine: entry.line,
          title: '入口缺少参数校验',
          content: `入口 ${entry.name} 直接使用了请求参数但没有校验（无 schema / 类型判断 / 必填检查）。恶意或畸形输入会直接进入业务层，建议在入口处用 zod/joi/express-validator 或显式 if 校验并返回 400。`,
          rule: 'flow.missing-validation',
          module: moduleName,
        });
      }
      if (!AUTH_PATTERN.test(corpus)) {
        addFinding({
          severity: 'medium',
          category: 'security',
          path: entry.file,
          startLine: entry.line,
          endLine: entry.line,
          title: '入口疑似缺少鉴权',
          content: `入口 ${entry.name} 及其调用链里没有发现鉴权/会话/角色校验（auth middleware、JWT 校验、session、permission）。如果该入口不是公开接口，需要在路由层补鉴权并拒绝匿名访问。`,
          rule: 'flow.missing-auth',
          module: moduleName,
        });
      }
    }

    const writeItems = dataItems.filter((item) => item.mode === 'write');
    if (writeItems.length && !TRANSACTION_PATTERN.test(corpus)) {
      const item = writeItems[0];
      addFinding({
        severity: 'high',
        category: 'bug',
        path: item.file,
        startLine: item.line,
        endLine: item.line,
        title: '写路径缺少事务/幂等保护',
        content: `链路 ${entry.name} 在 ${item.file}:${item.line} 写入 ${item.kind.toUpperCase()}，但整条链路没有 transaction / commit / rollback / 幂等键 / upsert。中途失败会留下半完成状态，重复请求会重复写入；建议加事务边界与幂等键。`,
        rule: 'flow.write-without-transaction',
        module: moduleName,
      });
    }
    for (const item of dataItems.filter((entryItem) => entryItem.external).slice(0, 3)) {
      const ownerContent = byPath.get(item.file)?.content ?? '';
      if (!TIMEOUT_PATTERN.test(ownerContent)) {
        addFinding({
          severity: 'medium',
          category: 'performance',
          path: item.file,
          startLine: item.line,
          endLine: item.line,
          title: '外部调用缺少超时/重试',
          content: `${item.file}:${item.line} 的外部 HTTP 调用没有 timeout / AbortController / retry / backoff。下游变慢时会占满连接与事件循环，建议设置超时并配合有限重试或熔断。`,
          rule: 'flow.external-no-timeout',
          module: moduleName,
        });
      }
    }
    for (const file of flowFiles) {
      const content = byPath.get(file)?.content ?? '';
      const lineAt = createLineAt(content);
      for (const match of content.matchAll(/catch\s*(?:\([^)]*\))?\s*\{([^{}]{0,500})\}/g)) {
        if (!isLogOnlyBody(match[1])) continue;
        addFinding({
          severity: 'high',
          category: 'bug',
          path: file,
          startLine: lineAt(match.index),
          endLine: lineAt(match.index),
          title: 'catch 吞掉异常，链路静默失败',
          content: '该 catch 只记录日志或什么都不做，错误不会向上传播：调用方会收到成功响应，链路失败被静默。建议记录上下文后重新抛出，或返回显式错误码并触发补偿。',
          rule: 'flow.swallowed-error',
          module: moduleName,
        });
      }
      for (const match of content.matchAll(/except[^\n:]*:\s*pass\b/g)) {
        addFinding({
          severity: 'high',
          category: 'bug',
          path: file,
          startLine: lineAt(match.index),
          endLine: lineAt(match.index),
          title: 'except: pass 吞掉异常，链路静默失败',
          content: 'except 直接 pass，失败被完全忽略；建议记录上下文并重新抛出或返回明确错误。',
          rule: 'flow.swallowed-error',
          module: moduleName,
        });
      }
      for (const match of content.matchAll(/except[^\n:]*:\s*\n((?:[ \t]+[^\n]*\n?)+)/g)) {
        if (!isLogOnlyBody(match[1])) continue;
        addFinding({
          severity: 'high',
          category: 'bug',
          path: file,
          startLine: lineAt(match.index),
          endLine: lineAt(match.index),
          title: 'except 吞掉异常，链路静默失败',
          content: 'except 只记录日志后继续执行，失败被静默降级；建议重新抛出或返回明确错误状态。',
          rule: 'flow.swallowed-error',
          module: moduleName,
        });
      }
      const logPattern = /(?:console\s*\.\s*(?:log|info|debug|warn)|logger?\s*\.\s*(?:info|debug|warn|log)|print\s*\(|log\.\w+\s*\()/;
      content.split('\n').forEach((line, offset) => {
        if (!logPattern.test(line) || !SENSITIVE_PATTERN.test(line)) return;
        addFinding({
          severity: 'high',
          category: 'security',
          path: file,
          startLine: offset + 1,
          endLine: offset + 1,
          title: '敏感信息写入日志',
          content: '日志里出现了 token / password / authorization 等敏感字段，日志系统通常权限更宽，容易造成凭据泄漏。建议脱敏后再记录，或只记录请求 id。',
          rule: 'flow.sensitive-log',
          module: moduleName,
        });
      });
      for (const match of content.matchAll(/readFileSync|writeFileSync|existsSync|execSync|spawnSync|time\.sleep\s*\(|Thread\.sleep/g)) {
        addFinding({
          severity: 'low',
          category: 'performance',
          path: file,
          startLine: lineAt(match.index),
          endLine: lineAt(match.index),
          title: '同步阻塞调用',
          content: '请求链路中出现同步阻塞调用（*Sync / sleep），会卡住事件循环或工作线程；建议改为异步 API 或放到后台任务。',
          rule: 'flow.sync-blocking',
          module: moduleName,
        });
      }
    }
  }
  log.info(`串联 ${flows.length} 条链路，追踪 ${entries.length} 个入口`);

  // ---- graph risk + size cap --------------------------------------------
  const riskByPath = new Map();
  for (const item of findings) riskByPath.set(item.path, worseRisk(riskByPath.get(item.path), item.severity));
  const riskForNode = (node) => {
    if (node.kind === 'data' || node.kind === 'external') {
      const line = Number(node.meta?.line) || 0;
      const near = findings.filter((item) => item.path === node.path && Math.abs(Number(item.startLine) - line) <= 10);
      if (near.length) return riskOfFindings(near);
      return riskByPath.get(node.path) ?? 'low';
    }
    if (node.kind === 'entry') {
      const line = Number(node.meta?.line) || 0;
      const near = findings.filter((item) => item.path === node.path && Math.abs(Number(item.startLine) - line) <= 3);
      return near.length ? riskOfFindings(near) : 'low';
    }
    return riskByPath.get(node.path) ?? 'low';
  };
  const priority = { entry: 0, service: 1, data: 2, external: 2 };
  const allNodes = [...nodeMap.values()]
    .map((node) => ({ ...node, risk: riskForNode(node) }))
    .sort((a, b) => (priority[a.kind] ?? 3) - (priority[b.kind] ?? 3) || b.loc - a.loc || a.label.localeCompare(b.label));
  const keptNodes = allNodes.slice(0, 40);
  const keptIds = new Set(keptNodes.map((node) => node.id));
  const allEdges = [...edgeMap.values()];
  const edges = allEdges
    .filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to))
    .map((edge) => {
      const target = keptNodes.find((node) => node.id === edge.to);
      const source = keptNodes.find((node) => node.id === edge.from);
      const risk = target?.risk === 'high' || source?.risk === 'high'
        ? 'high'
        : edge.kind === 'write' || edge.kind === 'http' ? 'medium' : 'low';
      return { from: edge.from, to: edge.to, kind: edge.kind, count: edge.count, risk };
    });
  const graph = {
    nodes: keptNodes,
    edges,
    cycles: [],
    meta: {
      totalNodes: allNodes.length,
      otherCount: Math.max(0, allNodes.length - keptNodes.length),
      totalEdges: allEdges.length,
      flows: flows.length,
    },
  };

  const sortedFlows = flows
    .map((flow) => ({
      ...flow,
      files: [...new Set([flow.entry.file, ...flow.steps.map((step) => step.file), ...flow.data.map((item) => item.file)])],
    }))
    .sort((a, b) => b.files.length - a.files.length || a.entry.file.localeCompare(b.entry.file))
    .slice(0, MAX_FLOWS)
    .map(({ files: _files, ...rest }) => rest);

  const sorted = sortFindings(findings);
  const counts = countFindings(sorted);
  const byKind = { http: 0, event: 0, cli: 0, frontend: 0 };
  for (const entry of entries) if (byKind[entry.kind] != null) byKind[entry.kind] += 1;
  const serviceFiles = new Set();
  for (const flow of sortedFlows) {
    for (const step of flow.steps) serviceFiles.add(step.file);
  }
  const dataCount = modeCounts;
  const metrics = {
    files: analyzed.length,
    entries: entries.length,
    flows: sortedFlows.length,
    services: serviceFiles.size,
    dataNodes: allNodes.filter((node) => node.kind === 'data').length,
    externalNodes: allNodes.filter((node) => node.kind === 'external').length,
    byKind,
    dataCount,
    findingsByRule: countByRule(sorted),
    skippedFiles: reader.failures.size,
  };

  const notes = [];
  notes.push(`从 ${analyzed.length} 个文件中识别 ${entries.length} 个入口，串联出 ${sortedFlows.length} 条入口→服务→数据链路。`);
  notes.push(`入口构成：HTTP ${byKind.http}、事件 ${byKind.event}、CLI ${byKind.cli}、前端请求 ${byKind.frontend}；服务文件 ${serviceFiles.size} 个。`);
  if (counts.high) notes.push(`${counts.high} 个高风险环节：缺校验 / 缺事务 / 吞异常 / 敏感日志，见 findings 定位。`);
  else notes.push('未命中缺校验、缺事务、吞异常、敏感日志等高危规则。');
  if (dataCount.http) notes.push(`${dataCount.http} 个外部 HTTP 调用点，已检查超时/重试设置。`);
  if (reader.failures.size) notes.push(`${reader.failures.size} 个文件读取失败或超限，链路可能不完整。`);
  notes.push(`依赖图保留 ${keptNodes.length}/${allNodes.length} 个节点，超出部分按 kind 优先级聚合计数。`);
  const headline = sortedFlows.length
    ? `识别 ${sortedFlows.length} 条信息流，${counts.high} 个高风险环节`
    : '未识别到稳定的入口链路，建议检查路由/事件注册方式';
  log.success(`信息流分析完成，耗时 ${Date.now() - startedAt}ms`);

  return {
    findings: sorted,
    flows: sortedFlows,
    metrics,
    graph,
    summary: {
      headline: trimText(headline, 40),
      notes: notes.slice(0, 6),
      stats: {
        files: analyzed.length,
        entries: entries.length,
        flows: sortedFlows.length,
        services: serviceFiles.size,
        data: dataCount,
        findings: counts,
      },
      errors: [...reader.failures.entries()].slice(0, 10).map(([path, message]) => `${path}: ${message}`),
    },
    activity: log.finish([
      '识别入口并抽取处理函数体',
      '追踪入口到服务层调用关系',
      '扫描 SQL / ORM / 缓存 / 队列 / 外部 HTTP',
      '按链路执行安全与可靠性规则',
    ]),
  };
}

// ---------------------------------------------------------------------------
// Diff analysis (added-line heuristics, deterministic)
// ---------------------------------------------------------------------------

function parseUnifiedDiff(diffText) {
  const files = new Map();
  let current = null;
  let hunk = null;
  let newLine = 0;
  let addedLines = 0;
  let removedLines = 0;
  let hunks = 0;
  const ensure = (path) => {
    if (!files.has(path)) files.set(path, { path, added: [], entries: [], hunks: [] });
    current = files.get(path);
  };
  for (const raw of String(diffText ?? '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = null;
      hunk = null;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      let target = raw.slice(4).trim().replace(/^"|"$/g, '');
      if (target.startsWith('b/')) target = target.slice(2);
      if (!target || target === '/dev/null') {
        current = null;
        continue;
      }
      ensure(target);
      hunk = null;
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    if (raw.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (match && current) {
        newLine = Number(match[3]);
        hunks += 1;
        hunk = { start: newLine, added: 0 };
        current.hunks.push(hunk);
      }
      continue;
    }
    if (!current || !hunk) continue;
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) {
      const text = raw.slice(1);
      current.added.push({ line: newLine, text });
      current.entries.push({ kind: 'added', line: newLine, text });
      hunk.added += 1;
      addedLines += 1;
      newLine += 1;
    } else if (raw.startsWith('-')) {
      current.entries.push({ kind: 'removed', text: raw.slice(1) });
      removedLines += 1;
    } else if (raw.startsWith(' ') || raw === '') {
      current.entries.push({ kind: 'context', line: newLine, text: raw.startsWith(' ') ? raw.slice(1) : '' });
      newLine += 1;
    }
  }
  return { files: [...files.values()], addedLines, removedLines, hunks };
}

function hasTryNearby(entries, index) {
  const from = Math.max(0, index - 6);
  const to = Math.min(entries.length - 1, index + 2);
  for (let cursor = from; cursor <= to; cursor += 1) {
    if (/\btry\b|\bcatch\b/.test(entries[cursor].text)) return true;
  }
  return false;
}

/**
 * One added line -> zero or more heuristic findings. Shared between the patch
 * parser and the "no diffText" fallback so both paths report the same rules.
 */
function diffHeuristicsForLine(path, line, text, context) {
  const out = [];
  const push = (severity, category, rule, title, content) => {
    out.push(finding({
      severity,
      category,
      rule,
      path,
      startLine: line,
      endLine: line,
      title: trimText(title, 120),
      content,
      source: 'structural',
      module: moduleOfPath(path),
    }));
  };
  if (/\bconsole\.(?:log|debug)\s*\(|\bdebugger\b/.test(text)) {
    push('low', 'style', 'diff.debug-leftover', '新增了调试输出', `新增行包含 console.log/debugger：${trimText(text.trim(), 120)}。提交前建议删除，或改用统一 logger。`);
  }
  if (/\b(TODO|FIXME|HACK)\b/.test(text)) {
    push('low', 'maintainability', 'diff.todo', '新增了 TODO/FIXME 标记', `新增行留下待办标记：${trimText(text.trim(), 120)}。建议转成 issue 或在合并前处理。`);
  }
  if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(text)) {
    push('high', 'bug', 'diff.empty-catch', '新增空 catch 块', '新增的 catch 块为空，异常被忽略：调用方无法感知失败。至少记录并重新抛出。');
  }
  if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) {
    push('high', 'security', 'diff.eval', '新增 eval / new Function', '新增行动态执行字符串代码，存在注入风险；建议改用显式映射或安全解析器。');
  }
  for (const match of text.matchAll(SECRET_PATTERN)) {
    if (isPlaceholderSecret(match[2])) continue;
    push('high', 'security', 'diff.hardcoded-secret', '新增疑似硬编码密钥', `新增行写入了疑似凭据（${trimText(match[1] + '=***', 40)}）。改为环境变量/密钥管理，并轮换已提交的值。`);
  }
  if (/(?:===?|!==?)\s*null\b/.test(text)) {
    push('low', 'bug', 'diff.null-compare', 'null 比较需确认 undefined 语义', `新增行使用 ${/!==?/.test(text) ? '!==' : '==='} null 比较。若值可能为 undefined，严格比较会漏判；反向场景下 == null 才能同时覆盖 null/undefined，请按数据来源确认。`);
  }
  if (/\.innerHTML\s*=|dangerouslySetInnerHTML/.test(text)) {
    push('medium', 'security', 'diff.innerhtml', '新增直接 HTML 写入', '新增行把数据写入 innerHTML / dangerouslySetInnerHTML，可能引入 XSS；建议 textContent 或先转义。');
  }
  if (/JSON\.parse\s*\(/.test(text) && context && !context.hasTry) {
    push('medium', 'bug', 'diff.json-parse', 'JSON.parse 未包在 try 中', '新增的 JSON.parse 没有 try/catch，外部输入非法时会抛异常打断流程；建议捕获后返回 400 或降级。');
  }
  return out;
}

export async function analyzeDiff({ project, files, diffText, readFile } = {}) {
  const startedAt = Date.now();
  const log = makeLog();
  const text = String(diffText ?? '');
  const changedFiles = normalizeFileInput(files).map((file) => file.path);
  const findings = [];
  let metrics;
  let errors = [];

  if (text.trim()) {
    const parsed = parseUnifiedDiff(text);
    for (const file of parsed.files) {
      const timerLines = [];
      const hasCleanup = file.entries.some((entry) => (
        (entry.kind === 'added' || entry.kind === 'context')
        && /clearTimeout|clearInterval|\.unsubscribe\s*\(|removeEventListener/.test(entry.text)
      ));
      for (let index = 0; index < file.entries.length; index += 1) {
        const entry = file.entries[index];
        if (entry.kind !== 'added') continue;
        findings.push(...diffHeuristicsForLine(file.path, entry.line, entry.text, {
          hasTry: hasTryNearby(file.entries, index),
        }));
        if (/\bset(?:Timeout|Interval)\s*\(/.test(entry.text)) timerLines.push(entry.line);
      }
      if (timerLines.length && !hasCleanup) {
        findings.push(finding({
          severity: 'low',
          category: 'performance',
          rule: 'diff.timer-leak',
          path: file.path,
          startLine: timerLines[0],
          endLine: timerLines[0],
          title: '新增定时器未见清理',
          content: `新增了 ${timerLines.length} 处 setTimeout/setInterval，但本次改动里没有对应的 clearTimeout/clearInterval。组件卸载或请求结束时会泄漏定时器，建议保存句柄并在清理阶段释放。`,
          source: 'structural',
          module: moduleOfPath(file.path),
        }));
      }
      for (const hunk of file.hunks) {
        if (hunk.added < 40) continue;
        findings.push(finding({
          severity: 'low',
          category: 'maintainability',
          rule: 'diff.large-change',
          path: file.path,
          startLine: hunk.start,
          endLine: hunk.start,
          title: `单个 hunk 新增 ${hunk.added} 行`,
          content: `该 hunk 一次新增 ${hunk.added} 行，评审与回滚成本高，也不利于定位回归。建议按逻辑拆成多个提交或先落骨架再补实现。`,
          source: 'structural',
          module: moduleOfPath(file.path),
        }));
      }
    }
    metrics = {
      files: parsed.files.length,
      hunks: parsed.hunks,
      addedLines: parsed.addedLines,
      removedLines: parsed.removedLines,
      mode: 'patch',
    };
    log.info(`解析 git diff：${parsed.files.length} 个文件 / ${parsed.hunks} 个 hunk`);
    log.info(`扫描新增行 ${parsed.addedLines} 行、删除行 ${parsed.removedLines} 行`);
  } else {
    // No patch available (e.g. re-run on a saved file list): lightweight scan.
    const reader = createReader({ project, readFile });
    const loaded = await mapLimit(changedFiles, 8, async (path) => ({
      path,
      content: await reader.read(path),
    }));
    const readable = loaded.filter((file) => typeof file.content === 'string');
    for (const file of readable) {
      const lines = file.content.split('\n');
      const timerLines = [];
      const hasCleanup = /clearTimeout|clearInterval|\.unsubscribe\s*\(|removeEventListener/.test(file.content);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmed = line.trim();
        if (!trimmed) continue;
        findings.push(...diffHeuristicsForLine(file.path, index + 1, line, {
          hasTry: lines.slice(Math.max(0, index - 4), index + 2).some((nearby) => /\btry\b|\bcatch\b/.test(nearby)),
        }));
        if (/\bset(?:Timeout|Interval)\s*\(/.test(line)) timerLines.push(index + 1);
      }
      if (timerLines.length && !hasCleanup) {
        findings.push(finding({
          severity: 'low',
          category: 'performance',
          rule: 'diff.timer-leak',
          path: file.path,
          startLine: timerLines[0],
          endLine: timerLines[0],
          title: '定时器未见清理',
          content: '文件中设置了 setTimeout/setInterval 但没有 clearTimeout/clearInterval，存在句柄泄漏风险。',
          source: 'structural',
          module: moduleOfPath(file.path),
        }));
      }
    }
    metrics = {
      files: readable.length,
      hunks: 0,
      addedLines: 0,
      removedLines: 0,
      mode: 'fallback',
    };
    log.info(`未收到 diff 文本，改为轻量检查 ${readable.length} 个改动文件`);
    if (reader.failures.size) log.warn(`${reader.failures.size} 个改动文件读取失败`);
    errors = [...reader.failures.entries()].slice(0, 10).map(([path, message]) => `${path}: ${message}`);
  }

  // Deduplicate identical rule+location (a rule may be produced twice by
  // overlapping heuristics, e.g. secret + generic line scan).
  const seen = new Set();
  const unique = [];
  for (const item of findings) {
    const key = `${item.rule}|${item.path}|${item.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  const sorted = sortFindings(unique);
  const counts = countFindings(sorted);
  const rules = countByRule(sorted);
  log.info(`执行 ${rules.length || 11} 类确定性启发式规则，命中 ${sorted.length} 个问题`);
  log.info('覆盖规则：调试残留 / TODO / 空 catch / eval / 硬编码密钥 / null 比较 / JSON.parse / innerHTML / 定时器 / 大改动');
  log.success(`改动分析完成，耗时 ${Date.now() - startedAt}ms`);

  const notes = [];
  notes.push(`共分析 ${metrics.files} 个改动文件，新增 ${metrics.addedLines} 行、删除 ${metrics.removedLines} 行（模式：${metrics.mode === 'patch' ? 'git diff' : '文件回退'}）。`);
  if (rules.length) notes.push(`命中规则：${rules.slice(0, 4).map((item) => `${item.rule}×${item.count}`).join('、')}。`);
  if (counts.high) notes.push(`${counts.high} 个高严重度问题（空 catch / eval / 硬编码密钥），建议合并前修复。`);
  else notes.push('未命中空 catch / eval / 硬编码密钥等高危规则。');
  if (counts.medium) notes.push(`${counts.medium} 个中严重度问题：JSON.parse 未防护、innerHTML、外部调用等。`);
  if (!text.trim()) notes.push('未收到 diffText，结论基于文件全文，不能区分新增与既有代码。');
  notes.push('以上为确定性启发式结果，仅覆盖可文本判定的模式，最终以 OCR/AI 评审为准。');
  const headline = sorted.length
    ? `新增 ${metrics.addedLines || metrics.files} 行，命中 ${sorted.length} 条问题`
    : '本次改动未命中确定性启发式规则';

  return {
    findings: sorted,
    metrics: {
      ...metrics,
      findings: counts,
      rules,
    },
    graph: null,
    summary: {
      headline: trimText(headline, 40),
      notes: notes.slice(0, 6),
      stats: {
        files: metrics.files,
        hunks: metrics.hunks,
        addedLines: metrics.addedLines,
        removedLines: metrics.removedLines,
        findings: counts,
      },
      errors,
    },
    activity: log.finish([
      '解析 diff 头部与 hunk',
      '逐行扫描新增代码',
      '执行确定性启发式规则',
      '汇总改动风险',
    ]),
  };
}

