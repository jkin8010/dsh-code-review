import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative } from 'node:path';
import { readProjectFile, walkSourceFiles } from './files.js';
import { promisify } from 'node:util';
import {
  CATEGORIES, SEVERITIES, clamp01, countFindings, dateKey, errorText, finding,
  findingKey, hash, maxSeverity, moduleOfPath, nowIso, pct, severityRank, trimText,
} from './shared.js';
import {
  buildBackground, buildRules, buildScanAnchorPaths, buildSummaryNotes, buildTitle,
} from './prompts.js';

const execFileAsync = promisify(execFile);

/**
 * Review job engine.
 *
 * A job is a durable state machine with six stages; every stage writes into the
 * job object the Web page polls. Two engines feed the same finding shape:
 *
 *  - `structural` — local analysis (host/analyze.js), always available;
 *  - `ocr`        — alibaba/open-code-review (`ocr review` / `ocr scan`), which
 *                   needs an LLM provider and is skipped, never faked, when the
 *                   engine is not configured.
 *
 * The engine never throws across the RPC boundary: failures settle into
 * `status:'failed'` with an actionable error, and partial findings survive.
 */

const TYPES = new Set(['workspace', 'commit', 'range', 'architecture', 'module', 'flow']);
const STAGE_WEIGHTS = { resolve: 5, plan: 10, structure: 25, ai: 50, merge: 5, report: 5 };
const STAGE_LABELS = {
  resolve: '解析项目',
  plan: '选取文件',
  structure: '结构分析',
  ai: 'AI 评审',
  merge: '归并去重',
  report: '生成报告',
};
const STAGE_ORDER = {
  workspace: ['resolve', 'plan', 'structure', 'ai', 'merge', 'report'],
  commit: ['resolve', 'plan', 'structure', 'ai', 'merge', 'report'],
  range: ['resolve', 'plan', 'structure', 'ai', 'merge', 'report'],
  module: ['resolve', 'plan', 'structure', 'ai', 'merge', 'report'],
  architecture: ['resolve', 'structure', 'plan', 'ai', 'merge', 'report'],
  flow: ['resolve', 'structure', 'plan', 'ai', 'merge', 'report'],
};
function randomId() {
  return randomBytes(4).toString('hex');
}

function jobId() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `rv-${stamp}-${randomId()}`;
}

function safeRef(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length > 120) return '';
  // Refs may contain / ~ ^ - . _ but nothing shell-ish; ocr validates again.
  return /^[A-Za-z0-9._\-\/~^@{}]+$/.test(text) ? text : '';
}

function relativeSafe(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!text || text.length > 300) return '';
  if (text.split('/').some((part) => part === '..')) return '';
  return text;
}

