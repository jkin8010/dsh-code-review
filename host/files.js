import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/** Filesystem helpers shared by the job engine and the snapshot builder. */

export const EXCLUDE_HEAVY = [
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  'vendor', 'target', '__pycache__', '.venv', 'venv', 'Pods', '.idea', '.cache',
];

export const SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.go', '.java', '.kt', '.kts', '.cs', '.rs', '.php', '.rb', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.scala', '.clj', '.ex', '.exs', '.dart',
  '.sh', '.ps1', '.sql', '.proto', '.graphql',
]);

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_SCAN_FILES = 6000;
/** Directory depth walked below `repoPath`; deep enough for real trees, bounded for monorepos. */
export const MAX_SCAN_DEPTH = 12;
/** Concurrent directory reads while walking; keeps a cold cache from serializing the scan. */
export const MAX_SCAN_CONCURRENCY = 8;

/**
 * Resolve `path` against `repoPath` and refuse anything outside it: reviewers
 * must never read `~/.ssh/id_rsa` because the model hallucinated an absolute
 * path, or because `@../../x` was passed as the project.
 */
export function withinRepo(repoPath, path) {
  const requested = String(path ?? '');
  if (!requested) return '';
  const base = resolve(String(repoPath ?? ''));
  const absolute = resolve(isAbsolute(requested) ? requested : join(base, requested));
  const rel = relative(base, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) return '';
  return absolute;
}

/** Read one project file as UTF-8, capped so a giant generated file cannot stall a review. */
export async function readProjectFile(repoPath, path) {
  const absolute = withinRepo(repoPath, path);
  if (!absolute) return null;
  try {
    const info = await stat(absolute);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(absolute, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Walk source files under `repoPath` (optionally only under `subPaths`).
 * Skips dependency/build/vendor directories and binary extensions; the limit is
 * a hard stop so an accidental scan of a monorepo cannot freeze the Host.
 * Subdirectories are visited concurrently (bounded) and the result is sorted so
 * repeated reviews of the same tree see a stable file order.
 */
export async function walkSourceFiles(repoPath, {
  limit = MAX_SCAN_FILES, subPaths = [], maxDepth = MAX_SCAN_DEPTH, concurrency = MAX_SCAN_CONCURRENCY,
} = {}) {
  const results = [];
  const roots = subPaths.length
    ? subPaths.map((path) => withinRepo(repoPath, path)).filter((path) => path && existsSync(path))
    : [repoPath];

  const visit = async (directory, depth) => {
    if (results.length >= limit || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const directories = [];
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (EXCLUDE_HEAVY.includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(absolute);
      } else if (entry.isFile() && SOURCE_EXT.has(extname(entry.name).toLowerCase())) {
        results.push(relative(repoPath, absolute).replace(/\\/g, '/'));
      }
    }
    // Bounded fan-out over the subdirectories, `concurrency` at a time.
    for (let start = 0; start < directories.length; start += concurrency) {
      if (results.length >= limit) break;
      await Promise.all(directories.slice(start, start + concurrency).map((child) => visit(child, depth + 1)));
    }
  };

  for (const root of roots) {
    if (results.length >= limit) break;
    try {
      const info = await stat(root);
      if (info.isDirectory()) await visit(root, 0);
      else if (info.isFile() && SOURCE_EXT.has(extname(root).toLowerCase())) {
        results.push(relative(repoPath, root).replace(/\\/g, '/'));
      }
    } catch {
      /* missing module path surfaces in the plan stage */
    }
  }
  return results.sort();
}
