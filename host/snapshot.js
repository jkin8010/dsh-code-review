import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import {
  addDays, atomicWriteJson, countFindings, dateKey, dayList, errorText, hash, maxSeverity,
  moduleOfPath, nowIso, pct, readJsonFile, severityRank, trimText,
} from './shared.js';
import { expandHome, projectId, projectName } from './config.js';
import { readProjectFile, walkSourceFiles, SOURCE_EXT } from './files.js';

const LANGUAGE_BY_EXT = new Map([
  ['.js', 'JavaScript'], ['.mjs', 'JavaScript'], ['.cjs', 'JavaScript'],
  ['.jsx', 'JavaScript'], ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'],
  ['.vue', 'Vue'], ['.svelte', 'Svelte'], ['.py', 'Python'], ['.go', 'Go'],
  ['.java', 'Java'], ['.kt', 'Kotlin'], ['.cs', 'C#'], ['.rs', 'Rust'],
  ['.php', 'PHP'], ['.rb', 'Ruby'], ['.swift', 'Swift'], ['.c', 'C'],
  ['.cc', 'C++'], ['.cpp', 'C++'], ['.h', 'C/C++'], ['.hpp', 'C++'],
  ['.scala', 'Scala'], ['.dart', 'Dart'], ['.sh', 'Shell'], ['.sql', 'SQL'],
]);

/**
 * Non-git directory fallback: the plugin still supports architecture / module /
 * flow reviews there, so the project card must show real files, modules and
 * language instead of an error skeleton.
 */
async function localProjectView(path, days) {
  const files = await walkSourceFiles(path, { limit: 4000 });
  const languages = new Map();
  const modules = new Map();
  let loc = 0;
  let counted = 0;
  const sample = files.slice(0, 400);
  for (let index = 0; index < sample.length; index += 40) {
    const batch = sample.slice(index, index + 40);
    const contents = await Promise.all(batch.map((file) => readProjectFile(path, file)));
    for (let offset = 0; offset < batch.length; offset += 1) {
      const file = batch[offset];
      const content = contents[offset];
      const extension = extname(file).toLowerCase();
      const language = LANGUAGE_BY_EXT.get(extension);
      if (language) languages.set(language, (languages.get(language) ?? 0) + 1);
      const moduleName = moduleOfPath(file) || 'root';
      const entry = modules.get(moduleName) ?? {
        id: `m-${hash(moduleName, 10)}`, name: moduleName, path: moduleName,
        files: 0, loc: 0, lastCommitAt: null, lastReviewAt: null, reviewCount: 0,
        findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 }, risk: 'low',
      };
      entry.files += 1;
      if (content) {
        const lines = content.split('\n').length;
        entry.loc += lines;
        loc += lines;
        counted += 1;
      }
      modules.set(moduleName, entry);
    }
  }
  const topLanguage = [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const heatmap = emptyHeatmap(days);
  return {
    id: projectId(path),
    name: projectName(path),
    path,
    kind: 'dir',
    branch: '',
    head: '',
    headSubject: '',
    committedAt: null,
    lastCommitAt: null,
    dirty: false,
    remote: '',
    language: topLanguage,
    fileCount: files.length,
    moduleCount: modules.size,
    loc: counted ? loc : null,
    modules: [...modules.values()].sort((a, b) => b.files - a.files).slice(0, 24),
    heatmap,
    lastReviewAt: null,
    reviewCount: 0,
    findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    error: null,
    at: nowIso(),
  };
}

/**
 * Snapshot builder.
 *
 * One JSON document powers the whole Web page. It is rebuilt on every poll from
 * in-memory job state plus caches, so polling never triggers expensive git work:
 * project metadata is cached for minutes, the current project's one-year heatmap
 * for a minute, and OCR health for a minute.
 *
 * `snapshot()` is async because a cold start must inspect projects; `build()` is
 * the synchronous projection used everywhere afterwards.
 */

const PROJECT_TTL = 5 * 60_000;
const CURRENT_TTL = 60_000;
const HEALTH_TTL = 60_000;
const GRAPH_TTL = 10 * 60_000;
const WORKSPACE_TTL = 60_000;
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const SKIP_SCAN_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.next', '.nuxt',
  'vendor', 'target', '__pycache__', '.venv', 'venv', 'Pods', '.idea', '.cache',
  '.pnpm-store', '.dsh-market', '.plugin-manager',
]);

