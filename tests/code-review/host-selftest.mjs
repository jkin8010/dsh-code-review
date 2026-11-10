/**
 * Host integration test.
 *
 * Mounts the real `apply()` against a fake Cordis context (captured
 * `/api/code-review` route), then talks to it over the exact envelope the Web
 * client uses. Uses the real git and ocr adapters and the real structural
 * analysers — only the LLM layer is absent, so jobs take the offline path.
 *
 *   node tests/code-review/host-selftest.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name } from '../../plugins/dsh-code-review/index.js';
import { projectId } from '../../plugins/dsh-code-review/host/config.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const STATE = join(ROOT, 'tests', '.tmp', 'code-review-host-state');
const PLUGIN = join(ROOT, 'plugins', 'dsh-code-review');
const TEMP_REPO = join(ROOT, 'tests', '.tmp', 'diffdemo');
const OCR = '/Users/jkin/.nvm/versions/node/v24.15.0/bin/ocr';

await rm(STATE, { recursive: true, force: true });
await mkdir(STATE, { recursive: true });

let route = null;
const effects = [];
const logs = [];
const scope = {
  get: (service) => {
    if (service === 'connection') {
      return { fetch: { register: (config) => { route = config; return () => { route = null; }; } } };
    }
    return undefined;
  },
  effect: (factory) => {
    const disposer = factory();
    if (typeof disposer === 'function') effects.push(disposer);
    return disposer;
  },
  logger: () => ({
    info: (...args) => logs.push(['info', args.join(' ')]),
    warn: (...args) => logs.push(['warn', args.join(' ')]),
    error: (...args) => logs.push(['error', args.join(' ')]),
    debug: () => {},
  }),
};
const ctx = {
  get: scope.get,
  inject: (_deps, callback) => callback(scope),
  effect: scope.effect,
  logger: scope.logger,
};

assert.equal(name, 'qise-code-review');
apply(ctx, {
  projectRoots: [join(ROOT, 'plugins'), join(ROOT, 'tests', '.tmp')],
  defaultProjectPath: PLUGIN,
  stateDir: STATE,
  engine: 'structural',
  pollSeconds: 2,
  ocr: { command: OCR },
});
assert.ok(route, 'the plugin must register /api/code-review');

function envelope(payload) {
  return new Request('http://local/api/code-review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', method: 'code-review', rpcId: 'r1', payload }),
  });
}

async function rpc(method, payload = {}) {
  const response = await route.fetch(envelope({ method, payload }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, 'server-response');
  assert.equal(body.rpcId, 'r1');
  if (body.result.ok === false) {
    const error = new Error(body.result.error.message);
    error.code = body.result.error.code;
    throw error;
  }
  return body.result.value;
}

async function snapshot(payload = {}) {
  const started = Date.now();
  for (;;) {
    const value = await rpc('snapshot', payload);
    if (value?.health?.ocr?.state === 'ok' && Array.isArray(value.projects) && value.projects.length > 0) return value;
    if (Date.now() - started > 20_000) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function waitFor(id, timeout = 30_000) {
  const started = Date.now();
  for (;;) {
    const detail = await rpc('job', { id });
    const job = detail?.job;
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return detail;
    if (Date.now() - started > timeout) throw new Error(`job ${id} timed out (${job?.status}/${job?.stage?.key})`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

// --- snapshot shell -------------------------------------------------------
const snap = await snapshot();
assert.equal(snap.ok, true);
assert.equal(snap.health.ocr.state, 'ok');
assert.match(snap.health.ocr.version ?? '', /^v?\d+\./);
assert.equal(snap.health.llm.state, 'unconfigured');
assert.equal(snap.config.engineMode, 'structural');
assert.ok(snap.project, 'default project must be present');
assert.equal(snap.project.path, PLUGIN);
assert.equal(snap.project.heatmap.days.length, 365);
assert.ok(snap.stats.days.length === 365);
assert.ok(snap.overview.projectsCount >= 2);
assert.ok(snap.projects.some((project) => project.path === PLUGIN));
assert.ok(snap.projects.some((project) => project.path === TEMP_REPO));

// --- 1. module review on the plugin itself --------------------------------
const moduleJob = await rpc('start', {
  type: 'module',
  projectPath: PLUGIN,
  scope: { paths: ['host'] },
});
assert.equal(moduleJob.job.status === 'queued' || moduleJob.job.status === 'running', true);
assert.equal(moduleJob.job.engine, 'structural');
const moduleDone = await waitFor(moduleJob.job.id);
assert.equal(moduleDone.job.status, 'completed', JSON.stringify(moduleDone.job.error));
assert.ok(moduleDone.job.plan.reviewable > 0, 'module scan must select files');
assert.ok(moduleDone.job.counts.filesReviewed > 0);
assert.ok(Array.isArray(moduleDone.findings));
assert.ok(moduleDone.findings.length > 0, 'module review must produce findings');
assert.ok(moduleDone.findings.every((item) => item.path && item.severity && item.category));
assert.ok(moduleDone.files.length > 0);
assert.equal(moduleDone.job.stages.find((stage) => stage.key === 'ai').status, 'skipped');

// --- 2. architecture review on the plugin itself --------------------------
const archJob = await rpc('start', { type: 'architecture', projectPath: PLUGIN });
const archDone = await waitFor(archJob.job.id);
assert.equal(archDone.job.status, 'completed', JSON.stringify(archDone.job.error));
assert.ok(archDone.graph?.nodes?.length >= 2, 'architecture review must return a module graph');
assert.ok(archDone.job.summary.headline);
assert.ok(archDone.job.summary.notes.length >= 1);

// --- 3. workspace review on a clean git checkout --------------------------
const cleanRepo = join(ROOT, 'tests', '.tmp', 'clean-repo');
await rm(cleanRepo, { recursive: true, force: true });
await mkdir(cleanRepo, { recursive: true });
const { execFileSync } = await import('node:child_process');
execFileSync('git', ['init', '-q'], { cwd: cleanRepo });
execFileSync('git', ['config', 'user.email', 't@t'], { cwd: cleanRepo });
execFileSync('git', ['config', 'user.name', 't'], { cwd: cleanRepo });
await (await import('node:fs/promises')).writeFile(join(cleanRepo, 'main.py'), 'def hello():\n    return 1\n');
execFileSync('git', ['add', '.'], { cwd: cleanRepo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: cleanRepo });

await rpc('refresh');
const cleanSnap = await snapshot({ projectId: projectId(cleanRepo) });
assert.ok(cleanSnap.projects.some((project) => project.path === cleanRepo), 'new git project must be discovered');
const emptyJob = await rpc('start', { type: 'workspace', projectPath: cleanRepo });
const emptyDone = await waitFor(emptyJob.job.id);
assert.equal(emptyDone.job.status, 'completed');
assert.match(emptyDone.job.message ?? '', /没有可评审的改动/);

// --- 4. workspace review with a real diff --------------------------------
const changedJob = await rpc('start', { type: 'workspace', projectPath: TEMP_REPO });
const changedDone = await waitFor(changedJob.job.id);
assert.equal(changedDone.job.status, 'completed', JSON.stringify(changedDone.job.error));
assert.ok(changedDone.job.plan.reviewable > 0, 'changed worktree must be reviewable');
assert.ok(changedDone.findings.length >= 2, 'diff heuristics must find the injected problems');
assert.ok(changedDone.findings.some((item) => item.category === 'security'));
assert.ok(changedDone.findings.some((item) => item.title.includes('catch') || item.category === 'bug'));

// --- 4b. ad-hoc project outside projectRoots ------------------------------
const adHocRoot = await mkdtemp(join(tmpdir(), 'cr-adhoc-'));
const addedRepo = join(adHocRoot, 'added-project');
await mkdir(addedRepo, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: addedRepo });
execFileSync('git', ['config', 'user.email', 't@t'], { cwd: addedRepo });
execFileSync('git', ['config', 'user.name', 't'], { cwd: addedRepo });
await writeFile(join(addedRepo, 'main.py'), 'def hello():\n    return 1\n');
execFileSync('git', ['add', '.'], { cwd: addedRepo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: addedRepo });

const added = await rpc('project.add', { path: addedRepo });
assert.equal(added.project.path, addedRepo, 'project.add must return the added project');
assert.ok(added.snapshot.projects.some((project) => project.path === addedRepo), 'added project must appear in the snapshot');
const addedSnap = await snapshot({ projectId: projectId(addedRepo) });
assert.equal(addedSnap.project.path, addedRepo);
assert.equal(addedSnap.project.id, projectId(addedRepo));

// A review started on a path outside projectRoots must keep that project in the
// picker after the next refresh (this is the "reviewed project disappears" bug).
const reviewedRepo = join(adHocRoot, 'reviewed-project');
await mkdir(reviewedRepo, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: reviewedRepo });
execFileSync('git', ['config', 'user.email', 't@t'], { cwd: reviewedRepo });
execFileSync('git', ['config', 'user.name', 't'], { cwd: reviewedRepo });
await writeFile(join(reviewedRepo, 'app.py'), 'def hello():\n    return 1\n');
execFileSync('git', ['add', '.'], { cwd: reviewedRepo });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: reviewedRepo });
const adHocJob = await rpc('start', { type: 'workspace', projectPath: reviewedRepo });
const adHocDone = await waitFor(adHocJob.job.id);
assert.equal(adHocDone.job.status, 'completed');
await rpc('refresh');
const refreshed = await rpc('snapshot', {});
assert.ok(refreshed.projects.some((project) => project.path === reviewedRepo),
  'a reviewed ad-hoc project must stay in the project list after refresh');
assert.ok(refreshed.stats.byProject.some((item) => item.projectId === projectId(reviewedRepo)));

const browseRoot = join(adHocRoot, 'browse-root');
await mkdir(join(browseRoot, 'sub-a'), { recursive: true });
await mkdir(join(browseRoot, 'sub-b'), { recursive: true });
await writeFile(join(browseRoot, 'file.txt'), 'not a directory');
const listing = await rpc('project.browse', { path: browseRoot });
assert.equal(listing.path, browseRoot);
assert.ok(listing.parent, 'browse must expose a parent');
assert.deepEqual(listing.entries.map((entry) => entry.name), ['sub-a', 'sub-b']);
assert.ok(listing.entries.every((entry) => entry.path.startsWith(browseRoot)));
assert.ok(Array.isArray(listing.roots));

const removed = await rpc('project.remove', { path: addedRepo });
assert.equal(removed.ok, true);

// --- 5. job listing, cancel and retry wiring ------------------------------
const after = await snapshot();
assert.ok(after.jobs.length >= 4);
assert.equal(after.overview.reviewsTotal >= 4, true);
assert.ok(after.overview.findings.total >= 3);
assert.ok(after.stats.days.some((day) => day.reviews > 0), 'review days must be recorded');
assert.ok(after.stats.topModules.length > 0);
assert.ok(after.stats.heatmap.days.length === 365);
assert.ok(after.stats.heatmap.days.some((day) => day.reviews > 0));
assert.ok(after.activity.length > 0);

const retried = await rpc('retry', { id: archJob.job.id });
assert.ok(retried.job?.id);
const cancelled = await rpc('cancel', { id: retried.job.id });
assert.equal(typeof cancelled.ok, 'boolean');
const deleted = await rpc('delete', { id: emptyDone.job.id });
assert.equal(deleted.ok, true);

const graph = await rpc('graph', { projectId: projectId(PLUGIN), kind: 'architecture' });
assert.ok(graph.graph?.nodes?.length >= 2);
assert.ok(Array.isArray(graph.findings));

const flowGraph = await rpc('graph', { projectId: projectId(PLUGIN), kind: 'flow' });
assert.ok(flowGraph.graph, 'flow graph must always return a graph object');

const llm = await rpc('llmTest', {});
assert.equal(typeof llm.ok, 'boolean');

// --- 6. bad requests ------------------------------------------------------
await assert.rejects(() => rpc('nope'), /未知方法/);
await assert.rejects(() => rpc('job', { id: 'missing' }), /不存在/);
await assert.rejects(() => rpc('start', { type: 'commit', projectPath: TEMP_REPO }), /commit/);

// --- 7. ping + teardown ---------------------------------------------------
const ping = await rpc('ping');
assert.equal(ping.ok, true);
for (const dispose of effects) dispose();
await new Promise((resolve) => setTimeout(resolve, 100));
route = null;
console.log('host self-test passed:', {
  projects: snap.overview.projectsCount,
  jobs: after.jobs.length,
  findings: after.overview.findings.total,
  modules: after.stats.topModules.length,
  state: STATE,
});
