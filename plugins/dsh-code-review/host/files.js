import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
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

/** Read one project file as UTF-8, capped so a giant generated file cannot stall a review. */
export async function readProjectFile(repoPath, path) {
  const requested = String(path ?? '');
  const absolute = isAbsolute(requested) ? requested : join(repoPath, requested);
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
 */
export async function walkSourceFiles(repoPath, { limit = MAX_SCAN_FILES, subPaths = [] } = {}) {
  const results = [];
  const roots = subPaths.length
    ? subPaths.map((path) => join(repoPath, path)).filter((path) => existsSync(path))
    : [repoPath];
  const visit = async (directory, depth) => {
    if (results.length >= limit || depth > 12) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (EXCLUDE_HEAVY.includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
      } else if (entry.isFile() && SOURCE_EXT.has(extname(entry.name).toLowerCase())) {
        results.push(relative(repoPath, absolute).replace(/\\/g, '/'));
      }
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
  return results;
}