/**
 * Discover repositories under the configured roots to `depth` levels.
 * Reviewing arbitrary workspaces means the plugin must also find repos nested
 * one level below a group directory (for example `<workspace>/qise-tech/repo`).
 */
async function scanRepos(roots, depth = 2, limit = 40) {
  const found = [];
  const queue = (roots ?? []).map((root) => [root, 0]);
  const seen = new Set();
  while (queue.length && found.length < limit && seen.size < limit * 8) {
    const [dir, level] = queue.shift();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    if (existsSync(join(dir, '.git'))) {
      found.push(dir);
      continue;
    }
    if (level >= depth) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_SCAN_DIRS.has(entry.name)) continue;
      queue.push([join(dir, entry.name), level + 1]);
    }
  }
  return found;
}

const PUBLIC_JOB_FIELDS = [
  'id', 'seq', 'projectId', 'projectName', 'projectPath', 'projectKind', 'type',
  'title', 'subtitle', 'scope', 'engine', 'engineDetail', 'options', 'status',
  'stage', 'progress', 'createdAt', 'startedAt', 'finishedAt', 'durationMs',
  'counts', 'stages', 'error', 'plan', 'summary', 'artifacts', 'message', 'resolvedCount',
  'fixAt', 'fixSessionId', 'fixVerifiedAt', 'recheckJobId', 'lastRecheckAt',
];

export function publicJob(job, { activity = 0 } = {}) {
  const view = {};
  for (const field of PUBLIC_JOB_FIELDS) {
    if (job[field] !== undefined) view[field] = job[field];
  }
  view.activity = Array.isArray(job.activity)
    ? (activity > 0 ? job.activity.slice(-activity) : [])
    : [];
  return view;
}

function emptyHeatmap(days = 365) {
  const to = dateKey();
  const from = addDays(to, -(days - 1));
  const list = dayList(from, to).map((date) => ({ date, commits: 0, insertions: 0, deletions: 0 }));
  return {
    from,
    to,
    days: list,
    spark: list.slice(-90).map((day) => day.commits),
    max: 0,
    totalCommits: 0,
    totalInsertions: 0,
    totalDeletions: 0,
    streaks: { current: 0, longest: 0 },
    busiest: { date: from, commits: 0 },
    activeDays: 0,
  };
}

function mergeHeatmap(project, statsDays, days = 365) {
  const base = project?.heatmap ?? emptyHeatmap(days);
  const byDate = new Map((base.days ?? []).map((day) => [day.date, day]));
  const merged = dayList(base.from, base.to).map((date) => {
    const commit = byDate.get(date) ?? { date, commits: 0, insertions: 0, deletions: 0 };
    const review = statsDays?.[date];
    return {
      date,
      commits: Number(commit.commits ?? 0),
      insertions: Number(commit.insertions ?? 0),
      deletions: Number(commit.deletions ?? 0),
      reviews: Number(review?.reviews ?? 0),
      findings: Number(review?.findings ?? 0),
      critical: Number(review?.critical ?? 0),
    };
  });
  const max = merged.reduce((best, day) => Math.max(best, day.commits), 0);
  const active = merged.filter((day) => day.commits > 0);
  const busiest = merged.reduce((best, day) => (day.commits > best.commits ? day : best), merged[0] ?? { date: base.to, commits: 0 });
  return {
    from: base.from,
    to: base.to,
    days: merged,
    spark: merged.slice(-90).map((day) => day.commits + day.reviews * 3),
    max,
    totalCommits: merged.reduce((sum, day) => sum + day.commits, 0),
    totalInsertions: merged.reduce((sum, day) => sum + day.insertions, 0),
    totalDeletions: merged.reduce((sum, day) => sum + day.deletions, 0),
    totalReviews: merged.reduce((sum, day) => sum + day.reviews, 0),
    totalFindings: merged.reduce((sum, day) => sum + day.findings, 0),
    streaks: base.streaks ?? { current: 0, longest: 0 },
    busiest: { date: busiest.date, commits: busiest.commits },
    activeDays: active.length,
  };
}

