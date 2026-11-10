/**
 * Tool self-test: the conversational entry.
 *
 * Registers the real `code_review` tool definition against a fake Cordis scope,
 * then executes `start/status/detail/list` through it. Reviews run on the real
 * job engine with deterministic fake git/ocr/analyze adapters, so this covers
 * the whole "在对话里 review 当前项目" path without a live LLM.
 *
 *   node tests/code-review/tool-selftest.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createStore } from '../../plugins/dsh-code-review/host/store.js';
import { createJobs } from '../../plugins/dsh-code-review/host/jobs.js';
import { createSnapshot } from '../../plugins/dsh-code-review/host/snapshot.js';
import { registerCodeReviewTool, createCodeReviewToolDefinition } from '../../plugins/dsh-code-review/host/tool.js';
import { normalizeConfig } from '../../plugins/dsh-code-review/host/config.js';
import { addDays, dateKey, dayList } from '../../plugins/dsh-code-review/host/shared.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const STATE = join(ROOT, 'tests', '.tmp', 'code-review-tool-state');
const REPO = join(ROOT, 'plugins', 'dsh-code-review');

await rm(STATE, { recursive: true, force: true });
await mkdir(STATE, { recursive: true });

function heatmap(days) {
  const to = dateKey();
  const from = addDays(to, -(days - 1));
  const list = dayList(from, to).map((date) => ({ date, commits: 1, insertions: 10, deletions: 2 }));
  return {
    from, to, days: list, spark: list.slice(-90).map((day) => day.commits), max: 1,
    totalCommits: list.length, totalInsertions: 10, totalDeletions: 2,
    streaks: { current: 1, longest: 1 }, busiest: { date: to, commits: 1 }, activeDays: list.length,
  };
}

const PROJECT = {
  id: 'p-tool', name: 'dsh-code-review', path: REPO, kind: 'git', branch: 'main', head: 'abc1234',
  headSubject: 'fixture', committedAt: new Date().toISOString(), dirty: false, remote: null,
  language: 'JavaScript', fileCount: 20, moduleCount: 3, loc: 12000,
  modules: [], heatmap: heatmap(365), at: new Date().toISOString(),
};

const git = {
  discoverProjects: async () => [{ id: PROJECT.id, name: PROJECT.name, path: REPO, lastCommitAt: PROJECT.committedAt }],
  inspectProject: async ({ heatmapDays = 365 }) => ({ ...PROJECT, heatmap: heatmap(heatmapDays) }),
  gitHeatmap: async () => heatmap(365),
  moduleTree: async () => [],
  changedFiles: async () => ({ files: [], totalInsertions: 0, totalDeletions: 0 }),
  gitMeta: async () => ({ kind: 'git', branch: 'main', head: 'abc1234', dirty: false }),
};

const ocr = {
  probe: async () => ({ available: true, version: 'v1.13.6', path: '/fake/ocr', error: null }),
  probeLlm: async () => ({ configured: false, provider: null, model: null, source: 'none', error: null }),
  preview: async ({ type }) => ({
    ok: true,
    mode: type === 'module' ? 'scan' : 'review',
    files: [
      { path: 'index.js', insertions: 30, deletions: 2, status: 'modified', willReview: true },
      { path: 'client.js', insertions: 80, deletions: 10, status: 'modified', willReview: true },
    ],
    totalInsertions: type === 'module' ? 0 : 110,
    totalDeletions: type === 'module' ? 0 : 12,
    reviewable: 2,
    excluded: 0,
  }),
  runReview: async () => {
    throw new Error('OCR LLM must not be used in the tool test');
  },
  llmTest: async () => ({ ok: false }),
};

const analyze = {
  analyzeArchitecture: async () => ({
    findings: [
      {
        path: 'index.js', severity: 'high', category: 'maintainability',
        title: 'RPC 入口与任务引擎存在双向依赖', content: '建议下沉共享契约。',
        startLine: 10, endLine: 20, rule: 'arch.cycle', module: 'host',
      },
    ],
    metrics: { modules: 3, edges: 4, cycles: 1, files: 20 },
    graph: {
      nodes: [{ id: 'm-host', label: 'host', kind: 'module', path: 'host', files: 11, loc: 9000, risk: 'high', entryFiles: ['index.js'], meta: {} }],
      edges: [],
      cycles: [],
    },
    summary: { headline: '3 个模块、1 组循环依赖', notes: ['host 与 index 相互依赖'], stats: { modules: 3 } },
    activity: [{ ts: new Date().toISOString(), level: 'info', text: '解析 20 个文件' }],
  }),
  analyzeModule: async () => ({
    findings: [
      {
        path: 'host/tool.js', severity: 'medium', category: 'maintainability',
        title: 'tool.js 参数校验分散', content: '建议集中校验。',
        startLine: 1, endLine: 5, rule: 'module.long-function', module: 'host',
      },
    ],
    metrics: { files: 2, loc: 500 },
    graph: null,
    summary: { headline: '1 个模块、1 条问题', notes: [] },
    activity: [],
  }),
  analyzeFlow: async () => ({ findings: [], metrics: {}, graph: { nodes: [], edges: [], cycles: [] }, summary: { headline: '', notes: [] }, activity: [] }),
  analyzeDiff: async () => ({ findings: [], metrics: { files: 2 }, graph: null, summary: { headline: '', notes: [] }, activity: [] }),
};

const config = normalizeConfig({
  projectRoots: [join(ROOT, 'plugins')],
  defaultProjectPath: REPO,
  stateDir: STATE,
  engine: 'structural',
  ocr: { command: '/fake/ocr' },
});
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const store = createStore({ dir: STATE, maxJobs: 20, logger: () => logger });
let jobsApi = null;
const accessor = { list: () => jobsApi?.list() ?? [], get: (id) => jobsApi?.get(id) ?? null };
const snapshot = createSnapshot({ config, store, jobs: accessor, git, ocr, analyze, logger, defaultProjectPath: REPO });
jobsApi = createJobs({
  config, env: process.env, store, logger, ocr, analyze,
  projectResolver: (args) => snapshot.getProject(args),
  getLlmState: () => snapshot.getLlmState(),
});
await store.init();
await jobsApi.init();
await snapshot.init();

// --- registration ---------------------------------------------------------
let registered = null;
const disposers = [];
const scope = {
  tools: {
    register(definition) {
      registered = definition;
      return () => { registered = null; };
    },
  },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  },
};
const ctx = {
  inject: (deps, callback) => {
    if (deps.includes('tools')) callback(scope);
  },
};
const definition = registerCodeReviewTool(ctx, { jobs: jobsApi, config, logger });
assert.ok(registered, 'tool must register on the tools service');
assert.equal(registered.name, 'code_review');
assert.equal(typeof registered.execute, 'function');
assert.equal(registered.parameters.properties.action.enum.includes('start'), true);
assert.ok(registered.description.includes('当前项目') || registered.description.includes('评审'));
assert.equal(typeof definition.output.render, 'function');

const exec = { agent: { session: { header: { cwd: REPO } } } };

// --- start (architecture, waits for completion) ---------------------------
const started = await registered.execute(
  { action: 'start', type: 'architecture' },
  exec,
);
assert.equal(started.ok, true, JSON.stringify(started.error));
assert.equal(started.action, 'start');
assert.ok(started.job.id.startsWith('rv-'));
assert.equal(started.job.status, 'completed', JSON.stringify(started.job.error));
assert.ok(started.findings.length >= 1);
assert.equal(started.findings[0].severity, 'high');
assert.equal(started.projectPath, REPO, 'omitted project_path must resolve to the session cwd');

const renderText = definition.output.render({ action: 'start' }, started)
  .map((block) => block.text).join('\n');
assert.ok(renderText.includes('评审完成'));
assert.ok(renderText.includes('问题'));
assert.ok(renderText.includes('代码评审中心'));

// --- start with wait:false returns immediately ----------------------------
const asyncStart = await registered.execute(
  { action: 'start', type: 'module', scope: { paths: ['host'] }, wait: false },
  exec,
);
assert.equal(asyncStart.ok, true);
assert.equal(asyncStart.waiting, false);
assert.ok(['queued', 'running', 'completed'].includes(asyncStart.job.status));

// --- status / detail / list ----------------------------------------------
const status = await registered.execute({ action: 'status', job_id: started.job.id }, exec);
assert.equal(status.ok, true);
assert.equal(status.job.id, started.job.id);

const detail = await registered.execute(
  { action: 'detail', job_id: started.job.id, severity: 'high', limit: 10 },
  exec,
);
assert.equal(detail.ok, true);
assert.ok(detail.findings.every((item) => item.severity === 'high' || item.severity === 'critical'));

const listed = await registered.execute({ action: 'list', limit: 5 }, exec);
assert.equal(listed.ok, true);
assert.ok(listed.jobs.length >= 2);

// --- relative project path resolves against the session cwd --------------
const relativeStart = await registered.execute(
  { action: 'start', type: 'architecture', project_path: '.' },
  exec,
);
assert.equal(relativeStart.ok, true);
assert.equal(relativeStart.projectPath, REPO);

// --- invalid input does not throw ----------------------------------------
const badAction = await registered.execute({ action: 'nope' }, exec);
assert.equal(badAction.ok, false);
assert.equal(badAction.error.code, 'code-review/bad-action');

const missing = await registered.execute({ action: 'detail', job_id: 'rv-missing' }, exec);
assert.equal(missing.ok, false);
assert.equal(missing.error.code, 'code-review/not-found');

// --- render failure -------------------------------------------------------
const failureText = definition.output.render({}, { ok: false, error: { message: 'boom' } })[0].text;
assert.ok(failureText.includes('boom'));

for (const dispose of disposers) dispose();
assert.equal(registered, null, 'tool must unregister on disposal');
jobsApi.dispose();
snapshot.dispose();
await store.flush();

console.log('tool self-test passed:', {
  job: started.job.id,
  findings: started.findings.length,
  jobs: listed.jobs.length,
  state: STATE,
});