export function createJobs({
  config, env, store, logger, ocr, analyze, projectResolver,
  getLlmState, getEnginePlan, llmReviewer,
} = {}) {
  const jobs = new Map();
  const ocrEnv = () => (typeof env === 'function' ? env() : env);
  let disposed = false;
  let concurrency = 1;
  const active = new Set();

  const log = (level, message) => {
    try {
      const sink = logger?.[level] ?? logger?.info;
      sink?.call?.(logger, message);
    } catch {
      /* logging never breaks a review */
    }
  };

  function stageList(type, enginePlan) {
    const order = STAGE_ORDER[type] ?? STAGE_ORDER.workspace;
    return order.map((key) => {
      let status = 'pending';
      let detail = '';
      if (key === 'ai' && enginePlan === 'structural') {
        status = 'skipped';
        detail = '离线结构分析模式';
      }
      return {
        key,
        label: STAGE_LABELS[key],
        status,
        startedAt: null,
        finishedAt: null,
        detail,
      };
    });
  }

  function stageWeight(job) {
    const enabled = (job.stages ?? []).filter((stage) => stage.status !== 'skipped');
    const total = enabled.reduce((sum, stage) => sum + (STAGE_WEIGHTS[stage.key] ?? 5), 0);
    return { enabled, total: total || 1 };
  }

  function recomputeProgress(job) {
    const { enabled, total } = stageWeight(job);
    let done = 0;
    for (const stage of enabled) {
      const weight = STAGE_WEIGHTS[stage.key] ?? 5;
      if (stage.status === 'done' || stage.status === 'failed') done += weight;
      else if (stage.status === 'running') done += weight * clamp01(job._stageFraction ?? 0);
    }
    job.progress = Math.round(clamp01(done / total) * 1000) / 1000;
    const current = enabled.find((stage) => stage.status === 'running')
      ?? enabled.find((stage) => stage.status === 'pending')
      ?? enabled[enabled.length - 1];
    if (current) {
      const index = enabled.indexOf(current);
      job.stage = { key: current.key, label: current.label, index, total: enabled.length };
    }
  }

  function setStage(job, key, status, detail) {
    const stage = (job.stages ?? []).find((item) => item.key === key);
    if (!stage) return;
    stage.status = status;
    if (status === 'running') {
      stage.startedAt = stage.startedAt ?? nowIso();
      job._stageFraction = 0;
    }
    if (status === 'done' || status === 'failed' || status === 'skipped') {
      stage.finishedAt = nowIso();
      if (detail !== undefined) stage.detail = detail;
      job._stageFraction = 1;
    } else if (detail !== undefined) {
      stage.detail = detail;
    }
    job.stage = { key, label: stage.label, index: 0, total: 1 };
    recomputeProgress(job);
    store.saveJob(job);
  }

  function setFraction(job, fraction) {
    job._stageFraction = clamp01(fraction);
    recomputeProgress(job);
  }

  function logEvent(job, level, text, { global = false } = {}) {
    const event = { ts: nowIso(), level, text: trimText(text, 400) };
    job.activity = Array.isArray(job.activity) ? job.activity : [];
    job.activity.push(event);
    if (job.activity.length > 60) job.activity = job.activity.slice(-60);
    if (global) {
      store.appendActivity({
        id: `a-${hash(`${job.id}-${event.ts}-${text}`, 10)}`,
        ts: event.ts,
        kind: 'review',
        level,
        text: `${job.projectName ?? ''} · ${text}`,
        jobId: job.id,
        projectId: job.projectId ?? null,
        type: job.type,
      });
    }
    return event;
  }

  async function readDiffText(repoPath, type, scope) {
    const args = ['diff', '--no-color', '--unified=1'];
    if (type === 'commit') args.push(`${safeRef(scope.commit)}^!`);
    else if (type === 'range') args.push(`${safeRef(scope.from)}...${safeRef(scope.to)}`);
    else args.push('--', '.');
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: repoPath, maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
      });
      return stdout;
    } catch (error) {
      log('warn', `git diff failed: ${errorText(error)}`);
      return '';
    }
  }

  function mergeFindings(job, lists) {
    const seen = new Map();
    const merged = [];
    for (const list of lists) {
      for (const raw of list ?? []) {
        const item = finding(raw);
        if (!item.path) continue;
        const key = item.fingerprint
          ?? `${item.path}\u0000${item.startLine}\u0000${item.title.toLowerCase()}`;
        const existing = seen.get(key);
        if (existing) {
          // Same issue reported by both engines: keep the AI wording, but note
          // that the deterministic pass agreed, which raises confidence.
          if (item.source === 'ocr' && existing.source !== 'ocr') {
            merged[merged.indexOf(existing)] = item;
            seen.set(key, item);
          }
          continue;
        }
        seen.set(key, item);
        merged.push(item);
      }
    }
    merged.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)
      || String(a.path).localeCompare(String(b.path))
      || (a.startLine ?? 0) - (b.startLine ?? 0));
    return merged;
  }

  function computeCounts(job, findingsList) {
    const bySeverity = countFindings(findingsList);
    const byCategory = {};
    for (const item of findingsList) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    const modules = new Set(findingsList.map((item) => item.module).filter(Boolean));
    return {
      filesPlanned: job.counts?.filesPlanned ?? 0,
      filesReviewed: job.counts?.filesReviewed ?? 0,
      findings: findingsList.length,
      bySeverity,
      byCategory,
      tokens: job.counts?.tokens ?? 0,
      modules: modules.size,
    };
  }

  function syncResolvedCount(job) {
    const keys = new Set(Object.keys(job?.resolutions ?? {}));
    job.resolvedCount = keys.size;
    return keys.size;
  }

  function scopeKey(job) {
    const scope = job?.scope ?? {};
    const parts = [];
    if (Array.isArray(scope.paths)) parts.push(`paths:${[...scope.paths].sort().join(',')}`);
    if (scope.commit) parts.push(`commit:${scope.commit}`);
    if (scope.from || scope.to) parts.push(`range:${scope.from ?? ''}..${scope.to ?? ''}`);
    if (scope.flowName) parts.push(`flow:${scope.flowName}`);
    return parts.join('|');
  }

  /**
   * When a newer review of the same project/scope no longer reports an old
   * finding, mark the old report entry as fixed. Conservative: only the same
   * review type and the same scope participate, and existing marks are kept.
   */
  async function reconcilePreviousFixes(job) {
    const currentKeys = new Set((job.findings ?? []).map(findingKey));
    const previous = api.list()
      .filter((item) => item.id !== job.id
        && item.status === 'completed'
        && item.projectPath === job.projectPath
        && item.type === job.type
        && scopeKey(item) === scopeKey(job))
      .slice(0, 2);
    for (const item of previous) {
      const full = await api.getFull(item.id).catch(() => null);
      if (!full || !Array.isArray(full.findings)) continue;
      full.resolutions = full.resolutions ?? {};
      let changed = false;
      for (const finding of full.findings) {
        const key = findingKey(finding);
        if (currentKeys.has(key) || full.resolutions[key]) continue;
        full.resolutions[key] = { status: 'fixed', at: nowIso(), auto: true };
        changed = true;
      }
      // Mark the verification as done even when nothing changed, so opening the
      // report again does not auto-run another recheck.
      full.fixVerifiedAt = nowIso();
      if (changed) syncResolvedCount(full);
      await store.persistNow(full);
    }
  }

  async function finish(job, { status, error = null, message = '' } = {}) {
    job.status = status;
    job.finishedAt = nowIso();
    job.durationMs = job.startedAt
      ? Math.max(0, new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime())
      : 0;
    job.progress = 1;
    if (error) job.error = error;
    if (message) job.message = message;
    for (const stage of job.stages ?? []) {
      if (stage.status === 'running') {
        stage.status = status === 'failed' ? 'failed' : 'done';
        stage.finishedAt = job.finishedAt;
        stage.detail = stage.detail || (status === 'failed' ? trimText(job.error?.message ?? '', 80) : '');
      }
    }
    const findingsList = job._findings ?? [];
    job.counts = computeCounts(job, findingsList);
    job.summary = {
      ...(job.summary ?? {}),
      headline: job.summary?.headline ?? headlineFor(status, findingsList, message),
      notes: job.summary?.notes ?? [],
    };
    delete job._findings;
    delete job._stageFraction;
    delete job._cancel;
    delete job._controller;
    store.saveJob(job, { final: true });
    if (status === 'completed') {
      store.recordReview(job);
      void reconcilePreviousFixes(job).catch((cause) => log('warn', `fix reconciliation failed: ${errorText(cause)}`));
    }
    logEvent(job, status === 'completed' ? 'success' : 'error',
      status === 'completed'
        ? `评审完成：${job.counts.findings} 个问题 · ${job.counts.filesReviewed} 个文件`
        : `评审${status === 'cancelled' ? '已取消' : '失败'}：${trimText(job.error?.message ?? message, 160)}`,
      { global: true });
    store.saveJob(job, { final: true });
  }

  function headlineFor(status, findingsList, message) {
    if (status === 'cancelled') return message || '评审已取消';
    if (status === 'failed') return message || '评审未完成';
    if (message) return message;
    if (!findingsList.length) return '未发现问题，评审通过';
    const counts = countFindings(findingsList);
    const parts = [];
    if (counts.critical) parts.push(`${counts.critical} 严重`);
    if (counts.high) parts.push(`${counts.high} 高`);
    if (counts.medium) parts.push(`${counts.medium} 中`);
    if (counts.low) parts.push(`${counts.low} 低`);
    return `发现 ${counts.total} 个问题：${parts.join(' · ')}`;
  }

  async function runJob(job) {
    active.add(job.id);
    job.status = 'running';
    job.startedAt = nowIso();
    job._controller = new AbortController();
    job.stages = job.stages ?? stageList(job.type, job._enginePlan);
    store.saveJob(job);
    store.appendActivity({
      id: `a-${hash(`${job.id}-start`, 10)}`,
      ts: nowIso(),
      kind: 'review',
      level: 'info',
      text: `${job.projectName} · 开始${job.type}评审`,
      jobId: job.id,
      projectId: job.projectId,
      type: job.type,
    });

    try {
      const project = await runResolve(job);

      if (job.type === 'architecture' || job.type === 'flow') {
        await runStructureFirst(job, project);
        await runPlan(job, project);
      } else {
        await runPlan(job, project);
        if (job._shortCircuit) {
          await finish(job, { status: 'completed', message: job._shortCircuit });
          return;
        }
        await runStructure(job, project);
      }

      await runAi(job, project);
      await runMerge(job);
      await runReport(job);
      await finish(job, { status: 'completed' });
    } catch (error) {
      if (job._cancel || job._controller?.signal.aborted) {
        await finish(job, { status: 'cancelled', message: '评审已取消' });
      } else {
        log('warn', `review ${job.id} failed: ${errorText(error)}`);
        await finish(job, {
          status: 'failed',
          error: { code: error?.code ?? 'code-review/failed', message: errorText(error) },
          message: '评审失败',
        });
      }
    } finally {
      active.delete(job.id);
      delete job._controller;
      void drain();
    }
  }

  async function runResolve(job) {
    setStage(job, 'resolve', 'running');
    const project = await projectResolver({
      projectId: job.projectId,
      projectPath: job.projectPath,
    });
    if (!project) {
      const error = new Error('项目不存在或不可访问，请检查 projectRoots / defaultProjectPath');
      error.code = 'code-review/project-not-found';
      throw error;
    }
    job.projectId = project.id;
    job.projectName = project.name;
    job.projectPath = project.path;
    job.projectKind = project.kind;
    job._project = project;
    rememberProject(project);
    const resolvedTitle = buildTitle({ type: job.type, project, scope: job.scope ?? {} });
    job.title = resolvedTitle.title;
    job.subtitle = resolvedTitle.subtitle;
    if (project.kind !== 'git' && ['workspace', 'commit', 'range'].includes(job.type)) {
      const error = new Error(`项目 ${project.name} 不是 Git 仓库，${job.type} 评审需要 git 历史；可改用「项目架构」「代码模块」或「信息流」评审`);
      error.code = 'code-review/not-a-git-repo';
      throw error;
    }
    setStage(job, 'resolve', 'done', project.kind === 'git'
      ? `${project.branch ?? 'git'} · ${project.head ?? ''}`
      : '非 Git 目录 · 扫描模式');
    logEvent(job, 'info', `项目已就绪：${project.name}（${project.path}）`, { global: true });
    return project;
  }

  async function runPlan(job, project) {
    setStage(job, 'plan', 'running');
    const scope = job.scope ?? {};
    let plan = { files: [], totalInsertions: 0, totalDeletions: 0, reviewable: 0, excluded: 0, mode: '' };

    if (['workspace', 'commit', 'range', 'module'].includes(job.type)) {
      const preview = await ocr.preview({
        projectPath: project.path,
        type: job.type,
        scope,
        config,
        env: ocrEnv(),
      });
      if (preview?.ok) plan = preview;
      else {
        // A missing git repo is actionable; anything else may be an ocr
        // absence, in which case the structural pass still has value.
        if (preview?.error === 'not-a-git-repo' || /git/i.test(String(preview?.error))) {
          logEvent(job, 'warn', `文件选取降级：${trimText(String(preview?.error ?? ''), 120)}`);
        } else {
          logEvent(job, 'warn', `OCR 文件选取不可用（${trimText(String(preview?.error ?? '未知'), 100)}），改用本地文件选择`);
        }
        plan = await localPlan(job, project);
      }
    } else {
      // architecture / flow: the structural stage already produced anchors.
      const anchors = (job._analysis && job.type === 'architecture')
        ? (job._analysis.anchorPaths ?? [])
        : (job._flowAnchors ?? []);
      const existing = anchors.filter((path) => path && existsSync(join(project.path, path)));
      if (existing.length) {
        const preview = await ocr.preview({
          projectPath: project.path,
          type: 'scan',
          scope: { paths: existing },
          config,
          env: ocrEnv(),
        });
        if (preview?.ok) plan = preview;
      }
      if (!plan.files?.length) {
        plan = {
          files: existing.map((path) => ({ path, insertions: 0, deletions: 0, status: 'scan', willReview: true })),
          totalInsertions: 0, totalDeletions: 0,
          reviewable: existing.length, excluded: 0, mode: 'scan',
        };
      }
    }

    if (job._cancel) throw new Error('cancelled');
    const files = Array.isArray(plan.files) ? plan.files : [];
    job.plan = {
      files: files.slice(0, 500),
      totalInsertions: Number(plan.totalInsertions ?? 0),
      totalDeletions: Number(plan.totalDeletions ?? 0),
      reviewable: Number(plan.reviewable ?? files.filter((file) => file.willReview !== false).length),
      excluded: Number(plan.excluded ?? files.filter((file) => file.willReview === false).length),
      mode: plan.mode ?? '',
    };
    job.counts = job.counts ?? {};
    job.counts.filesPlanned = job.plan.reviewable;
    job.scope = scope;

    if (job.plan.reviewable === 0 && ['workspace', 'commit', 'range', 'module'].includes(job.type)) {
      job._shortCircuit = job.type === 'workspace'
        ? '工作区没有可评审的改动（staged / unstaged / untracked 均为空）'
        : '没有可评审的文件';
      setStage(job, 'plan', 'done', '0 个文件');
      return;
    }
    setStage(job, 'plan', 'done', `${job.plan.reviewable} 个文件 · +${job.plan.totalInsertions} -${job.plan.totalDeletions}`);
    logEvent(job, 'info', `已选取 ${job.plan.reviewable} 个文件（+${job.plan.totalInsertions} -${job.plan.totalDeletions}）`, { global: true });
  }

  async function localPlan(job, project) {
    const paths = job.type === 'module' ? (job.scope?.paths ?? []) : [];
    const files = await walkSourceFiles(project.path, { subPaths: paths, limit: 400 });
    return {
      files: files.map((path) => ({ path, insertions: 0, deletions: 0, status: 'scan', willReview: true })),
      totalInsertions: 0,
      totalDeletions: 0,
      reviewable: files.length,
      excluded: 0,
      mode: 'local-scan',
    };
  }

  async function runStructureFirst(job, project) {
    setStage(job, 'structure', 'running');
    const files = await walkSourceFiles(project.path);
    const readFile = (path) => readProjectFile(project.path, path);
    const analysis = job.type === 'architecture'
      ? await analyze.analyzeArchitecture({ project, files, readFile })
      : await analyze.analyzeFlow({ project, files, readFile });
    job._analysis = analysis;
    if (job.type === 'architecture') {
      analysis.anchorPaths = buildScanAnchorPaths('architecture', analysis, project);
    } else {
      job._flowAnchors = buildScanAnchorPaths('flow', analysis, project);
    }
    appendAnalysis(job, analysis);
    setStage(job, 'structure', 'done', summariseAnalysis(job.type, analysis));
    logEvent(job, 'info', `结构分析完成：${analysis?.summary?.headline ?? '完成'}`, { global: true });
  }

  async function runStructure(job, project) {
    setStage(job, 'structure', 'running');
    const files = (job.plan?.files ?? []).map((file) => file.path).filter(Boolean);
    const readFile = (path) => readProjectFile(project.path, path);
    let analysis;
    if (job.type === 'module') {
      const modulePath = (job.scope?.paths ?? [])[0] ?? '';
      analysis = await analyze.analyzeModule({ project, modulePath, files, readFile });
    } else if (job.type === 'architecture' || job.type === 'flow') {
      analysis = job._analysis;
    } else {
      const diffText = await readDiffText(project.path, job.type, job.scope ?? {});
      analysis = await analyze.analyzeDiff({ project, files, diffText, readFile });
      job._diffText = diffText;
    }
    job._analysis = job._analysis ?? analysis;
    appendAnalysis(job, analysis);
    setStage(job, 'structure', 'done', summariseAnalysis(job.type, analysis));
    logEvent(job, 'info', `结构分析完成：${analysis?.summary?.headline ?? '完成'}`);
  }

  function appendAnalysis(job, analysis) {
    if (analysis?.graph && !job.graph) job.graph = analysis.graph;
    const findingsList = (analysis?.findings ?? []).map((item) => finding({ ...item, source: 'structural' }));
    job._structuralFindings = findingsList;
    job._findings = [...(job._findings ?? []), ...findingsList];
    job.counts = job.counts ?? {};
    job.counts.filesReviewed = Math.max(job.counts.filesReviewed ?? 0, Number(analysis?.metrics?.files ?? 0));
    for (const event of analysis?.activity ?? []) {
      logEvent(job, event.level ?? 'info', event.text);
    }
  }

  function summariseAnalysis(type, analysis) {
    if (!analysis) return '';
    const graph = analysis.graph;
    if (type === 'architecture' && graph) {
      return `${(graph.nodes ?? []).length} 模块 · ${(graph.edges ?? []).length} 依赖 · ${(graph.cycles ?? []).length} 环`;
    }
    if (type === 'flow' && graph) {
      return `${(analysis.flows ?? []).length} 条链路 · ${(graph.nodes ?? []).length} 节点`;
    }
    return trimText(analysis.summary?.headline ?? '完成', 80);
  }

  async function runAi(job, project) {
    const stage = (job.stages ?? []).find((item) => item.key === 'ai');
    const mode = job._enginePlan;
    if (mode === 'structural') {
      if (stage) {
        stage.status = 'skipped';
        stage.detail = '离线结构分析模式';
        stage.finishedAt = nowIso();
      }
      job._stageFraction = 1;
      recomputeProgress(job);
      store.saveJob(job);
      logEvent(job, 'info', '配置为离线结构分析（engine=structural），已跳过模型评审');
      return;
    }
    if (mode === 'delegate') {
      await runAiDelegate(job, project, stage);
      return;
    }
    const llmConfigured = Boolean(job.engineDetail?.llmConfigured);
    if (!llmConfigured) {
      if (stage) {
        stage.status = 'skipped';
        stage.detail = '未配置 OCR LLM，仅执行离线结构分析';
        stage.finishedAt = nowIso();
      }
      job._stageFraction = 1;
      job.engine = 'structural';
      job.engineDetail = {
        ...(job.engineDetail ?? {}),
        ocr: false,
        delegate: false,
        engineMode: 'structural',
        llmConfigured: false,
        provider: null,
        model: null,
      };
      recomputeProgress(job);
      store.saveJob(job);
      logEvent(job, 'warn', '未检测到 OCR 的 LLM 配置，本次仅产出离线结构分析结果');
      return;
    }

    setStage(job, 'ai', 'running');
    const background = buildBackground({
      type: job.type,
      project,
      scope: job.scope ?? {},
      analysis: job._analysis,
      userBackground: job.options?.background,
      diff: job.plan,
    });
    const rules = buildRules({ type: job.type, scope: job.scope });
    const options = job.options ?? {};
    const runConfig = {
      ...config,
      ocr: {
        ...config.ocr,
        ...(options.effort ? { effort: options.effort } : {}),
        ...(Number(options.maxTokensBudget) > 0 ? { maxTokensBudget: Number(options.maxTokensBudget) } : {}),
      },
    };
    const result = await ocr.runReview({
      jobId: job.id,
      projectPath: project.path,
      type: job.type,
      scope: job.scope ?? {},
      plan: job.plan,
      config: runConfig,
      env: ocrEnv(),
      background,
      rules,
      exclude: options.exclude ?? '',
      signal: job._controller?.signal,
      onEvent: (event) => logEvent(job, event.level ?? 'info', event.text ?? ''),
      onProgress: (progress) => {
        if (job._cancel) return;
        setFraction(job, progress?.fraction ?? 0);
        if (progress?.fraction) {
          const stage2 = (job.stages ?? []).find((item) => item.key === 'ai');
          if (stage2 && progress.detail) stage2.detail = progress.detail;
          store.saveJob(job);
        }
      },
    });

    if (job._cancel) throw new Error('cancelled');
    if (!result?.ok) {
      const failure = new Error(result?.error?.message ?? 'OCR 评审失败');
      failure.code = result?.error?.code ?? 'code-review/ocr-failed';
      if (failure.code === 'code-review/llm-unconfigured') {
        // Degrade instead of failing: the structural findings are still useful.
        if (stage) {
          stage.status = 'skipped';
          stage.detail = 'OCR LLM 未配置';
          stage.finishedAt = nowIso();
        }
        job.summary = job.summary ?? {};
        job.summary.notes = [...(job.summary.notes ?? []), 'OCR 的 LLM 未配置，AI 评审已跳过；离线结构分析结果仍然有效。'];
        job.engineDetail = { ...(job.engineDetail ?? {}), ocr: false };
        recomputeProgress(job);
        store.saveJob(job);
        logEvent(job, 'warn', 'OCR LLM 未配置，已跳过 AI 评审');
        return;
      }
      throw failure;
    }

    const ocrFindings = (result.comments ?? []).map((comment) => finding(comment));
    job._findings = [...(job._findings ?? []), ...ocrFindings];
    job._ocrResult = result;
    job.counts = job.counts ?? {};
    job.counts.filesReviewed = Math.max(
      Number(job.counts.filesReviewed ?? 0),
      Number(result.summary?.filesReviewed ?? 0),
    );
    job.counts.tokens = Number(result.summary?.totalTokens ?? 0);
    if (result.sessionId) job.artifacts = { ...(job.artifacts ?? {}), ocrSessionId: result.sessionId };
    if (result.rawOutputPath) job.artifacts = { ...(job.artifacts ?? {}), rawOutputPath: result.rawOutputPath };
    if (result.summary?.elapsed) job.engineDetail.elapsed = result.summary.elapsed;
    if (result.llm) job.engineDetail.llm = result.llm;
    setStage(job, 'ai', 'done', `${Number(result.summary?.filesReviewed ?? 0)} 文件 · ${ocrFindings.length} 条 AI 发现`);
    logEvent(job, 'success', `AI 评审完成：${ocrFindings.length} 条发现`, { global: true });
  }

  async function runAiDelegate(job, project, stage) {
    if (!llmReviewer) {
      if (stage) {
        stage.status = 'skipped';
        stage.detail = 'DSH 模型服务不可用，已跳过模型评审';
        stage.finishedAt = nowIso();
      }
      job.engine = 'structural';
      job.engineDetail = {
        ...(job.engineDetail ?? {}),
        delegate: false,
        engineMode: 'structural',
        llmConfigured: false,
        provider: null,
        model: null,
      };
      job.summary = job.summary ?? {};
      job.summary.notes = [...(job.summary.notes ?? []), 'DSH 模型评审不可用，已保留离线结构分析结果。'];
      recomputeProgress(job);
      store.saveJob(job);
      return;
    }

    setStage(job, 'ai', 'running');
    const background = buildBackground({
      type: job.type,
      project,
      scope: job.scope ?? {},
      analysis: job._analysis,
      userBackground: job.options?.background,
      diff: job.plan,
    });
    const rules = buildRules({ type: job.type, scope: job.scope });
    const result = await llmReviewer.run({
      project,
      type: job.type,
      scope: job.scope ?? {},
      plan: job.plan,
      diffText: job._diffText,
      background,
      rules,
      signal: job._controller?.signal,
      onEvent: (event) => logEvent(job, event.level ?? 'info', event.text ?? ''),
      onProgress: (progress) => {
        if (job._cancel) return;
        setFraction(job, progress?.fraction ?? 0);
        const current = (job.stages ?? []).find((item) => item.key === 'ai');
        if (current && progress?.detail) current.detail = progress.detail;
        store.saveJob(job);
      },
    });

    if (job._cancel) throw new Error('cancelled');
    if (!result?.ok) {
      if (result?.error?.code === 'code-review/cancelled') throw new Error('cancelled');
      if (stage) {
        stage.status = 'skipped';
        stage.detail = `DSH 模型评审不可用：${trimText(result?.error?.message ?? '未知错误', 80)}`;
        stage.finishedAt = nowIso();
      }
      job.engine = 'structural';
      job.engineDetail = {
        ...(job.engineDetail ?? {}),
        delegate: false,
        engineMode: 'structural',
        llmConfigured: false,
        provider: null,
        model: null,
      };
      job.summary = job.summary ?? {};
      job.summary.notes = [...(job.summary.notes ?? []), `DSH 模型评审未完成（${trimText(result?.error?.message ?? '未知错误', 120)}），已保留离线结构分析结果。`];
      recomputeProgress(job);
      store.saveJob(job);
      logEvent(job, 'warn', `DSH 模型评审降级为结构分析：${trimText(result?.error?.message ?? '未知错误', 120)}`);
      return;
    }

    const comments = (result.comments ?? []).map((comment) => finding(comment));
    job._findings = [...(job._findings ?? []), ...comments];
    job._delegateResult = result;
    job.counts = job.counts ?? {};
    job.counts.filesReviewed = Math.max(Number(job.counts.filesReviewed ?? 0), Number(result.summary?.filesReviewed ?? 0));
    job.counts.tokens = Number(result.summary?.totalTokens ?? 0);
    if (result.llm) {
      job.engineDetail = { ...(job.engineDetail ?? {}), provider: result.llm.provider, model: result.llm.model, delegate: true };
    }
    if (result.warnings?.length) {
      job.summary = job.summary ?? {};
      job.summary.notes = [...(job.summary.notes ?? []), `DSH 模型评审有 ${result.warnings.length} 条告警：${trimText(result.warnings[0]?.message ?? '', 120)}`];
    }
    setStage(job, 'ai', 'done', `${result.summary?.filesReviewed ?? 0} 文件 · ${comments.length} 条发现 · DSH 模型评审`);
    logEvent(job, 'success', `DSH 模型评审完成：${comments.length} 条发现`, { global: true });
  }

  async function runMerge(job) {
    setStage(job, 'merge', 'running');
    const merged = mergeFindings(job, [job._findings ?? []]);
    job._findings = merged;
    job.findings = merged;
    job.counts = computeCounts(job, merged);
    setStage(job, 'merge', 'done', `${merged.length} 条问题（去重后）`);
  }

  async function runReport(job) {
    setStage(job, 'report', 'running');
    const findingsList = job._findings ?? [];
    const counts = countFindings(findingsList);
    const ocrResult = job._ocrResult;
    const touchedModules = [...new Set([
      ...findingsList.map((item) => item.module).filter(Boolean),
      ...(job.scope?.paths ?? []).map((path) => moduleOfPath(path)).filter(Boolean),
      ...job._analysis?.graph?.nodes?.map((node) => node.label).filter(Boolean) ?? [],
    ])].slice(0, 40);
    job.summary = {
      headline: headlineFor('completed', findingsList, ''),
      projectSummary: trimText(ocrResult?.projectSummary ?? job._delegateResult?.projectSummary ?? job._analysis?.summary?.headline ?? '', 4000),
      notes: [
        ...(job.summary?.notes ?? []),
        ...buildSummaryNotes({ type: job.type, engine: job._enginePlan, analysis: job._analysis, ocrResult }),
      ],
      modules: touchedModules,
      coverage: {
        reviewable: Number(job.plan?.reviewable ?? 0),
        reviewed: Number(job.counts?.filesReviewed ?? 0),
        failed: Number(ocrResult?.manifest?.coverage?.failed?.length ?? 0),
        waived: Number(ocrResult?.manifest?.coverage?.waived?.length ?? 0),
      },
      bySeverity: counts,
    };
    if (job.type === 'architecture' && job._analysis?.summary) {
      job.summary.stats = job._analysis.summary.stats ?? {};
    }
    if (job.type === 'flow' && job._analysis?.flows) {
      job.summary.flows = job._analysis.flows.length;
    }
    setStage(job, 'report', 'done', `${counts.total} 条问题 · ${counts.critical + counts.high} 条需优先处理`);
    logEvent(job, 'info', `报告已生成：${job.summary.headline}`);
  }

  async function drain() {
    if (disposed || concurrency < 1) return;
    while (active.size < concurrency) {
      const next = [...jobs.values()].find((job) => job.status === 'queued' && !job._cancel);
      if (!next) return;
      next.status = 'running';
      void runJob(next);
      if (active.size >= concurrency) return;
      // runJob registers itself synchronously before its first await.
      if (active.size === 0) return;
    }
  }

  const api = {
    async init() {
      await store.init();
      for (const job of store.listJobs()) jobs.set(job.id, job);
      const queued = [...jobs.values()].filter((job) => job.status === 'queued');
      for (const job of queued) void runJob(job);
      return api;
    },

    setConcurrency(value) {
      concurrency = Math.max(1, Math.min(4, Number(value) || 1));
    },

    get(id) {
      return jobs.get(String(id)) ?? null;
    },

    async getFull(id) {
      const job = store.getJob(String(id)) ?? jobs.get(String(id));
      if (!job) return null;
      if (!Array.isArray(job.findings)) {
        const full = await store.getJobFull(String(id));
        if (full) {
          jobs.set(full.id, full);
          return full;
        }
      }
      return job;
    },

    async markFix(id, sessionId = '') {
      const job = await api.getFull(id);
      if (!job) {
        const error = new Error(`评审 ${id} 不存在`);
        error.code = 'code-review/not-found';
        throw error;
      }
      job.fixAt = nowIso();
      if (sessionId) job.fixSessionId = String(sessionId);
      job.fixVerifiedAt = null;
      await store.persistNow(job);
      return { job };
    },

    async recheck(id) {
      const job = await api.getFull(id);
      if (!job) {
        const error = new Error(`评审 ${id} 不存在`);
        error.code = 'code-review/not-found';
        throw error;
      }
      if (job.type === 'workspace') {
        const error = new Error('当前改动评审没有稳定的校验基线；请新建一次当前改动评审来确认修复');
        error.code = 'code-review/bad-request';
        throw error;
      }
      const recheck = api.start({
        projectId: job.projectId,
        projectPath: job.projectPath,
        type: job.type,
        scope: job.scope ?? {},
        options: {
          ...(job.options ?? {}),
          background: [job.options?.background, '复评：校验修复状态'].filter(Boolean).join('\n'),
        },
      });
      job.recheckJobId = recheck.id;
      job.lastRecheckAt = nowIso();
      await store.persistNow(job);
      return { job: recheck };
    },

    async resolveFinding(id, key, resolved = true) {
      const job = await api.getFull(id);
      if (!job) {
        const error = new Error(`评审 ${id} 不存在`);
        error.code = 'code-review/not-found';
        throw error;
      }
      const valid = new Set((job.findings ?? []).map(findingKey));
      if (!valid.has(String(key))) {
        const error = new Error('该条问题不存在或已被新报告替换');
        error.code = 'code-review/bad-request';
        throw error;
      }
      job.resolutions = job.resolutions ?? {};
      if (resolved) job.resolutions[String(key)] = { status: 'fixed', at: nowIso(), auto: false };
      else delete job.resolutions[String(key)];
      syncResolvedCount(job);
      await store.persistNow(job);
      return { job, resolutions: job.resolutions, resolvedCount: job.resolvedCount };
    },

    list() {
      return [...jobs.values()].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    },

    running() {
      return api.list().filter((job) => job.status === 'running' || job.status === 'queued');
    },

    start({ projectId, projectPath, type, scope = {}, options = {} } = {}) {
      const reviewType = TYPES.has(String(type)) ? String(type) : 'workspace';
      const project = { projectId: projectId || undefined, projectPath: projectPath || undefined };
      const normalizedScope = normalizeScope(reviewType, scope);
      const plan = (typeof getEnginePlan === 'function' && getEnginePlan())
        || (() => {
          const llm = typeof getLlmState === 'function'
            ? (getLlmState() ?? { configured: false })
            : { configured: false };
          return {
            mode: config.engine === 'structural' ? 'structural' : (llm.configured ? 'ocr' : 'structural'),
            llmConfigured: Boolean(llm.configured),
            provider: llm.provider ?? null,
            model: llm.model ?? null,
          };
        })();
      const enginePlan = plan.mode;
      const job = {
        id: jobId(),
        seq: store.nextSeq(),
        projectId: project.projectId ?? null,
        projectPath: project.projectPath ?? '',
        projectName: '',
        type: reviewType,
        title: '',
        subtitle: '',
        scope: normalizedScope,
        engine: enginePlan === 'structural' ? 'structural' : (enginePlan === 'delegate' ? 'delegate' : 'ocr'),
        engineDetail: {
          engineMode: enginePlan,
          ocr: enginePlan === 'ocr',
          delegate: enginePlan === 'delegate',
          llmConfigured: Boolean(plan.llmConfigured ?? plan.mode !== 'structural'),
          provider: plan.provider ?? null,
          model: plan.model ?? null,
        },
        options: {
          effort: options.effort ?? config.ocr.effort,
          background: String(options.background ?? '').slice(0, 8000),
          exclude: String(options.exclude ?? '').slice(0, 2000),
          maxTokensBudget: Number(options.maxTokensBudget ?? 0),
        },
        status: 'queued',
        stage: { key: 'resolve', label: STAGE_LABELS.resolve, index: 0, total: 5 },
        progress: 0,
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        counts: { filesPlanned: 0, filesReviewed: 0, findings: 0, bySeverity: {}, byCategory: {}, tokens: 0, modules: 0 },
        stages: stageList(reviewType, enginePlan),
        activity: [],
        plan: null,
        summary: null,
        error: null,
        artifacts: {},
        _enginePlan: enginePlan,
        _structuralFindings: [],
        _findings: [],
      };
      const labels = buildTitle({ type: reviewType, project: { name: '项目' }, scope: normalizedScope });
      job.title = labels.title;
      job.subtitle = labels.subtitle;
      jobs.set(job.id, job);
      store.saveJob(job);
      logEvent(job, 'info', `已加入队列：${job.type}`, { global: true });
      void drain();
      return job;
    },

    cancel(id) {
      const job = jobs.get(String(id));
      if (!job) return false;
      if (job.status === 'queued' || job.status === 'running') {
        job._cancel = true;
        job._controller?.abort();
        if (job.status === 'queued') {
          job.status = 'cancelled';
          job.finishedAt = nowIso();
          job.progress = 1;
          job.error = { code: 'code-review/cancelled', message: '评审已取消' };
          store.saveJob(job, { final: true });
        }
        logEvent(job, 'warn', '评审已取消', { global: true });
        return true;
      }
      return false;
    },

    retry(id) {
      const job = jobs.get(String(id));
      if (!job) return null;
      return api.start({
        projectId: job.projectId,
        projectPath: job.projectPath,
        type: job.type,
        scope: job.scope ?? {},
        options: job.options ?? {},
      });
    },

    async delete(id) {
      const job = jobs.get(String(id));
      if (!job) return false;
      if (job.status === 'running') return false;
      jobs.delete(String(id));
      return store.deleteJob(String(id));
    },

    prune() {
      const list = api.list();
      for (const job of list.slice(config.maxJobs)) {
        if (job.status === 'running') continue;
        jobs.delete(job.id);
        void store.deleteJob(job.id);
      }
    },

    dispose() {
      disposed = true;
      for (const job of jobs.values()) {
        if (job.status === 'running') {
          job._cancel = true;
          job._controller?.abort();
        }
      }
      void store.flush();
    },
  };

  const projectCache = new Map();
  function normalizeScope(type, scope) {
    const source = scope && typeof scope === 'object' ? scope : {};
    const result = {
      paths: Array.isArray(source.paths) ? source.paths.map(relativeSafe).filter(Boolean).slice(0, 40) : [],
      commit: safeRef(source.commit),
      from: safeRef(source.from),
      to: safeRef(source.to),
      flowName: String(source.flowName ?? '').slice(0, 120),
    };
    if (type === 'commit' && !result.commit) {
      throw Object.assign(new Error('单次提交评审需要提供 commit（提交 SHA 或 tag）'), { code: 'code-review/bad-scope' });
    }
    if (type === 'range' && (!result.from || !result.to)) {
      throw Object.assign(new Error('分支对比评审需要提供 from 与 to'), { code: 'code-review/bad-scope' });
    }
    if (type === 'module' && !result.paths.length) {
      throw Object.assign(new Error('模块评审需要提供至少一个模块路径'), { code: 'code-review/bad-scope' });
    }
    return result;
  }

  // Expose project lookup for titles without a resolver round-trip.
  function rememberProject(project) {
    if (project?.id) projectCache.set(String(project.id), project);
  }

  return Object.assign(api, { rememberProject, TYPES, STAGE_LABELS, STAGE_WEIGHTS });
}
