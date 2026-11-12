/**
 * Delegation self-test.
 *
 * Proves the "host model performs the review" path: OCR still selects files, the
 * plugin calls the DSH llm route (`ctx.llm.stream`) instead of a separate OCR API
 * key, parses the strict-JSON findings, and the job engine merges them with the
 * structural pass.
 *
 *   node tests/code-review/delegate-selftest.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createStore } from '../../host/store.js';
import { createJobs } from '../../host/jobs.js';
import { createSnapshot } from '../../host/snapshot.js';
import { createLlmReviewer } from '../../host/llm-review.js';
import { normalizeConfig } from '../../host/config.js';
import { addDays, dateKey, dayList } from '../../host/shared.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const STATE = join(ROOT, 'tests', '.tmp', 'code-review-delegate-state');
const REPO = join(ROOT, 'plugins', 'dsh-agent-cockpit');

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
  id: 'p-test', name: 'dsh-agent-cockpit', path: REPO, kind: 'git', branch: 'master', head: 'abc1234',
  headSubject: 'fixture', committedAt: new Date().toISOString(), dirty: false, remote: null,
  language: 'JavaScript', fileCount: 10, moduleCount: 2, loc: 3000,
  modules: [], heatmap: heatmap(365), at: new Date().toISOString(),
};

const git = {
  discoverProjects: async () => [{ id: 'p-test', name: PROJECT.name, path: REPO, lastCommitAt: PROJECT.committedAt }],
  inspectProject: async ({ heatmapDays = 365 }) => ({ ...PROJECT, heatmap: heatmap(heatmapDays) }),
  gitHeatmap: async () => heatmap(365),
  moduleTree: async () => [],
  changedFiles: async () => ({ files: [], totalInsertions: 0, totalDeletions: 0 }),
  gitMeta: async () => ({ kind: 'git', branch: 'master', head: 'abc1234', dirty: false }),
};

const ocr = {
  probe: async () => ({ available: true, version: 'v1.13.6', path: '/fake/ocr', error: null }),
  probeLlm: async () => ({ configured: false, provider: null, model: null, source: 'none', error: null }),
  preview: async () => ({
    ok: true,
    mode: 'review',
    files: [
      { path: 'index.js', insertions: 20, deletions: 2, status: 'modified', willReview: true },
    ],
    totalInsertions: 20,
    totalDeletions: 2,
    reviewable: 1,
    excluded: 0,
  }),
  runReview: async () => {
    throw new Error('ocr.runReview must not run in delegate mode');
  },
  llmTest: async () => ({ ok: false }),
};

const analyze = {
  analyzeArchitecture: async () => ({ findings: [], metrics: { files: 0 }, graph: null, summary: { headline: '', notes: [] }, activity: [] }),
  analyzeModule: async () => ({ findings: [], metrics: { files: 0 }, graph: null, summary: { headline: '', notes: [] }, activity: [] }),
  analyzeFlow: async () => ({ findings: [], metrics: { files: 0 }, graph: null, summary: { headline: '', notes: [] }, activity: [] }),
  analyzeDiff: async () => ({
    findings: [{ path: 'plugins/dsh-agent-cockpit/index.js', severity: 'low', category: 'style', title: '结构分析发现', content: '结构分析发现', startLine: 1, endLine: 1, rule: 'rule/test' }],
    metrics: { files: 1 }, graph: null, summary: { headline: '1 个文件', notes: [] }, activity: [],
  }),
};

const llmChunks = [
  { type: 'text-delta', index: 0, text: '{"findings":[{"path":"plugins/dsh-agent-cockpit/index.js","startLine":40,"endLine":52,"severity":"high","category":"security","title":"RPC 入口未校验请求体","content":"请求体直接进入 collector，缺少 schema 校验。","suggestionCode":"validate(body)"}],' },
  { type: 'text-delta', index: 0, text: '"projectSummary":"入口校验与错误码映射需要补强。"}' },
  { type: 'usage', usage: { inputTokens: 1200, outputTokens: 220 } },
  { type: 'finish', reason: { kind: 'stop' } },
];

let streamCalls = 0;
const llm = {
  async *stream() {
    streamCalls += 1;
    for (const chunk of llmChunks) yield chunk;
  },
};
const llmReviewer = createLlmReviewer({
  getLlm: () => llm,
  getSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

const config = normalizeConfig({
  projectRoots: [ROOT],
  defaultProjectPath: REPO,
  stateDir: STATE,
  engine: 'auto',
  ocr: { command: '/fake/ocr' },
});
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const store = createStore({ dir: STATE, maxJobs: 20, logger: () => logger });
let jobsApi = null;
const accessor = { list: () => jobsApi?.list() ?? [], get: (id) => jobsApi?.get(id) ?? null };
const snapshot = createSnapshot({
  config, store, jobs: accessor, git, ocr, analyze, logger,
  defaultProjectPath: REPO, getDelegateStatus: () => llmReviewer.status(),
});

function getEnginePlan() {
  const ocrLlm = snapshot.getLlmState();
  if (config.engine === 'structural') return { mode: 'structural' };
  if (ocrLlm.ocrConfigured) return { mode: 'ocr', llmConfigured: true };
  const delegate = llmReviewer.status();
  if (delegate.available) {
    return { mode: 'delegate', llmConfigured: true, provider: delegate.provider, model: delegate.model };
  }
  return { mode: 'structural' };
}

jobsApi = createJobs({
  config, env: process.env, store, logger, ocr, analyze, llmReviewer, getEnginePlan,
  projectResolver: (args) => snapshot.getProject(args),
  getLlmState: () => snapshot.getLlmState(),
});

await store.init();
await jobsApi.init();
await snapshot.init();

const snap = await snapshot.get({});
assert.equal(snap.health.llm.state, 'delegate');
assert.equal(snap.health.llm.provider, 'deepseek-account');
assert.equal(snap.config.enginePlan, 'delegate');

const job = jobsApi.start({ type: 'workspace', projectPath: REPO });
assert.equal(job.engine, 'delegate');
assert.equal(job.engineDetail.delegate, true);

const started = Date.now();
let finished = null;
while (Date.now() - started < 10_000) {
  const current = jobsApi.get(job.id);
  if (current && ['completed', 'failed'].includes(current.status)) {
    finished = current;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
}
assert.ok(finished, 'delegate job did not finish');
assert.equal(finished.status, 'completed', JSON.stringify(finished.error));
assert.equal(streamCalls >= 1, true, "the DSH model must be streamed at least once");
assert.equal(finished.engine, 'delegate');
assert.equal(finished.counts.findings, 2, 'one structural + one delegate finding');
assert.equal(finished.counts.bySeverity.high, 1);
assert.equal(finished.summary.projectSummary, '入口校验与错误码映射需要补强。');
assert.equal(finished.summary.coverage.reviewable, 1);
assert.equal(finished.stages.find((stage) => stage.key === 'ai').status, 'done');
assert.ok(finished.activity.some((event) => event.text.includes('DSH 模型评审')));

const detail = await jobsApi.getFull(job.id);
assert.ok(detail.findings.some((item) => item.source === 'ocr' && item.path.endsWith('index.js')));
assert.ok(detail.findings.some((finding) => finding.source === 'structural'));

jobsApi.dispose();
snapshot.dispose();
await store.flush();

console.log('delegate self-test passed:', {
  findings: finished.counts.findings,
  provider: finished.engineDetail.provider,
  model: finished.engineDetail.model,
  streamCalls,
});
