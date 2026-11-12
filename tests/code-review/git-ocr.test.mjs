#!/usr/bin/env node
/**
 * tests/code-review/git-ocr.test.mjs
 *
 * Self-check for the host git engine (`host/git.js`) and the OCR CLI adapter
 * (`host/ocr.js`). Runs as a plain Node script:
 *
 *   node tests/code-review/git-ocr.test.mjs
 *
 * The exit code is non-zero when any assertion fails. The suite touches real
 * local data only:
 *   - a real git repository (mopng-api, else prompt-hub) for gitMeta / heatmap /
 *     moduleTree / inspectProject
 *   - the installed `ocr` binary in `--preview` mode (never `ocr review`, which
 *     would need an LLM) plus `ocr --version`
 *
 * No network, no LLM call, and no writes outside `tests/code-review/.tmp/`.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  changedFiles, discoverProjects, gitHeatmap, gitMeta, inspectProject, moduleTree,
} from '../../host/git.js';
import {
  llmTest, preview, probe, probeLlm, runReview,
} from '../../host/ocr.js';
import { normalizeConfig } from '../../host/config.js';
import { addDays, dateKey } from '../../host/shared.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const TMP = join(HERE, '.tmp');
const PROJECT_TITLE = 'plugins/dsh-agent-cockpit';

// The workspace itself may be a git repository, so a non-git fixture must live
// outside it; tests that assert kind=dir / not-a-git-repo use this directory.
const NON_GIT = await mkdtemp(join(tmpdir(), 'ocr-nongit-'));
await mkdir(join(NON_GIT, 'src'), { recursive: true });
await writeFile(join(NON_GIT, 'src', 'a.js'), 'export const a = 1;\n');
await writeFile(join(NON_GIT, 'src', 'b.py'), 'def b():\n    return 2\n');
await writeFile(join(NON_GIT, 'README.md'), '# fixture\n');
await writeFile(join(NON_GIT, 'icon.svg'), '<svg/>\n');

const REPO_CANDIDATES = [
  join(homedir(), 'workspace', 'jkin8010', 'mopng-api'),
  join(homedir(), 'workspace', 'jkin8010', 'prompt-hub'),
];

const stats = { passed: 0, failed: 0, skipped: 0 };
const failures = [];

/** Small promise wrapper for the synthetic-repo fixture. */
function git(cwd, args) {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolvePromise(stdout);
    });
  });
}

function section(title) {
  console.log(`\n${title}`);
}

function skip(name, reason) {
  stats.skipped += 1;
  console.log(`  ○ ${name}（跳过：${reason}）`);
}

async function check(name, fn) {
  try {
    await fn();
    stats.passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    stats.failed += 1;
    failures.push({ name, error });
    const lines = String(error?.stack ?? error?.message ?? error).split('\n');
    console.log(`  ✗ ${name}\n    ${lines.join('\n    ')}`);
  }
}

function envWithoutLlm() {
  const env = { ...process.env };
  const keys = [
    'OCR_LLM_TOKEN', 'OCR_LLM_URL', 'OCR_LLM_MODEL', 'OCR_LLM_AUTH_HEADER',
    'OCR_LLM_EXTRA_HEADERS', 'OCR_LLM_PROTOCOL', 'OCR_LLM_TIMEOUT', 'OCR_USE_ANTHROPIC',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY',
  ];
  for (const key of keys) delete env[key];
  return env;
}

function isIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  const stateDir = join(TMP, 'state');
  const config = normalizeConfig({ stateDir }, { hostCwd: ROOT });
  const env = envWithoutLlm();

  const repo = REPO_CANDIDATES.find((candidate) => existsSync(join(candidate, '.git')));
  if (!repo) {
    console.error('未找到测试仓库：需要 ~/workspace/jkin8010/mopng-api 或 ~/workspace/jkin8010/prompt-hub');
    process.exitCode = 1;
    return;
  }

  console.log('dsh-code-review host self-check');
  console.log(`  仓库：${repo}`);
  console.log(`  临时目录：${TMP}`);
  console.log(`  ocr：${config.ocr.command || '（自动探测）'}`);

  // -------------------------------------------------------------------------
  section('gitMeta');
  // -------------------------------------------------------------------------
  await check('真实仓库返回 kind=git 与完整元信息', async () => {
    const meta = await gitMeta({ repoPath: repo });
    assert.equal(meta.kind, 'git');
    assert.equal(meta.error, null);
    assert.ok(meta.branch.length > 0, 'branch 不应为空');
    assert.match(meta.head, /^[0-9a-f]{7}$/);
    assert.ok(isIso(meta.committedAt), 'committedAt 必须是 ISO 时间');
    assert.equal(typeof meta.dirty, 'boolean');
    assert.equal(typeof meta.remote, 'string');
    assert.ok(isIso(meta.at));
  });

  await check('非 git 目录返回 kind=dir 且 error 为中文说明', async () => {
    const meta = await gitMeta({ repoPath: NON_GIT });
    assert.equal(meta.kind, 'dir');
    assert.ok(typeof meta.error === 'string' && meta.error.length > 0);
    assert.equal(meta.head, '');
    assert.equal(meta.committedAt, null);
  });

  // -------------------------------------------------------------------------
  section('gitHeatmap');
  // -------------------------------------------------------------------------
  await check('365 天热力图补齐每一天、提交总数与 max/streaks 自洽', async () => {
    const heatmap = await gitHeatmap({ repoPath: repo, days: 365 });
    assert.equal(heatmap.error, null);
    assert.equal(heatmap.days.length, 365);
    assert.equal(heatmap.to, dateKey(Date.now()));
    assert.equal(heatmap.from, addDays(heatmap.to, -364));
    assert.equal(heatmap.days[0].date, heatmap.from);
    assert.equal(heatmap.days.at(-1).date, heatmap.to);
    for (let index = 1; index < heatmap.days.length; index += 1) {
      assert.equal(heatmap.days[index].date, addDays(heatmap.days[index - 1].date, 1));
    }
    for (const day of heatmap.days) {
      assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(typeof day.commits, 'number');
      assert.equal(typeof day.insertions, 'number');
      assert.equal(typeof day.deletions, 'number');
    }
    assert.ok(heatmap.totalCommits > 0, '近一年应有提交');
    assert.ok(heatmap.max > 0, 'max 应大于 0');
    const summed = heatmap.days.reduce((sum, day) => sum + day.commits, 0);
    assert.equal(summed, heatmap.totalCommits);
    assert.equal(Math.max(...heatmap.days.map((day) => day.commits)), heatmap.max);
    assert.equal(heatmap.activeDays, heatmap.days.filter((day) => day.commits > 0).length);
    assert.ok(heatmap.streaks.longest > 0);
    assert.ok(heatmap.streaks.current >= 0);
    assert.ok(heatmap.busiest.date);
    assert.equal(heatmap.busiest.commits, heatmap.max);
    assert.ok(Array.isArray(heatmap.spark));
    assert.equal(heatmap.spark.length, 90);
    assert.ok(heatmap.spark.every((value) => typeof value === 'number' && value >= 0));
    assert.ok(isIso(heatmap.at));
  });

  await check('14 天窗口长度与无活动日零填充', async () => {
    const heatmap = await gitHeatmap({ repoPath: repo, days: 14 });
    assert.equal(heatmap.days.length, 14);
    assert.equal(heatmap.days[0].date, addDays(dateKey(Date.now()), -13));
    assert.equal(heatmap.spark.length, 14);
    const zeroFilled = heatmap.days.filter((day) => day.commits === 0);
    for (const day of zeroFilled) {
      assert.equal(day.insertions, 0);
      assert.equal(day.deletions, 0);
    }
  });

  await check('limit 限制最多读取的提交条数', async () => {
    const limited = await gitHeatmap({ repoPath: repo, days: 365, limit: 2 });
    assert.ok(limited.totalCommits > 0, '仓库近一年应有提交');
    assert.ok(limited.totalCommits <= 2, `limit=2 时最多 2 条提交，实际 ${limited.totalCommits}`);
  });

  await check('非 git 目录的热力图带 error 而不抛异常', async () => {
    const heatmap = await gitHeatmap({ repoPath: NON_GIT, days: 30 });
    assert.equal(heatmap.days.length, 30);
    assert.ok(typeof heatmap.error === 'string' && heatmap.error.length > 0);
    assert.equal(heatmap.totalCommits, 0);
  });

  // -------------------------------------------------------------------------
  section('moduleTree / inspectProject');
  // -------------------------------------------------------------------------
  await check('moduleTree 聚合顶层模块且按 files 降序', async () => {
    const modules = await moduleTree({ repoPath: repo, depth: 1 });
    assert.ok(Array.isArray(modules));
    assert.ok(modules.length > 0);
    for (const module of modules) {
      assert.match(module.id, /^m-[0-9a-f]{10}$/);
      assert.ok(module.name.length > 0);
      assert.ok(module.path.length > 0);
      assert.ok(module.files > 0);
      assert.ok(module.loc >= 0);
      assert.ok(module.lastCommitAt === null || isIso(module.lastCommitAt));
      assert.equal(typeof module.reviewCount, 'number');
      assert.ok(module.findings && typeof module.findings === 'object');
      assert.match(module.risk, /^(low|medium|high)$/);
    }
    for (let index = 1; index < modules.length; index += 1) {
      assert.ok(modules[index - 1].files >= modules[index].files, '模块应按 files 降序');
    }
  });

  await check('moduleTree depth=2 对 src/packages 布局取第二层目录', async () => {
    const layoutDir = join(TMP, 'layout-repo');
    await mkdir(join(layoutDir, 'src', 'agent', 'llm'), { recursive: true });
    await mkdir(join(layoutDir, 'packages', 'core', 'src'), { recursive: true });
    await writeFile(join(layoutDir, 'src', 'agent', 'llm', 'client.ts'), 'a\nb\n', 'utf8');
    await writeFile(join(layoutDir, 'src', 'agent', 'run.ts'), 'c\n', 'utf8');
    await writeFile(join(layoutDir, 'packages', 'core', 'src', 'index.js'), 'd\n', 'utf8');
    await writeFile(join(layoutDir, 'README.md'), 'e\n', 'utf8');
    await git(layoutDir, ['init', '-q', '-b', 'main', '.']);
    await git(layoutDir, ['add', '-A']);
    await git(layoutDir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'init']);

    const depth1 = await moduleTree({ repoPath: layoutDir, depth: 1 });
    const depth2 = await moduleTree({ repoPath: layoutDir, depth: 2 });
    assert.deepEqual(depth1.map((module) => module.path).sort(), ['agent', 'core']);
    assert.deepEqual(depth2.map((module) => module.path).sort(), ['agent', 'agent/llm', 'core/src']);
    const totalFiles = [...depth1, ...depth2].every((module) => module.files > 0);
    assert.equal(totalFiles, true);
  });

  await check('inspectProject 返回完整 ProjectView', async () => {
    const view = await inspectProject({ repoPath: repo, heatmapDays: 365 });
    assert.equal(view.kind, 'git');
    assert.equal(view.error, null);
    assert.match(view.id, /^p-[0-9a-f]{10}$/);
    assert.ok(view.name.length > 0);
    assert.equal(view.path, repo);
    assert.ok(view.fileCount > 0);
    assert.ok(view.moduleCount > 0);
    assert.ok(view.loc > 0);
    assert.ok(typeof view.language === 'string' && view.language.length > 0);
    assert.equal(view.heatmap.days.length, 365);
    assert.ok(Array.isArray(view.modules) && view.modules.length > 0);
    assert.ok(view.modules.length <= view.moduleCount);
    for (const module of view.modules) {
      assert.match(module.id, /^m-[0-9a-f]{10}$/);
      assert.ok(module.files > 0);
    }
    assert.equal(view.lastReviewAt, null);
    assert.equal(view.reviewCount, 0);
    assert.deepEqual(view.findings, { critical: 0, high: 0, medium: 0, low: 0, total: 0 });
    assert.ok(isIso(view.at));
  });

  await check('inspectProject light 跳过 LOC 但给出文件/模块数', async () => {
    const view = await inspectProject({ repoPath: repo, heatmapDays: 90, light: true });
    assert.equal(view.error, null);
    assert.equal(view.loc, null);
    assert.ok(view.fileCount > 0);
    assert.ok(view.moduleCount > 0);
    assert.equal(view.heatmap.days.length, 90);
    assert.ok(Array.isArray(view.modules));
    assert.equal(view.modules.length, 0);
  });

  await check('inspectProject 对非 git 目录返回空视图与 error', async () => {
    const view = await inspectProject({ repoPath: NON_GIT, heatmapDays: 30 });
    assert.equal(view.kind, 'dir');
    assert.ok(typeof view.error === 'string' && view.error.length > 0);
    assert.equal(view.fileCount, 0);
    assert.equal(view.loc, 0);
    assert.equal(view.heatmap.days.length, 30);
  });

  // -------------------------------------------------------------------------
  section('changedFiles / discoverProjects');
  // -------------------------------------------------------------------------
  await check('changedFiles commit 模式解析 numstat 与状态', async () => {
    const changes = await changedFiles({ repoPath: repo, mode: 'commit', commit: 'HEAD' });
    assert.equal(changes.error, null);
    assert.ok(changes.files.length > 0);
    for (const file of changes.files) {
      assert.ok(file.path.length > 0);
      assert.equal(typeof file.insertions, 'number');
      assert.equal(typeof file.deletions, 'number');
      assert.ok(typeof file.status === 'string' && file.status.length > 0);
    }
    assert.equal(changes.totalInsertions, changes.files.reduce((sum, file) => sum + file.insertions, 0));
    assert.equal(changes.totalDeletions, changes.files.reduce((sum, file) => sum + file.deletions, 0));
    assert.ok(isIso(changes.at));
  });

  await check('changedFiles range 模式使用 merge-base 对比', async () => {
    const changes = await changedFiles({ repoPath: repo, mode: 'range', from: 'HEAD~1', to: 'HEAD' });
    assert.equal(changes.error, null);
    assert.ok(changes.files.length > 0);
    assert.equal(changes.totalInsertions, changes.files.reduce((sum, file) => sum + file.insertions, 0));
    assert.equal(changes.totalDeletions, changes.files.reduce((sum, file) => sum + file.deletions, 0));
  });

  await check('changedFiles workspace 模式不抛异常且总计自洽', async () => {
    const changes = await changedFiles({ repoPath: repo, mode: 'workspace' });
    assert.equal(changes.error, null);
    assert.ok(Array.isArray(changes.files));
    assert.equal(changes.totalInsertions, changes.files.reduce((sum, file) => sum + file.insertions, 0));
    assert.equal(changes.totalDeletions, changes.files.reduce((sum, file) => sum + file.deletions, 0));
  });

  await check('changedFiles 无效 commit 返回结构化 error', async () => {
    const changes = await changedFiles({ repoPath: repo, mode: 'commit', commit: 'definitely-not-a-ref' });
    assert.ok(typeof changes.error === 'string' && changes.error.length > 0);
    assert.deepEqual(changes.files, []);
  });

  await check('discoverProjects 按 lastCommitAt 降序并支持 exclude', async () => {
    const roots = [dirname(repo)];
    const found = await discoverProjects({ roots, limit: 12 });
    assert.ok(Array.isArray(found));
    const entry = found.find((item) => item.path === repo);
    assert.ok(entry, `发现列表应包含 ${repo}`);
    assert.match(entry.id, /^p-[0-9a-f]{10}$/);
    assert.equal(entry.name, basename(repo));
    assert.ok(isIso(entry.lastCommitAt));
    assert.match(entry.head, /^[0-9a-f]{7}$/);
    assert.ok(entry.branch.length > 0);
    const timeOf = (item) => Date.parse(item.lastCommitAt ?? '') || 0;
    for (let index = 1; index < found.length; index += 1) {
      assert.ok(
        timeOf(found[index - 1]) >= timeOf(found[index]),
        '项目应按 lastCommitAt 降序（空仓库无提交，排在最后）',
      );
    }
    const excluded = await discoverProjects({ roots, exclude: [basename(repo)], limit: 12 });
    assert.ok(!excluded.some((item) => item.path === repo), 'exclude 应过滤掉该项目');
  });

  // -------------------------------------------------------------------------
  section('ocr probe / probeLlm');
  // -------------------------------------------------------------------------
  await check('probe 解析 open-code-review 版本', async () => {
    const result = await probe({ config, env });
    assert.equal(result.available, true);
    assert.equal(result.error, null);
    assert.match(result.version, /^v\d+\.\d+\.\d+$/);
    assert.ok(result.path.length > 0);
  });

  await check('probe 对缺失的 ocr 命令返回 available:false', async () => {
    const missingConfig = normalizeConfig(
      { stateDir, ocr: { command: '/definitely/missing/ocr-xyz' } },
      { hostCwd: ROOT },
    );
    const result = await probe({ config: missingConfig, env });
    assert.equal(result.available, false);
    assert.equal(result.version, '');
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  });

  await check('probeLlm 无配置时 configured:false 且不抛', async () => {
    const result = await probeLlm({ config, env });
    assert.equal(result.configured, false);
    assert.equal(result.source, 'none');
    assert.equal(result.error, null);
    assert.equal(result.provider, '');
    assert.equal(result.model, '');
  });

  await check('probeLlm 识别 OCR_LLM_* 环境变量且不回显 token', async () => {
    const token = 'selftest-token-value-0123456789';
    const result = await probeLlm({
      config,
      env: { ...env, OCR_LLM_TOKEN: token, OCR_LLM_URL: 'https://api.deepseek.com/v1' },
    });
    assert.equal(result.configured, true);
    assert.equal(result.source, 'env');
    assert.equal(result.provider, 'deepseek');
    assert.ok(!JSON.stringify(result).includes(token), 'token 不得出现在返回值中');
  });

  // -------------------------------------------------------------------------
  section('ocr preview');
  // -------------------------------------------------------------------------
  await check('ocr scan --preview 扫描 plugins/dsh-agent-cockpit', async () => {
    const plan = await preview({
      projectPath: NON_GIT,
      type: 'module',
      scope: { paths: ['src', 'README.md'] },
      config,
      env,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.mode, 'scan');
    assert.equal(plan.error, null);
    assert.ok(plan.files.length > 0);
    assert.ok(plan.reviewable > 0);
    assert.equal(typeof plan.totalInsertions, 'number');
    assert.equal(typeof plan.totalDeletions, 'number');
    assert.equal(plan.excluded, plan.files.filter((file) => !file.willReview).length);
    assert.ok(plan.files.some((file) => file.willReview === true));
    assert.ok(plan.files.some((file) => file.willReview === false && file.reason.length > 0));
    for (const file of plan.files) {
      assert.ok(file.path.length > 0);
      assert.equal(typeof file.insertions, 'number');
      assert.equal(typeof file.deletions, 'number');
      assert.equal(typeof file.willReview, 'boolean');
      assert.ok(typeof file.status === 'string' && file.status.length > 0);
    }
  });

  await check('preview 对非 git 目录的 review 返回 not-a-git-repo', async () => {
    const plan = await preview({ projectPath: NON_GIT, type: 'workspace', config, env });
    assert.equal(plan.ok, false);
    assert.equal(plan.error, 'not-a-git-repo');
    assert.deepEqual(plan.files, []);
  });

  await check('preview 在真实仓库上 review 成功', async () => {
    const plan = await preview({ projectPath: repo, type: 'workspace', config, env });
    assert.equal(plan.ok, true);
    assert.equal(plan.mode, 'review');
    assert.equal(plan.error, null);
    assert.ok(Array.isArray(plan.files));
  });

  await check('preview 对不存在的项目路径返回 invalid-path', async () => {
    const plan = await preview({
      projectPath: join(TMP, 'definitely-missing-project'),
      type: 'workspace',
      config,
      env,
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.error, 'invalid-path');
  });

  await check('preview 缺 ocr 命令时返回 ocr-missing', async () => {
    const missingConfig = normalizeConfig(
      { stateDir, ocr: { command: '/definitely/missing/ocr-xyz' } },
      { hostCwd: ROOT },
    );
    const plan = await preview({ projectPath: repo, type: 'workspace', config: missingConfig, env });
    assert.equal(plan.ok, false);
    assert.equal(plan.error, 'ocr-missing');
  });

  // -------------------------------------------------------------------------
  section('runReview preflight');
  // -------------------------------------------------------------------------
  await check('runReview 缺 ocr 命令时分类为 ocr-missing', async () => {
    const missingConfig = normalizeConfig(
      { stateDir, ocr: { command: '/definitely/missing/ocr-xyz' } },
      { hostCwd: ROOT },
    );
    const run = await runReview({
      projectPath: repo,
      type: 'workspace',
      config: missingConfig,
      env,
      jobId: 'selftest-missing',
    });
    assert.equal(run.ok, false);
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'code-review/ocr-missing');
    assert.ok(run.rawOutputPath.endsWith(join('artifacts', 'selftest-missing.json')));
  });

  await check('runReview 对不存在的项目路径返回 git 分类错误', async () => {
    const run = await runReview({
      projectPath: join(TMP, 'definitely-missing-project'),
      type: 'workspace',
      config,
      env,
      jobId: 'selftest-missing-path',
    });
    assert.equal(run.ok, false);
    assert.equal(run.error.code, 'code-review/git');
  });

  await check('runReview 预先取消返回 cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await runReview({
      projectPath: repo,
      type: 'workspace',
      config,
      env,
      jobId: 'selftest-cancelled',
      signal: controller.signal,
    });
    assert.equal(run.ok, false);
    assert.equal(run.status, 'cancelled');
    assert.equal(run.error.code, 'cancelled');
  });


  // -------------------------------------------------------------------------
  section('ocr stub（本地桩，无网络 / 无 LLM）');
  // -------------------------------------------------------------------------
  const stubDir = join(TMP, 'stub');
  const stubPath = join(stubDir, 'ocr.cjs');
  await mkdir(stubDir, { recursive: true });
  const stubSource = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
};
if (args.includes('--version')) {
  process.stdout.write('open-code-review v9.9.9 stub\n');
  process.exit(0);
}
if (args[0] === 'llm' && args[1] === 'test') {
  process.stdout.write('Model: stub-model\n\u2713 Connection test successful\n');
  process.exit(0);
}
if (args.includes('--stub-sleep')) {
  setInterval(() => {}, 1000);
  return;
}
// Emulate the real CLI: --effort and --background-file exist on review only.
if (args[0] === 'scan' && (args.includes('--effort') || args.includes('--background-file'))) {
  process.stderr.write('Error: unknown flag: ' + (args.includes('--effort') ? '--effort' : '--background-file') + '\n');
  process.exit(1);
}
if (args.includes('--preview')) {
  process.stdout.write(JSON.stringify({
    files: [
      { path: 'a.js', status: 'modified', insertions: 3, deletions: 1, will_review: true },
      { path: 'big.js', status: 'modified', insertions: 9, deletions: 0, will_review: false, exclude_reason: 'too_large' },
    ],
    total_insertions: 12, total_deletions: 1, total_files: 2, reviewable_count: 1, excluded_count: 1,
  }));
  process.exit(0);
}
const outputPath = valueOf('--output');
const backgroundPath = valueOf('--background-file');
const rulePath = valueOf('--rule');
const background = backgroundPath ? fs.readFileSync(backgroundPath, 'utf8') : valueOf('--background');
let ruleCount = 0;
if (rulePath) {
  const parsed = JSON.parse(fs.readFileSync(rulePath, 'utf8'));
  ruleCount = Array.isArray(parsed.rules) ? parsed.rules.length : 0;
}
const seen = ['--effort', '--concurrency', '--timeout', '--max-tokens', '--max-tokens-budget', '--audience', '--format', '--color']
  .map((name) => name + '=' + valueOf(name))
  .join(',');
