/**
 * Engine self-test.
 *
 * Wires the real job engine, snapshot builder and store to deterministic fake
 * git/ocr/analyze adapters, then runs the four review families end to end and
 * re-opens the store to prove persistence. This is the contract test that keeps
 * the Host state machine honest without needing a live LLM.
 *
 *   node tests/code-review/engine-selftest.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createStore } from '../../plugins/dsh-code-review/host/store.js';
import { createJobs } from '../../plugins/dsh-code-review/host/jobs.js';
import { createSnapshot } from '../../plugins/dsh-code-review/host/snapshot.js';
import { normalizeConfig } from '../../plugins/dsh-code-review/host/config.js';
import { addDays, dateKey, dayList } from '../../plugins/dsh-code-review/host/shared.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const STATE = join(ROOT, 'tests', '.tmp', 'code-review-engine-state');
const REPO = join(ROOT, 'plugins', 'dsh-agent-cockpit');

await rm(STATE, { recursive: true, force: true });
await mkdir(STATE, { recursive: true });

function heatmap(days) {
  const to = dateKey();
  const from = addDays(to, -(days - 1));
  const list = dayList(from, to).map((date, index) => ({
    date, commits: index % 3 === 0 ? 2 : 0, insertions: 20, deletions: 4,
  }));
  return {
    from, to, days: list, spark: list.slice(-90).map((day) => day.commits),
    max: 2, totalCommits: list.reduce((sum, day) => sum + day.commits, 0),
    totalInsertions: 1000, totalDeletions: 200,
    streaks: { current: 2, longest: 9 }, busiest: { date: to, commits: 2 }, activeDays: 120,
  };
}

const PROJECT = {
  id: 'p-test', name: 'dsh-agent-cockpit', path: REPO, kind: 'git',
  branch: 'master', head: 'abc1234', headSubject: 'test fixture', committedAt: new Date().toISOString(),
  dirty: false, remote: 'git@example.com:test.git', language: 'JavaScript',
  fileCount: 12, moduleCount: 3, loc: 3200,
  modules: [{ id: 'm-host', name: 'host', path: 'host', files: 5, loc: 1800, lastCommitAt: new Date().toISOString(), lastReviewAt: null, reviewCount: 0, findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 }, risk: 'low' }],
  heatmap: heatmap(365),
  at: new Date().toISOString(),
};

const git = {
  discoverProjects: async () => [{ id: PROJECT.id, name: PROJECT.name, path: PROJECT.path, lastCommitAt: PROJECT.committedAt, head: 'abc1234', branch: 'master' }],
  inspectProject: async ({ heatmapDays = 365, light = false }) => ({ ...PROJECT, heatmap: heatmap(heatmapDays), loc: light ? null : PROJECT.loc }),
  gitHeatmap: async () => heatmap(365),
  moduleTree: async () => PROJECT.modules,
  changedFiles: async () => ({ files: [], totalInsertions: 0, totalDeletions: 0 }),
  gitMeta: async () => ({ kind: 'git', branch: 'master', head: 'abc1234', dirty: false }),
};

const ocr = {
  probe: async () => ({ available: true, version: 'v1.13.6', path: '/fake/ocr', error: null }),
  probeLlm: async () => ({ configured: false, provider: null, model: null, source: 'none', error: null }),
  preview: async ({ type, scope }) => {
    const files = [
      { path: 'plugins/dsh-agent-cockpit/index.js', insertions: 40, deletions: 4, status: 'modified', willReview: true },
      { path: 'plugins/dsh-agent-cockpit/client.js', insertions: 120, deletions: 12, status: 'modified', willReview: true },
      { path: 'README.md', insertions: 0, deletions: 0, status: 'modified', willReview: false, reason: 'unsupported_ext' },
    ];
    if (type === 'module') {
      return { ok: true, mode: 'scan', files: files.slice(0, 2), totalInsertions: 0, totalDeletions: 0, reviewable: 2, excluded: 0 };
    }
    return { ok: true, mode: 'review', files, totalInsertions: 160, totalDeletions: 16, reviewable: 2, excluded: 1 };
  },
  runReview: async () => {
    throw new Error('runReview must not be called when the LLM is unconfigured');
  },
  llmTest: async () => ({ ok: false, latencyMs: null, message: 'LLM not configured', error: 'llm-unconfigured' }),
};

function finding(path, severity, category, title, line) {
  return {
    path, severity, category, title, content: `${title} 的详细说明`, startLine: line, endLine: line,
    rule: `rule/${category}`, module: path.split('/')[3] ?? 'host',
  };
}

const analyze = {
  analyzeArchitecture: async () => ({
    findings: [finding('plugins/dsh-agent-cockpit/host/board.js', 'high', 'maintainability', 'host 模块与 client 存在耦合', 10)],
    metrics: { modules: 3, edges: 4, cycles: 0, files: 12 },
    graph: {
      nodes: [
        { id: 'm-host', label: 'host', kind: 'module', path: 'host', files: 5, loc: 1800, risk: 'high', entryFiles: ['plugins/dsh-agent-cockpit/host/board.js'], meta: {} },
        { id: 'm-client', label: 'client', kind: 'module', path: '.', files: 1, loc: 4360, risk: 'medium', entryFiles: ['plugins/dsh-agent-cockpit/client.js'], meta: {} },
      ],
      edges: [{ from: 'm-host', to: 'm-client', kind: 'import', count: 1, risk: 'low' }],
      cycles: [],
    },
    summary: { headline: '3 个模块、1 个高耦合点', notes: ['host 层偏大'], stats: { modules: 3 } },
    activity: [{ ts: new Date().toISOString(), level: 'info', text: '解析 12 个文件' }],
  }),
  analyzeModule: async () => ({
    findings: [finding('plugins/dsh-agent-cockpit/index.js', 'medium', 'maintainability', 'index.js 过长', 1)],
    metrics: { files: 2, loc: 600, functions: 20 },
    graph: { nodes: [{ id: 'f1', label: 'index.js', kind: 'file', path: 'plugins/dsh-agent-cockpit/index.js', files: 1, loc: 555, risk: 'medium', entryFiles: [], meta: {} }], edges: [], cycles: [] },
    summary: { headline: '模块内聚良好，存在 1 个长文件', notes: [] },
    activity: [{ ts: new Date().toISOString(), level: 'info', text: '分析 2 个文件' }],
  }),
  analyzeFlow: async () => ({
    findings: [finding('plugins/dsh-agent-cockpit/index.js', 'high', 'security', 'RPC 入口缺少请求体校验', 40)],
    metrics: { flows: 1, files: 12 },
    flows: [{ id: 'flow-1', name: 'RPC', entry: { kind: 'route', name: 'POST /api/agent-cockpit', file: 'plugins/dsh-agent-cockpit/index.js', line: 40 }, steps: [], data: [] }],
    graph: {
      nodes: [
        { id: 'e1', label: 'POST /api/agent-cockpit', kind: 'entry', path: 'plugins/dsh-agent-cockpit/index.js', files: 1, loc: 40, risk: 'high', entryFiles: [], meta: {} },
        { id: 'd1', label: 'BOARD.md', kind: 'data', path: 'plugins/dsh-agent-cockpit/host/board.js', files: 1, loc: 1600, risk: 'low', entryFiles: [], meta: {} },
      ],
      edges: [{ from: 'e1', to: 'd1', kind: 'read', count: 1, risk: 'low' }],
      cycles: [],
    },
    summary: { headline: '1 条链路，入口缺校验', notes: [], stats: { flows: 1 } },
    activity: [{ ts: new Date().toISOString(), level: 'info', text: '识别 1 条信息流' }],
  }),
  analyzeDiff: async () => ({
    findings: [
      finding('plugins/dsh-agent-cockpit/index.js', 'high', 'bug', '新增分支未处理 null', 88),
      finding('plugins/dsh-agent-cockpit/client.js', 'low', 'style', '残留 console.log', 120),
    ],
    metrics: { files: 2, loc: 1200 },
    graph: null,
    summary: { headline: '2 个改动文件，1 个高优先级问题', notes: [] },
    activity: [{ ts: new Date().toISOString(), level: 'info', text: '解析 diff 2 个文件' }],
  }),
};

const config = normalizeConfig({
  projectRoots: [join(ROOT, 'plugins')],
  defaultProjectPath: REPO,
  stateDir: STATE,
  engine: 'auto',
  heatmapDays: 365,
  ocr: { command: '/fake/ocr' },
});

const logger = {
  info: (...args) => logs.push(['info', args.join(' ')]),
  warn: (...args) => logs.push(['warn', args.join(' ')]),
  error: (...args) => logs.push(['error', args.join(' ')]),
  debug: () => {},
};
const logs = [];

const store = createStore({ dir: STATE, maxJobs: 50, logger: () => logger });
let jobsApi = null;
const accessor = { list: () => jobsApi?.list() ?? [], get: (id) => jobsApi?.get(id) ?? null };
const snapshot = createSnapshot({
  config, store, jobs: accessor, git, ocr, analyze, logger, defaultProjectPath: REPO,
});
jobsApi = createJobs({
  config,
  env: process.env,
  store,
  logger,
  ocr,
  analyze,
  projectResolver: (args) => snapshot.getProject(args),
  getLlmState: () => snapshot.getLlmState(),
});

await store.init();
await jobsApi.init();
await snapshot.init();

async function waitFor(id, timeout = 15_000) {
  const started = Date.now();
  for (;;) {
    const job = jobsApi.get(id);
    if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() - started > timeout) throw new Error(`job ${id} timed out in ${job?.status}/${job?.stage?.key}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// --- 1. diff review (structural only) -------------------------------------
const diffJob = jobsApi.start({ type: 'workspace', projectPath: REPO });
assert.ok(['queued', 'running'].includes(diffJob.status));
const diffDone = await waitFor(diffJob.id);
assert.equal(diffDone.status, 'completed', `diff review failed: ${JSON.stringify(diffDone.error)}`);
assert.equal(diffDone.engine, 'structural');
assert.equal(diffDone.counts.findings, 2);
assert.equal(diffDone.counts.bySeverity.high, 1);
assert.equal(diffDone.plan.reviewable, 2);
assert.equal(diffDone.stages.find((stage) => stage.key === 'ai').status, 'skipped');
assert.ok(diffDone.summary.headline.includes('问题'), diffDone.summary.headline);
assert.ok(diffDone.summary.modules.length > 0);
assert.equal(diffDone.progress, 1);

// --- 2. architecture review ----------------------------------------------
const archJob = jobsApi.start({ type: 'architecture', projectPath: REPO });
const archDone = await waitFor(archJob.id);
assert.equal(archDone.status, 'completed', `architecture review failed: ${JSON.stringify(archDone.error)}`);
assert.ok(archDone.graph?.nodes?.length >= 2, 'architecture job must expose its module graph');
assert.ok(archDone.stages.find((stage) => stage.key === 'structure').status === 'done');
assert.equal(archDone.summary.stats.modules, 3);
assert.ok(archDone.activity.some((event) => event.text.includes('结构分析')));

// --- 3. module review -----------------------------------------------------
const moduleJob = jobsApi.start({ type: 'module', projectPath: REPO, scope: { paths: ['plugins/dsh-agent-cockpit'] } });
const moduleDone = await waitFor(moduleJob.id);
assert.equal(moduleDone.status, 'completed', `module review failed: ${JSON.stringify(moduleDone.error)}`);
assert.equal(moduleDone.counts.findings, 1);
assert.ok(moduleDone.summary.modules.includes('dsh-agent-cockpit') || moduleDone.summary.modules.length > 0);

// --- 4. flow review -------------------------------------------------------
const flowJob = jobsApi.start({ type: 'flow', projectPath: REPO });
const flowDone = await waitFor(flowJob.id);
assert.equal(flowDone.status, 'completed', `flow review failed: ${JSON.stringify(flowDone.error)}`);
assert.ok(flowDone.graph.nodes.some((node) => node.kind === 'entry'));
assert.ok(flowDone.summary.notes.length >= 1);

// --- 5. bad scope is rejected synchronously ------------------------------
assert.throws(() => jobsApi.start({ type: 'commit', projectPath: REPO }), /commit/);
assert.throws(() => jobsApi.start({ type: 'module', projectPath: REPO }), /模块路径/);

// --- 6. snapshot projection ----------------------------------------------
const snap = await snapshot.get({});
assert.equal(snap.health.ocr.state, 'ok');
assert.equal(snap.health.llm.state, 'unconfigured');
assert.equal(snap.config.llmConfigured, false);
assert.ok(snap.project, 'snapshot must expose the current project');
assert.equal(snap.project.heatmap.days.length, 365);
assert.equal(snap.projects.length, 1);
assert.ok(snap.projects[0].heatmap.spark.length === 90);
assert.equal(snap.jobs.length, 4);
assert.equal(snap.overview.reviewsTotal, 4);
assert.equal(snap.overview.findings.total, 1 + 1 + 2 + 1);
assert.equal(snap.stats.days.length, 365);
assert.equal(snap.stats.heatmap.days.length, 365);
assert.ok(snap.stats.topModules.length > 0, 'top modules must aggregate');
assert.ok(snap.activity.length > 0);
assert.ok(JSON.stringify(snap).length > 2000);
// Findings stay out of the polled snapshot but are available on demand.
assert.ok(!snap.jobs.some((job) => Array.isArray(job.findings)));

const detail = await jobsApi.getFull(archDone.id);
assert.ok(Array.isArray(detail.findings));
assert.ok(detail.graph);

// --- 7. persistence across a new store -----------------------------------
await store.flush();
const reopened = createStore({ dir: STATE, maxJobs: 50, logger: () => logger });
await reopened.init();
const storedJob = await reopened.getJobFull(archDone.id);
assert.ok(storedJob, 'job must survive a store reopen');
assert.equal(storedJob.status, 'completed');
assert.ok(storedJob.findings.length >= 1);
const indexRaw = JSON.parse(await readFile(join(STATE, 'index.json'), 'utf8'));
assert.ok(Array.isArray(indexRaw) && indexRaw.length === 4);
assert.ok(indexRaw.every((job) => job.findings === undefined), 'index summaries must strip the findings array');

// --- 8. stats recorded once ----------------------------------------------
const stats = reopened.getStats();
const totalDays = Object.values(stats.days).reduce((sum, day) => sum + day.reviews, 0);
assert.equal(totalDays, 4, `recordReview must count 4 completed reviews, got ${totalDays}`);
assert.equal(stats.byType.workspace, 1);
assert.equal(stats.byType.architecture, 1);

jobsApi.dispose();
snapshot.dispose();
await reopened.flush();

console.log('engine self-test passed:', {
  jobs: 4,
  findings: snap.overview.findings.total,
  topModules: snap.stats.topModules.length,
  stateDir: relative(ROOT, STATE),
});