function reviewStreak(statsDays, todayKey) {
  let current = 0;
  let cursor = todayKey;
  if (!(statsDays[cursor]?.reviews > 0)) {
    cursor = addDays(cursor, -1);
    if (!(statsDays[cursor]?.reviews > 0)) return 0;
  }
  for (let index = 0; index < 400; index += 1) {
    if (!(statsDays[cursor]?.reviews > 0)) break;
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return current;
}

function jobTopSeverity(counts) {
  for (const severity of ['critical', 'high', 'medium', 'low']) {
    if (Number(counts?.bySeverity?.[severity] ?? 0) > 0) return severity;
  }
  return null;
}

function blankDays(days = 365) {
  const to = dateKey();
  const from = addDays(to, -(days - 1));
  return dayList(from, to).map((date) => ({ date, reviews: 0, findings: 0, critical: 0, files: 0, tokens: 0 }));
}

export function createSnapshot({
  config, store, jobs, git, ocr, analyze, logger, defaultProjectPath, getDelegateStatus,
} = {}) {
  const state = {
    version: 0,
    projects: new Map(),
    order: [],
    currentId: projectId(defaultProjectPath || config.defaultProjectPath),
    projectsAt: 0,
    currentAt: 0,
    healthAt: 0,
    health: {
      ocr: { state: 'unknown', version: null, path: null, error: null, checkedAt: null },
      llm: {
        state: 'unknown', provider: null, model: null, source: 'none', error: null, checkedAt: null,
      },
      git: { state: 'unknown', projects: 0, error: null, checkedAt: null },
      store: { state: store?.status?.().state ?? 'pending', path: store?.status?.().path ?? '', jobs: 0, error: null },
    },
    graph: new Map(),
    refreshing: null,
    builds: 0,
    disposed: false,
  };

  const log = (level, message) => {
    try {
      const sink = logger?.[level] ?? logger?.info;
      sink?.call?.(logger, message);
    } catch {
      /* logging never breaks the page */
    }
  };

  async function inspectOne(path, { days = 90, light = false } = {}) {
    const view = await git.inspectProject({
      repoPath: path,
      heatmapDays: days,
      moduleDepth: light ? 0 : 1,
      light,
    });
    // Non-git directories are first-class review targets for scan-based types;
    // build a real filesystem view instead of surfacing "not a git repository".
    if (!view || view.kind !== 'git') {
      const local = await localProjectView(path, days);
      if (!light) return local;
      return { ...local, loc: null, modules: [] };
    }
    return { ...view, id: view?.id ?? projectId(path), name: view?.name ?? projectName(path), path };
  }

  async function refreshHealth(force = false) {
    const now = Date.now();
    if (!force && now - state.healthAt < HEALTH_TTL) return;
    state.healthAt = now;
    try {
      const probe = await ocr.probe({ config, env: process.env });
      state.health.ocr = {
        state: probe.available ? 'ok' : 'missing',
        version: probe.version ?? null,
        path: probe.path ?? null,
        error: probe.available ? null : (probe.error ?? '未找到 ocr 可执行文件'),
        checkedAt: nowIso(),
      };
    } catch (error) {
      state.health.ocr = { state: 'error', version: null, path: null, error: errorText(error), checkedAt: nowIso() };
    }
    try {
      const llm = await ocr.probeLlm({ config, env: process.env });
      const delegate = typeof getDelegateStatus === 'function'
        ? (getDelegateStatus() ?? { available: false })
        : { available: false };
      if (llm.configured) {
        state.health.llm = {
          state: 'configured',
          provider: llm.provider ?? null,
          model: llm.model ?? null,
          source: llm.source ?? 'config',
          delegateAvailable: Boolean(delegate.available),
          delegateProvider: delegate.provider ?? null,
          delegateModel: delegate.model ?? null,
          error: llm.error ?? null,
          checkedAt: nowIso(),
        };
      } else if (delegate.available) {
        state.health.llm = {
          state: 'delegate',
          provider: delegate.provider ?? null,
          model: delegate.model ?? null,
          source: 'dsh',
          delegateAvailable: true,
          delegateProvider: delegate.provider ?? null,
          delegateModel: delegate.model ?? null,
          error: null,
          checkedAt: nowIso(),
        };
      } else {
        state.health.llm = {
          state: 'unconfigured',
          provider: null,
          model: null,
          source: llm.source ?? 'none',
          delegateAvailable: false,
          delegateProvider: null,
          delegateModel: null,
          error: llm.error ?? delegate.error ?? null,
          checkedAt: nowIso(),
        };
      }
    } catch (error) {
      state.health.llm = {
        state: 'error', provider: null, model: null, source: 'none',
        delegateAvailable: false, delegateProvider: null, delegateModel: null,
        error: errorText(error), checkedAt: nowIso(),
      };
    }
  }

  const addedProjectFile = join(config.stateDir, 'projects.json');
  let addedProjectPaths = null;
  let workspaceCache = { at: 0, paths: [] };

  async function loadAddedProjects() {
    if (addedProjectPaths) return addedProjectPaths;
    const data = readJsonFile(addedProjectFile, null);
    addedProjectPaths = Array.isArray(data?.paths)
      ? data.paths.filter((path) => typeof path === 'string' && path.trim())
      : [];
    return addedProjectPaths;
  }

  async function saveAddedProjects() {
    try {
      await atomicWriteJson(addedProjectFile, { paths: addedProjectPaths ?? [] });
    } catch (error) {
      log('warn', `cannot persist added projects: ${errorText(error)}`);
    }
  }

  /** Workspaces the user opened in DSH are projects too. */
  async function dshWorkspacePaths(force = false) {
    const now = Date.now();
    if (!force && now - workspaceCache.at < WORKSPACE_TTL) return workspaceCache.paths;
    const paths = [];
    try {
      const data = readJsonFile(join(DSH_HOME, 'storages', 'workspace.json'), null);
      const table = data?.tables?.workspaces ?? {};
      for (const record of Object.values(table)) {
        if (typeof record?.path === 'string' && record.path) paths.push(record.path);
      }
    } catch {
      /* a missing workspace store is not fatal */
    }
    workspaceCache = { at: now, paths: paths.slice(0, 80) };
    return workspaceCache.paths;
  }

  function projectActivity(project) {
    return Math.max(
      Date.parse(project?.lastReviewAt ?? '') || 0,
      Date.parse(project?.lastCommitAt ?? project?.committedAt ?? '') || 0,
    );
  }

  async function refreshProjects(force = false) {
    if (state.refreshing && !force) return state.refreshing;
    const now = Date.now();
    if (!force && now - state.projectsAt < PROJECT_TTL && state.order.length) return;
    state.refreshing = (async () => {
      await loadAddedProjects();
      // Union every project source; a review of an ad-hoc project must stay in
      // the picker even when it is outside projectRoots.
      const paths = new Map();
      const addPath = (value) => {
        if (typeof value !== 'string') return;
        const path = value.trim();
        if (!path) return;
        paths.set(path, projectId(path));
      };
      addPath(config.defaultProjectPath);
      for (const path of config.extraProjects ?? []) addPath(path);
      for (const path of addedProjectPaths ?? []) addPath(path);
      for (const path of await dshWorkspacePaths(force)) addPath(path);
      for (const job of jobs.list()) addPath(job.projectPath);
      let discovered = [];
      try {
        discovered = await scanRepos(
          (config.projectRoots ?? []).map((root) => expandHome(root)),
          config.projectDepth ?? 2,
          config.maxProjects ?? 40,
        );
      } catch (error) {
        log('warn', `project discovery failed: ${errorText(error)}`);
      }
      for (const path of discovered) addPath(path);

      const maxProjects = Math.max(1, Math.min(80, Number(config.maxProjects) || 40));
      const reviewed = new Set(jobs.list().map((job) => job.projectPath));
      const added = new Set(addedProjectPaths ?? []);
      const ranked = [...paths.entries()].sort((a, b) => {
        const priority = (path) => (path === config.defaultProjectPath ? 4 : 0)
          + (added.has(path) ? 3 : 0)
          + (reviewed.has(path) ? 2 : 0)
          + (path === state.projects.get(state.currentId)?.path ? 1 : 0);
        return priority(b[0]) - priority(a[0]);
      }).slice(0, maxProjects);

      const currentId = state.currentId;
      const currentPath = [...paths.entries()].find(([, id]) => id === currentId)?.[0]
        ?? config.defaultProjectPath;
      const results = new Map();
      const queue = ranked.map(([path, id]) => [id, path]);
      const workers = 3;
      await Promise.all(Array.from({ length: workers }, async () => {
        while (queue.length) {
          const entry = queue.shift();
          if (!entry) return;
          const [id, path] = entry;
          try {
            const cached = state.projects.get(id);
            const isCurrent = path === currentPath;
            if (cached && !force) {
              if (!isCurrent || cached._full) {
                results.set(id, cached);
                continue;
              }
            }
            const view = await inspectOne(path, {
              days: isCurrent ? config.heatmapDays : 90,
              light: !isCurrent,
            });
            if (isCurrent) {
              view._full = true;
              state.currentAt = Date.now();
            }
            results.set(id, view);
          } catch (error) {
            log('warn', `project inspection failed for ${path}: ${errorText(error)}`);
            results.set(id, {
              id, name: projectName(path), path, kind: 'dir', error: errorText(error),
              heatmap: emptyHeatmap(90), modules: [], at: nowIso(),
            });
          }
        }
      }));

      if (currentPath && results.has(projectId(currentPath)) && !results.has(currentId)) {
        state.currentId = projectId(currentPath);
      }
      state.projects = new Map(results);
      state.order = [...results.keys()].sort((a, b) => {
        const left = state.projects.get(a);
        const right = state.projects.get(b);
        return projectActivity(right) - projectActivity(left);
      });
      if (!state.projects.has(state.currentId) && state.order.length) state.currentId = state.order[0];
      state.projectsAt = Date.now();
      state.health.git = {
        state: state.order.length ? 'ok' : 'degraded',
        projects: state.order.length,
        error: state.order.length ? null : '未发现项目：可在项目页添加项目路径，或检查 projectRoots',
        checkedAt: nowIso(),
      };
      state.version += 1;
    })().finally(() => {
      state.refreshing = null;
    });
    return state.refreshing;
  }

  /** Add a project by absolute path (persisted in `<stateDir>/projects.json`). */
  async function addProjectPath(rawPath) {
    const path = expandHome(String(rawPath ?? '').trim());
    if (!path) throw Object.assign(new Error('请填写项目路径'), { code: 'code-review/bad-request' });
    let info;
    try {
      info = await stat(path);
    } catch {
      throw Object.assign(new Error(`路径不存在：${path}`), { code: 'code-review/not-found' });
    }
    if (!info.isDirectory()) {
      throw Object.assign(new Error(`不是目录：${path}`), { code: 'code-review/bad-request' });
    }
    await loadAddedProjects();
    if (!addedProjectPaths.includes(path)) {
      addedProjectPaths.push(path);
      await saveAddedProjects();
    }
    const id = projectId(path);
    try {
      const view = await inspectOne(path, { days: config.heatmapDays, light: false });
      view._full = true;
      state.projects.set(id, view);
      if (!state.order.includes(id)) state.order.unshift(id);
      state.currentId = id;
      state.currentAt = Date.now();
      state.projectsAt = Date.now();
      state.version += 1;
      return view;
    } catch (error) {
      throw Object.assign(new Error(`无法读取项目 ${path}：${errorText(error)}`), { code: 'code-review/project-failed' });
    }
  }

  async function removeProjectPath(rawPath) {
    const path = expandHome(String(rawPath ?? '').trim());
    await loadAddedProjects();
    addedProjectPaths = addedProjectPaths.filter((item) => item !== path);
    await saveAddedProjects();
    const id = projectId(path);
    const project = state.projects.get(id);
    const reviewed = jobs.list().some((job) => job.projectPath === path);
    if (project && !reviewed && id !== state.currentId) {
      state.projects.delete(id);
      state.order = state.order.filter((item) => item !== id);
    }
    state.projectsAt = 0;
    state.version += 1;
    return true;
  }

  async function refreshCurrent(force = false) {
    const now = Date.now();
    if (!force && now - state.currentAt < CURRENT_TTL) return;
    const project = state.projects.get(state.currentId);
    if (!project?.path) return;
    if (project._full && !force) {
      state.currentAt = now;
      return;
    }
    try {
      const view = await inspectOne(project.path, { days: config.heatmapDays, light: false });
      state.projects.set(state.currentId, { ...view, _full: true });
      state.currentAt = now;
      state.version += 1;
    } catch (error) {
      log('warn', `current project refresh failed: ${errorText(error)}`);
    }
  }

  function reviewAggregates() {
    const list = jobs.list();
    const byProject = new Map();
    const topModules = new Map();
    const summary = {
      reviewsTotal: list.length, reviews7d: 0, reviewsToday: 0, running: 0, queued: 0,
      findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      filesReviewed: 0, tokens: 0, modulesCovered: 0, lastReviewAt: null,
      completed: 0, failed: 0,
    };
    const today = dateKey();
    const weekAgo = Date.now() - 7 * 86400_000;
    const modules = new Set();
    for (const job of list) {
      if (job.status === 'running') summary.running += 1;
      if (job.status === 'queued') summary.queued += 1;
      if (job.status === 'completed') summary.completed += 1;
      if (job.status === 'failed') summary.failed += 1;
      const created = job.createdAt ? new Date(job.createdAt).getTime() : 0;
      if (created >= weekAgo) summary.reviews7d += 1;
      if (dateKey(job.createdAt ?? 0) === today) summary.reviewsToday += 1;
      if (job.status === 'completed' || job.status === 'failed') {
        const finished = job.finishedAt ?? job.createdAt;
        if (finished && (!summary.lastReviewAt || finished > summary.lastReviewAt)) summary.lastReviewAt = finished;
      }
      const counts = job.counts ?? {};
      if (job.status === 'completed') {
        for (const [severity, value] of Object.entries(counts.bySeverity ?? {})) {
          if (severity === 'total' || !(severity in summary.findings)) continue;
          summary.findings[severity] += Number(value) || 0;
        }
        summary.findings.total += Number(counts.findings ?? 0);
        summary.filesReviewed += Number(counts.filesReviewed ?? 0);
        summary.tokens += Number(counts.tokens ?? 0);
      }
      for (const module of job.summary?.modules ?? []) {
        const key = `${job.projectId}\u0000${module}`;
        if (!modules.has(key)) modules.add(key);
        const entry = topModules.get(key) ?? {
          projectId: job.projectId, projectName: job.projectName, module,
          count: 0, findings: 0, lastAt: null, risk: 'low',
        };
        entry.count += 1;
        entry.findings += Number(counts.findings ?? 0);
        const at = job.finishedAt ?? job.createdAt;
        if (at && (!entry.lastAt || at > entry.lastAt)) entry.lastAt = at;
        const top = jobTopSeverity(counts);
        if (top && severityRank(top) <= severityRank(entry.risk)) entry.risk = top;
        topModules.set(key, entry);
      }
      const project = byProject.get(job.projectId) ?? {
        projectId: job.projectId, name: job.projectName, count: 0, findings: 0, lastAt: null,
      };
      project.count += 1;
      project.findings += Number(counts.findings ?? 0);
      const at = job.finishedAt ?? job.createdAt;
      if (at && (!project.lastAt || at > project.lastAt)) project.lastAt = at;
      byProject.set(job.projectId, project);
    }
    summary.modulesCovered = modules.size;
    summary.streakDays = reviewStreak(store.getStats()?.days ?? {}, today);
    const attempts = summary.completed + summary.failed;
    summary.successRate = attempts ? Math.round((summary.completed / attempts) * 100) / 100 : 0;
    return {
      summary,
      byProject: [...byProject.values()].sort((a, b) => b.count - a.count),
      topModules: [...topModules.values()]
        .sort((a, b) => b.count - a.count || severityRank(a.risk) - severityRank(b.risk))
        .slice(0, 16),
    };
  }

  function projectSummaryView(project, review = reviewAggregates()) {
    if (!project) return null;
    const heatmap = project.heatmap ?? emptyHeatmap(90);
    const counts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    const aggregate = review.byProject.find((item) => item.projectId === project.id);
    for (const item of jobs.list()) {
      if (item.projectId !== project.id || item.status !== 'completed') continue;
      for (const severity of ['critical', 'high', 'medium', 'low']) {
        counts[severity] += Number(item.counts?.bySeverity?.[severity] ?? 0);
      }
      counts.total += Number(item.counts?.findings ?? 0);
    }
    return {
      ...project,
      heatmap: {
        from: heatmap.from,
        to: heatmap.to,
        spark: heatmap.spark ?? [],
        max: heatmap.max ?? 0,
        totalCommits: heatmap.totalCommits ?? 0,
        totalInsertions: heatmap.totalInsertions ?? 0,
        totalDeletions: heatmap.totalDeletions ?? 0,
        streaks: heatmap.streaks ?? { current: 0, longest: 0 },
        busiest: heatmap.busiest ?? { date: '', commits: 0 },
        activeDays: heatmap.activeDays ?? 0,
      },
      modules: (project.modules ?? []).slice(0, 6),
      lastReviewAt: aggregate?.lastAt ?? null,
      reviewCount: aggregate?.count ?? 0,
      findings: counts,
    };
  }

  function build() {
    const now = nowIso();
    const storeStatus = store.status?.() ?? { state: 'unknown', path: '', jobs: 0 };
    state.health.store = {
      state: storeStatus.state,
      path: storeStatus.path,
      jobs: storeStatus.jobs,
      error: storeStatus.error ?? null,
    };
    const project = state.projects.get(state.currentId) ?? null;
    const review = reviewAggregates();
    const statsRaw = store.getStats() ?? { days: {}, byType: {}, bySeverity: {}, byCategory: {} };
    const stats = {
      days: (() => {
        const map = statsRaw.days ?? {};
        return blankDays(config.heatmapDays).map((day) => ({ ...day, ...(map[day.date] ?? {}) }));
      })(),
      byType: Object.entries(statsRaw.byType ?? {}).map(([type, count]) => ({ type, count })),
      bySeverity: Object.entries(statsRaw.bySeverity ?? {}).map(([severity, count]) => ({ severity, count })),
      byCategory: Object.entries(statsRaw.byCategory ?? {}).map(([category, count]) => ({ category, count })),
      byProject: review.byProject,
      topModules: review.topModules,
      recentProjects: state.order
        .map((id) => state.projects.get(id))
        .filter(Boolean)
        .slice(0, 8)
        .map((item) => {
          const aggregate = review.byProject.find((entry) => entry.projectId === item.id);
          return {
            projectId: item.id,
            name: item.name,
            path: item.path,
            lastAt: aggregate?.lastAt ?? null,
            reviewCount: aggregate?.count ?? 0,
            findings: aggregate?.findings ?? 0,
            health: item.error ? 'error' : (item.dirty ? 'dirty' : 'ok'),
            spark: item.heatmap?.spark ?? [],
          };
        }),
      heatmap: mergeHeatmap(project, statsRaw.days ?? {}, config.heatmapDays),
    };
    const jobViews = jobs.list().slice(0, 40).map((job) => publicJob(job, {
      activity: job.status === 'running' ? 20 : 0,
    }));
    const llm = state.health.llm;
    const enginePlan = config.engine === 'structural'
      ? 'structural'
      : (config.engine === 'ocr'
        ? 'ocr'
        : (llm.state === 'configured' ? 'ocr' : (llm.state === 'delegate' ? 'delegate' : 'structural')));
    return {
      generatedAt: now,
      version: (state.builds += 1) + state.version * 1000,
      ok: true,
      config: {
        projectRoots: config.projectRoots,
        projectDepth: config.projectDepth ?? 2,
        addedProjects: [...(addedProjectPaths ?? [])],
        hostVersion: typeof config.hostVersion === 'string' ? config.hostVersion : '',
        defaultProjectId: state.currentId,
        defaultProjectPath: config.defaultProjectPath,
        pollSeconds: config.pollSeconds,
        stateDir: config.stateDir,
        engineMode: config.engine,
        enginePlan,
        ocrBin: state.health.ocr.path,
        ocrVersion: state.health.ocr.version,
        llmConfigured: llm.state === 'configured',
        llmDelegate: llm.state === 'delegate',
        llmProvider: llm.provider,
        llmModel: llm.model,
        maxJobs: config.maxJobs,
      },
      health: {
        ocr: state.health.ocr,
        llm: state.health.llm,
        git: state.health.git,
        store: state.health.store,
      },
      project: project ? { ...project, reviewCount: review.byProject.find((entry) => entry.projectId === project.id)?.count ?? 0 } : null,
      projects: state.order.map((id) => projectSummaryView(state.projects.get(id), review)).filter(Boolean),
      overview: {
        ...review.summary,
        projectsCount: state.order.length,
        streakDays: review.summary.streakDays,
      },
      jobs: jobViews,
      activity: store.getActivity().slice(-100).reverse(),
      stats,
    };
  }

  async function snapshot(payload = {}) {
    if (payload.projectId && payload.projectId !== state.currentId && state.projects.has(payload.projectId)) {
      state.currentId = String(payload.projectId);
      state.currentAt = 0;
    }
    await refreshHealth(false);
    await refreshProjects(false);
    await refreshCurrent(false);
    return build();
  }

  async function getProject({ projectId: id, projectPath, refresh = false } = {}) {
    let targetId = id && state.projects.has(String(id)) ? String(id) : '';
    if (!targetId && projectPath) {
      targetId = projectId(projectPath);
      if (!state.projects.has(targetId)) {
        const view = await inspectOne(projectPath, { days: config.heatmapDays, light: false });
        state.projects.set(targetId, { ...view, _full: true });
        state.order.unshift(targetId);
      }
    }
    if (!targetId) targetId = state.currentId;
    if (String(id) === state.currentId) {
      await refreshCurrent(refresh);
    } else if (refresh) {
      const project = state.projects.get(targetId);
      if (project?.path) {
        const view = await inspectOne(project.path, { days: config.heatmapDays, light: false });
        state.projects.set(targetId, { ...view, _full: true });
      }
    }
    const project = state.projects.get(targetId) ?? null;
    if (!project) throw new Error('项目不存在或尚未发现');
    if (!project._full) {
      const view = await inspectOne(project.path, { days: config.heatmapDays, light: false });
      const merged = { ...view, _full: true };
      state.projects.set(targetId, merged);
      return merged;
    }
    return project;
  }

  async function getGraph({ projectId: id, projectPath, kind = 'architecture', force = false } = {}) {
    const target = id
      ? state.projects.get(String(id))
      : (projectPath ? { path: projectPath } : state.projects.get(state.currentId));
    if (!target?.path) throw new Error('项目不存在');
    const key = `${target.path}\u0000${kind}`;
    const cached = state.graph.get(key);
    const now = Date.now();
    if (!force && cached && now - cached.at < GRAPH_TTL) {
      return { graph: cached.graph, summary: cached.summary, findings: cached.findings, cached: true };
    }
    const files = await walkSourceFiles(target.path, { limit: 3000 });
    const project = state.projects.get(projectId(target.path)) ?? { id: projectId(target.path), name: projectName(target.path), path: target.path, modules: [] };
    const readFile = (path) => readProjectFile(target.path, path);
    const analysis = kind === 'flow'
      ? await analyze.analyzeFlow({ project, files, readFile })
      : await analyze.analyzeArchitecture({ project, files, readFile });
    const payload = {
      graph: analysis?.graph ?? null,
      summary: analysis?.summary ?? null,
      findings: (analysis?.findings ?? []).map((item) => ({
        ...item, source: 'structural',
      })),
      metrics: analysis?.metrics ?? null,
      at: now,
    };
    state.graph.set(key, payload);
    return { graph: payload.graph, summary: payload.summary, findings: payload.findings, metrics: payload.metrics, cached: false };
  }

  function getLlmState() {
    return {
      configured: state.health.llm.state === 'configured' || state.health.llm.state === 'delegate',
      ocrConfigured: state.health.llm.state === 'configured',
      provider: state.health.llm.provider,
      model: state.health.llm.model,
    };
  }

  async function refreshAll() {
    await refreshHealth(true);
    await refreshProjects(true);
    await refreshCurrent(true);
    return build();
  }

  function invalidateGraphs() {
    state.graph.clear();
  }

  function dispose() {
    state.disposed = true;
    state.graph.clear();
  }

  return {
    init: async () => {
      await refreshHealth(true).catch(() => {});
      await refreshProjects(true).catch(() => {});
      await refreshCurrent(true).catch(() => {});
      state.version += 1;
    },
    get: snapshot,
    build,
    refreshAll,
    getProject,
    addProjectPath,
    removeProjectPath,
    getGraph,
    getLlmState,
    invalidateGraphs,
    dispose,
    selectProject: (id) => {
      if (!state.projects.has(String(id))) return false;
      state.currentId = String(id);
      state.currentAt = 0;
      return true;
    },
    get currentId() {
      return state.currentId;
    },
    state,
  };
}
