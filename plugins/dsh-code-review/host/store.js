import { mkdir, readdir, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteJson, dateKey, errorText, readJsonAsync, nowIso } from './shared.js';

/**
 * Durable review history.
 *
 * Layout under `<stateDir>`:
 *   index.json          summaries of every stored job (newest first)
 *   jobs/<id>.json      one full job including findings and graphs
 *   stats.json          per-day aggregates used by the heatmap and counters
 *   activity.json       recent cross-job activity feed
 *
 * Writes are atomic (tmp + rename). The in-memory job is authoritative while a
 * review runs; disk persistence is throttled to stage boundaries and the final
 * state, so progress ticks never turn into a write storm.
 */

const ACTIVITY_LIMIT = 240;
const SUMMARY_FIELDS = [
  'id', 'seq', 'projectId', 'projectName', 'projectPath', 'type', 'title', 'subtitle',
  'scope', 'engine', 'engineDetail', 'options', 'status', 'stage', 'progress',
  'createdAt', 'startedAt', 'finishedAt', 'durationMs', 'counts', 'stages', 'error',
  'plan', 'summary', 'artifacts', 'message',
];

function summarize(job) {
  const summary = {};
  for (const field of SUMMARY_FIELDS) {
    if (job[field] !== undefined) summary[field] = job[field];
  }
  // Keep the tail of the activity feed so the list can hint at live work.
  summary.activity = Array.isArray(job.activity) ? job.activity.slice(-12) : [];
  return summary;
}

function emptyStats() {
  return { days: {}, byType: {}, bySeverity: {}, byCategory: {}, updatedAt: null };
}