const lines = [
  '[ocr] 2 file(s) changed, reviewing 2 in ' + valueOf('--repo'),
  '[ocr] Skipping LLM grouping for 2 file(s), 4 changed line(s) — reviewing per file',
  '[ocr] Plan completed for group "a.js"',
  '[ocr] Group "a.js" reached 2 confirmed findings; skipping further rounds',
  '[ocr] Review filter removed 1 comment(s) for group "a.js"',
  '[ocr] Plan completed for group "b.js"',
  '[ocr] Round 1/3 added no new findings for group "b.js"',
  '[ocr] Subtask error for group "b.js": boom',
  '[ocr] WARNING: stub warning',
  '[ocr] Session: sess-123',
];
for (const line of lines) process.stderr.write(line + '\n');
const result = {
  status: 'success',
  summary: { files_reviewed: 2, comments: 1, total_tokens: 1234, input_tokens: 1000, output_tokens: 234, elapsed: '1m5s' },
  comments: [{
    path: 'a.js', content: '空指针风险', start_line: 12, end_line: 14,
    category: 'bug', severity: 'high',
    suggestion_code: 'if (!x) return;', existing_code: 'x.y', thinking: '检查为空',
  }],
  warnings: [{ type: 'stub_warning', file: 'a.js', message: '来自 JSON 的警告' }],
  project_summary: 'background=' + background.trim() + '|rules=' + ruleCount + '|exclude=' + valueOf('--exclude') + '|path=' + valueOf('--path') + '|flags=' + seen,
  session_id: 'sess-123',
  llm: { provider: 'stub', model: 'stub-model' },
  manifest: { schema_version: 'v1', run_id: 'run-1' },
};
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
process.exit(0);
`;
  await writeFile(stubPath, stubSource, 'utf8');
  await chmod(stubPath, 0o755);

  const stubConfig = normalizeConfig(
    {
      stateDir,
      ocr: {
        command: stubPath,
        provider: 'stub',
        model: 'stub-model',
        effort: 'medium',
        concurrency: 8,
        timeoutMin: 15,
      },
    },
    { hostCwd: ROOT },
  );
  const artifactsDir = join(stateDir, 'artifacts');

  await check('probe / llmTest 在本地桩上工作（probe 优先 config.ocr.bin）', async () => {
    const pinnedConfig = {
      ...stubConfig,
      ocr: { ...stubConfig.ocr, bin: stubPath, command: '/definitely/missing/ocr-xyz' },
    };
    const probeResult = await probe({ config: pinnedConfig, env });
    assert.equal(probeResult.available, true);
    assert.equal(probeResult.version, 'v9.9.9');
    assert.equal(probeResult.error, null);
    const testResult = await llmTest({ config: stubConfig, env });
    assert.equal(testResult.ok, true);
    assert.equal(testResult.error, null);
    assert.ok(testResult.message.includes('stub-model'));
    assert.ok(testResult.latencyMs >= 0);
  });

  await check('runReview 成功路径：参数、评论归一化、进度、warnings、artifacts', async () => {
    const progressEvents = [];
    const events = [];
    const run = await runReview({
      projectPath: repo,
      type: 'workspace',
      config: stubConfig,
      env,
      jobId: 'stub-success',
      background: '背景上下文',
      rules: { rules: [{ path: '**', rule: '检查空指针', merge_system_rule: true }] },
      exclude: '**/*.map',
      onProgress: (progress) => progressEvents.push(progress),
      onEvent: (event) => events.push(event),
    });

    assert.equal(run.ok, true);
    assert.equal(run.status, 'success');
    assert.equal(run.error, null);
    assert.equal(run.comments.length, 1);
    assert.deepEqual(run.comments[0], {
      path: 'a.js',
      content: '空指针风险',
      start_line: 12,
      end_line: 14,
      category: 'bug',
      severity: 'high',
      suggestion_code: 'if (!x) return;',
      existing_code: 'x.y',
      thinking: '检查为空',
    });
    assert.deepEqual(run.summary, {
      filesReviewed: 2,
      comments: 1,
      totalTokens: 1234,
      inputTokens: 1000,
      outputTokens: 234,
      elapsed: 65_000,
    });
    assert.equal(run.sessionId, 'sess-123');
    assert.deepEqual(run.manifest, { schema_version: 'v1', run_id: 'run-1' });
    assert.deepEqual(run.llm, { provider: 'stub', model: 'stub-model' });
    assert.ok(run.projectSummary.includes('background=背景上下文'));
    assert.ok(run.projectSummary.includes('rules=1'));
    assert.ok(run.projectSummary.includes('exclude=**/*.map'));
    for (const flag of [
      '--effort=medium', '--concurrency=8', '--timeout=15',
      '--audience=human', '--format=json', '--color=never',
    ]) {
      assert.ok(run.projectSummary.includes(flag), `缺少参数 ${flag}`);
    }
    assert.ok(run.warnings.some((item) => item.type === 'stub_warning'));
    assert.ok(run.warnings.some((item) => item.type === 'warning'));
    assert.ok(run.warnings.some((item) => item.type === 'subtask_error' && item.file === 'b.js'));

    assert.ok(existsSync(run.rawOutputPath), '结果 JSON 必须落盘');
    const logPath = join(artifactsDir, 'stub-success.log');
    assert.ok(existsSync(logPath), 'stderr 全文必须落盘');
    const log = await readFile(logPath, 'utf8');
    assert.ok(log.includes('Session: sess-123'));
    assert.ok(log.includes('WARNING: stub warning'));
    assert.ok(Array.isArray(run.stderrTail));
    assert.ok(run.stderrTail.length <= 200);
    assert.ok(run.stderrTail.some((line) => line.includes('Session: sess-123')));

    assert.ok(progressEvents.length > 0, '应产生进度事件');
    for (const progress of progressEvents) {
      assert.ok(progress.fraction >= 0 && progress.fraction <= 1);
      assert.ok(typeof progress.detail === 'string' && progress.detail.length > 0);
      assert.ok(typeof progress.phase === 'string' && progress.phase.length > 0);
    }
    assert.ok(progressEvents.some((progress) => progress.findings > 0));
    assert.ok(events.some((event) => event.level === 'warn'));
    assert.ok(events.some((event) => event.level === 'error'));
    assert.ok(events.every((event) => !event.text.startsWith('[ocr]')));

    const leftovers = await readdir(artifactsDir);
    assert.ok(!leftovers.some((name) => name.endsWith('.rule.json')), '规则临时文件应清理');
    assert.ok(!leftovers.some((name) => name.endsWith('.background.md')), '背景临时文件应清理');
  });

  await check('runReview scan 使用 plan.files 作为 --path', async () => {
    const run = await runReview({
      projectPath: repo,
      type: 'architecture',
      scope: {},
      plan: {
        files: [
          { path: 'src/a.js', willReview: true },
          { path: 'src/b.js', willReview: true },
          { path: 'node_modules/big.js', willReview: false },
        ],
      },
      config: stubConfig,
      env,
      jobId: 'stub-scan',
      background: '扫描背景上下文',
    });
    assert.equal(run.ok, true);
    assert.ok(run.projectSummary.includes('path=src/a.js,src/b.js'));
    assert.ok(run.projectSummary.includes('background=扫描背景上下文'), 'scan 应通过 --background 内联传递背景');
    assert.ok(run.projectSummary.includes('--effort='), 'scan 不应传 --effort 的值，桩会在传入时报错');
  });

  await check('runReview 超时分类为 timeout', async () => {
    const slowConfig = normalizeConfig(
      { stateDir, ocr: { command: stubPath, extraArgs: ['--stub-sleep'] } },
      { hostCwd: ROOT },
    );
    const startedAt = Date.now();
    const run = await runReview({
      projectPath: repo,
      type: 'workspace',
      config: slowConfig,
      env,
      jobId: 'stub-timeout',
      timeoutMs: 500,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(run.ok, false);
    assert.equal(run.error.code, 'code-review/timeout');
    assert.ok(elapsed >= 400 && elapsed < 10_000, `超时耗时异常：${elapsed}ms`);
    assert.ok(existsSync(join(artifactsDir, 'stub-timeout.log')));
  });

  await check('runReview 运行中取消返回 cancelled 并终止子进程', async () => {
    const slowConfig = normalizeConfig(
      { stateDir, ocr: { command: stubPath, extraArgs: ['--stub-sleep'] } },
      { hostCwd: ROOT },
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);
    const startedAt = Date.now();
    const run = await runReview({
      projectPath: repo,
      type: 'workspace',
      config: slowConfig,
      env,
      jobId: 'stub-cancel',
      signal: controller.signal,
    });
    assert.equal(run.ok, false);
    assert.equal(run.status, 'cancelled');
    assert.equal(run.error.code, 'cancelled');
    assert.ok(Date.now() - startedAt < 10_000, '取消应在 2s SIGKILL 宽限内返回');
  });

  // -------------------------------------------------------------------------
  const total = stats.passed + stats.failed;
  console.log(`\n${'-'.repeat(56)}`);
  console.log(`通过 ${stats.passed}/${total}${stats.skipped ? `，跳过 ${stats.skipped}` : ''}`);
  if (stats.failed > 0) {
    console.log(`失败 ${stats.failed}：`);
    for (const failure of failures) {
      console.log(`  - ${failure.name}`);
    }
    process.exitCode = 1;
  } else {
    console.log('全部断言通过 ✓');
    process.exitCode = 0;
  }
}

main().catch((error) => {
  console.error('测试脚本异常退出：');
  console.error(error);
  process.exitCode = 1;
});