export function createStore({ dir, maxJobs = 200, logger } = {}) {
  const root = String(dir ?? '');
  const jobsDir = join(root, 'jobs');
  const indexPath = join(root, 'index.json');
  const statsPath = join(root, 'stats.json');
  const activityPath = join(root, 'activity.json');

  /** @type {Map<string, any>} */
  const jobs = new Map();
  /** @type {Map<string, Promise<any>>} */
  const loading = new Map();
  let stats = emptyStats();
  let activity = [];
  let indexTimer = null;
  let activityTimer = null;
  let statsTimer = null;
  let initialized = false;
  let lastError = null;
  let seq = 0;

  const log = (level, message) => {
    try {
      const logger2 = logger?.() ?? logger;
      const sink = logger2?.[level] ?? logger2?.info;
      sink?.call?.(logger2, message);
    } catch {
      /* logging never breaks persistence */
    }
  };

  function scheduleIndexFlush() {
    if (indexTimer) return;
    indexTimer = setTimeout(() => {
      indexTimer = null;
      void flushIndex();
    }, 900);
    indexTimer.unref?.();
  }

  function scheduleStatsFlush() {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      void atomicWriteJson(statsPath, stats).catch((error) => {
        lastError = errorText(error);
        log('warn', `stats flush failed: ${lastError}`);
      });
    }, 1200);
    statsTimer.unref?.();
  }

  function scheduleActivityFlush() {
    if (activityTimer) return;
    activityTimer = setTimeout(() => {
      activityTimer = null;
      void atomicWriteJson(activityPath, activity).catch(() => {});
    }, 600);
    activityTimer.unref?.();
  }

  async function flushIndex() {
    const list = [...jobs.values()]
      .filter((job) => !job.removed)
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      .slice(0, maxJobs)
      .map(summarize);
    try {
      await atomicWriteJson(indexPath, list);
    } catch (error) {
      lastError = errorText(error);
      log('warn', `index flush failed: ${lastError}`);
    }
  }

  async function loadFullJob(id) {
    if (loading.has(id)) return loading.get(id);
    const pending = (async () => {
      const full = await readJsonAsync(join(jobsDir, `${id}.json`), null);
      if (full && typeof full === 'object') {
        const current = jobs.get(id);
        // The index only carries summaries; hydrate from disk unless a live
        // in-memory copy is mid-run (dirty, not finished).
        const replace = !current || current._loaded === false || (!current._dirty && !current.finishedAt);
        if (replace) jobs.set(id, { ...full, _loaded: true });
        return jobs.get(id) ?? full;
      }
      return jobs.get(id) ?? null;
    })().finally(() => loading.delete(id));
    loading.set(id, pending);
    return pending;
  }

  async function init() {
    if (initialized) return api;
    initialized = true;
    lastError = null;
    try {
      await mkdir(jobsDir, { recursive: true });
    } catch (error) {
      lastError = errorText(error);
      log('error', `cannot create state dir ${root}: ${lastError}`);
      return api;
    }

    const index = await readJsonAsync(indexPath, []);
    if (Array.isArray(index)) {
      for (const summary of index) {
        if (!summary || typeof summary !== 'object' || !summary.id) continue;
        jobs.set(String(summary.id), { ...summary, _loaded: false });
        seq = Math.max(seq, Number(summary.seq) || 0);
      }
    }

    // Recover summaries the index missed (for example after a crash mid-run).
    try {
      const names = await readdir(jobsDir);
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (jobs.has(id)) continue;
        const full = await readJsonAsync(join(jobsDir, name), null);
        if (!full || typeof full !== 'object') continue;
        jobs.set(id, { ...summarize(full), _loaded: true, _full: full });
        seq = Math.max(seq, Number(full.seq) || 0);
      }
    } catch {
      /* directory missing is fine */
    }

    // A running job at startup means the host died mid-review.
    for (const job of jobs.values()) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'failed';
        job.error = { code: 'code-review/interrupted', message: 'Host 重启时评审尚未完成，已标记为中断。' };
        job.finishedAt = job.finishedAt ?? nowIso();
        job.stage = { key: 'report', label: '报告', index: 5, total: 6 };
        job.progress = 1;
        job._dirty = true;
      }
    }

    stats = (await readJsonAsync(statsPath, null)) ?? emptyStats();
    stats.days ??= {};
    stats.byType ??= {};
    stats.bySeverity ??= {};
    stats.byCategory ??= {};
    const storedActivity = await readJsonAsync(activityPath, []);
    if (Array.isArray(storedActivity)) activity = storedActivity.slice(-ACTIVITY_LIMIT);

    await flushIndex();
    // Persist the interrupted-state fix without blocking startup.
    for (const job of jobs.values()) {
      if (job._dirty) {
        delete job._dirty;
        void persist(job);
      }
    }
    return api;
  }

  async function persist(job) {
    try {
      const full = { ...job };
      delete full._dirty;
      delete full._loaded;
      await atomicWriteJson(join(jobsDir, `${job.id}.json`), full);
      job._loaded = true;
    } catch (error) {
      lastError = errorText(error);
      log('warn', `job persist failed for ${job.id}: ${lastError}`);
    }
  }

  async function ensureLoaded(id) {
    const job = jobs.get(id);
    if (!job) return null;
    if (!job._loaded) {
      const full = await loadFullJob(id);
      if (full && full !== job) {
        jobs.set(id, { ...full, _loaded: true });
        return jobs.get(id);
      }
      job._loaded = true;
    }
    return job;
  }

  const api = {
    get path() {
      return root;
    },

    async init() {
      return init();
    },

    nextSeq() {
      seq += 1;
      return seq;
    },

    getJob(id) {
      return jobs.get(String(id)) ?? null;
    },

    async getJobFull(id) {
      return ensureLoaded(String(id));
    },

    listJobs() {
      return [...jobs.values()]
        .filter((job) => !job.removed)
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    },

    saveJob(job, { final = false } = {}) {
      if (!job || !job.id) return;
      jobs.set(job.id, job);
      job._dirty = true;
      scheduleIndexFlush();
      if (final) {
        job._dirty = false;
        job._loaded = true;
        void persist(job);
      }
    },

    async persistNow(job) {
      if (!job) return;
      job._dirty = false;
      await persist(job);
      scheduleIndexFlush();
    },

    async deleteJob(id) {
      const key = String(id);
      if (!jobs.has(key)) return false;
      jobs.delete(key);
      try {
        await rm(join(jobsDir, `${key}.json`), { force: true });
      } catch {
        /* ignore */
      }
      scheduleIndexFlush();
      return true;
    },

    getStats() {
      return stats;
    },

    getActivity() {
      return activity;
    },

    appendActivity(event) {
      activity.push(event);
      if (activity.length > ACTIVITY_LIMIT) activity = activity.slice(-ACTIVITY_LIMIT);
      scheduleActivityFlush();
      return event;
    },

    recordReview(job) {
      if (!job || job.status !== 'completed' || job._recorded) return;
      job._recorded = true;
      const key = dateKey(job.finishedAt ?? nowIso());
      const day = stats.days[key] ?? { reviews: 0, findings: 0, critical: 0, files: 0, tokens: 0 };
      day.reviews += 1;
      day.findings += Number(job.counts?.findings ?? 0);
      day.critical += Number(job.counts?.bySeverity?.critical ?? 0);
      day.files += Number(job.counts?.filesReviewed ?? job.counts?.filesPlanned ?? 0);
      day.tokens += Number(job.counts?.tokens ?? 0);
      stats.days[key] = day;
      stats.byType[job.type] = (stats.byType[job.type] ?? 0) + 1;
      for (const [severity, count] of Object.entries(job.counts?.bySeverity ?? {})) {
        if (!Number(count)) continue;
        stats.bySeverity[severity] = (stats.bySeverity[severity] ?? 0) + Number(count);
      }
      for (const [category, count] of Object.entries(job.counts?.byCategory ?? {})) {
        if (!Number(count)) continue;
        stats.byCategory[category] = (stats.byCategory[category] ?? 0) + Number(count);
      }
      stats.updatedAt = nowIso();
      scheduleStatsFlush();
    },

    async flush() {
      if (indexTimer) clearTimeout(indexTimer);
      if (activityTimer) clearTimeout(activityTimer);
      if (statsTimer) clearTimeout(statsTimer);
      indexTimer = activityTimer = statsTimer = null;
      await Promise.allSettled([
        flushIndex(),
        atomicWriteJson(statsPath, stats),
        atomicWriteJson(activityPath, activity),
      ]);
    },

    status() {
      return {
        state: lastError ? 'error' : (initialized ? 'ok' : 'pending'),
        path: root,
        jobs: jobs.size,
        error: lastError,
      };
    },
  };

  return api;
}
