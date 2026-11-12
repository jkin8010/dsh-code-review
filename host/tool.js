import { isAbsolute, resolve } from 'node:path';
import { errorText, trimText } from './shared.js';

/**
 * Model-facing tool: let a project conversation drive the review studio.
 *
 * The Web page is the full workspace; this tool is the conversational shortcut.
 * It starts a real review job through the same engine the page uses, waits for
 * the six-stage pipeline (unless `wait:false`), and returns a compact summary
 * plus the findings so the agent can explain them inline. It never duplicates
 * review logic: `jobs.start` owns the work, this file only shapes arguments and
 * results.
 */

const TOOL_NAME = 'code_review';
const WAIT_TIMEOUT_MS = 12 * 60_000;
const POLL_MS = 1200;
const TYPES = ['workspace', 'commit', 'range', 'architecture', 'module', 'flow'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

const DESCRIPTION = [
  '使用「代码评审中心」(dsh-code-review 插件) 评审代码。当用户要求 review 当前项目/改动/提交/分支，',
  '或评审项目架构、某个代码模块、信息流业务工作流时调用。',
  'action=start 会启动一次真实评审并默认等待完成，返回问题摘要与 findings；',
  'action=status/detail/list 用于查看进行中的评审或最近记录。',
  'project_path 省略时使用当前会话工作目录（即“当前项目”）；type 省略时有 paths 走模块评审，否则走项目架构评审。',
].join('');

function parameterSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'status', 'detail', 'list'],
        description: 'start 启动评审；status 查询任务状态；detail 查看问题详情；list 列出最近评审。',
      },
      project_path: {
        type: 'string',
        description: '项目绝对路径或相对当前会话工作目录的路径；省略 = 当前项目。',
      },
      type: {
        type: 'string',
        enum: TYPES,
        description: '评审类型：workspace(当前改动)/commit/range(分支对比)/architecture(架构)/module(模块)/flow(信息流)。',
      },
      scope: {
        type: 'object',
        additionalProperties: false,
        description: '评审范围：module 用 paths；commit 用 commit；range 用 from/to。',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: '模块/文件路径（repo 相对）' },
          commit: { type: 'string', description: 'commit SHA 或 tag' },
          from: { type: 'string', description: '分支对比起点 ref' },
          to: { type: 'string', description: '分支对比终点 ref' },
        },
      },
      options: {
        type: 'object',
        additionalProperties: false,
        properties: {
          effort: { type: 'string', enum: ['low', 'medium', 'high'] },
          background: { type: 'string', description: '本次评审的业务背景，帮助模型理解意图' },
          exclude: { type: 'string', description: '逗号分隔的排除 glob' },
          max_tokens_budget: { type: 'number', description: 'OCR 本次 token 预算（0=不限）' },
        },
      },
      wait: { type: 'boolean', description: 'start 时是否等待完成，默认 true（最长约 12 分钟）' },
      job_id: { type: 'string', description: 'status/detail 的任务 id' },
      severity: {
        type: 'string', enum: SEVERITIES, description: 'detail 时只返回该严重度及以上的问题',
      },
      limit: { type: 'integer', description: 'detail 返回的问题条数上限，默认 40，最大 200' },
    },
  };
}

function outputSchema() {
  return {
    type: 'object',
    additionalProperties: true,
  };
}

function sleep(ms, signal) {
  return new Promise((resolvePromise) => {
    // An already-aborted signal never fires again: wake immediately instead of
    // blocking a cancelled wait for a full poll interval.
    if (signal?.aborted) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolvePromise();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

function terminal(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function summaryOf(job) {
  return {
    id: job.id,
    status: job.status,
    type: job.type,
    title: job.title,
    projectName: job.projectName,
    projectPath: job.projectPath,
    engine: job.engine,
    stage: job.stage,
    progress: job.progress,
    durationMs: job.durationMs,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    counts: job.counts,
    summary: job.summary ? {
      headline: job.summary.headline,
      projectSummary: trimText(job.summary.projectSummary ?? '', 1200),
      notes: job.summary.notes ?? [],
      coverage: job.summary.coverage ?? null,
    } : null,
    error: job.error ?? null,
  };
}

function pickFindings(job, { severity, limit = 40 } = {}) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  const floor = severity ? (rank[severity] ?? 3) : 3;
  return (job.findings ?? [])
    .filter((item) => (rank[item.severity] ?? 4) <= floor)
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 40)))
    .map((item) => ({
      severity: item.severity,
      category: item.category,
      path: item.path,
      startLine: item.startLine,
      endLine: item.endLine,
      title: item.title,
      content: trimText(item.content ?? '', 1600),
      suggestionCode: trimText(item.suggestionCode ?? '', 2000),
      source: item.source,
    }));
}

function renderResult(value) {
  const lines = [];
  const action = value?.action;
  if (value?.ok === false) {
    lines.push(`代码评审失败：${value?.error?.message ?? '未知错误'}`);
    return lines.join('\n');
  }
  if (action === 'list') {
    lines.push(`最近 ${value.jobs?.length ?? 0} 次评审：`);
    for (const job of value.jobs ?? []) {
      lines.push(`- ${job.id} [${job.type}] ${job.projectName ?? ''} · ${job.status}${job.summary?.headline ? ` · ${job.summary.headline}` : ''}`);
    }
    return lines.join('\n');
  }
  const job = value.job ?? {};
  if (action === 'status') {
    lines.push(`评审 ${job.id}：${job.status} · ${job.stage?.label ?? job.stage?.key ?? ''} · ${Math.round((job.progress ?? 0) * 100)}%`);
    if (job.summary?.headline) lines.push(job.summary.headline);
    return lines.join('\n');
  }
  lines.push(`${action === 'detail' ? '评审详情' : '评审完成'}：${job.title ?? ''}`);
  lines.push(`任务 ${job.id} · ${job.status} · 引擎 ${job.engine ?? '—'}${job.durationMs ? ` · 耗时 ${Math.round(job.durationMs / 1000)}s` : ''}`);
  if (job.summary?.headline) lines.push(job.summary.headline);
  if (value.cancelled) lines.push('（等待被取消，任务已请求停止）');
  if (value.timedOut) lines.push('（等待超时，评审仍在后台运行，可用 status/detail 继续查看）');
  const findings = value.findings ?? [];
  if (findings.length) {
    lines.push('', `问题（${findings.length} 条，按严重度排序）：`);
    for (const item of findings.slice(0, 20)) {
      const location = item.startLine ? `${item.path}:${item.startLine}` : item.path;
      lines.push(`- [${item.severity}/${item.category}] ${location} — ${item.title}`);
    }
    if (findings.length > 20) lines.push(`- …另有 ${findings.length - 20} 条`);
  } else if (job.status === 'completed') {
    lines.push('未发现需要处理的问题。');
  }
  if (job.summary?.projectSummary) lines.push('', `总结：${trimText(job.summary.projectSummary, 600)}`);
  if (job.summary?.notes?.length) {
    lines.push('', ...job.summary.notes.map((note) => `注：${note}`));
  }
  if (job.status === 'completed' || job.status === 'failed') {
    lines.push('', '完整详情（问题分组、代码建议、覆盖率）：侧栏「代码评审中心」→ 评审 → 点击该任务。');
  }
  return lines.join('\n');
}

export function createCodeReviewToolDefinition({ jobs, config, logger } = {}) {
  const log = (level, message) => {
    try {
      const sink = logger?.[level] ?? logger?.info;
      sink?.call?.(logger, message);
    } catch {
      /* logging never breaks a tool call */
    }
  };

  function sessionCwd(exec) {
    const fromAgent = exec?.agent?.session?.header?.cwd;
    if (typeof fromAgent === 'string' && fromAgent) return fromAgent;
    const fromExec = exec?.session?.header?.cwd;
    if (typeof fromExec === 'string' && fromExec) return fromExec;
    return config.defaultProjectPath || process.cwd();
  }

  function resolveProjectPath(args, exec) {
    const raw = typeof args.project_path === 'string' ? args.project_path.trim() : '';
    if (!raw) return sessionCwd(exec);
    return isAbsolute(raw) ? raw : resolve(sessionCwd(exec), raw);
  }

  function defaultType(args) {
    if (TYPES.includes(args.type)) return args.type;
    if (Array.isArray(args.scope?.paths) && args.scope.paths.length) return 'module';
    return 'architecture';
  }

  async function waitForJob(id, signal) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < WAIT_TIMEOUT_MS) {
      if (signal?.aborted) {
        jobs.cancel(id);
        return { timedOut: false, cancelled: true };
      }
      const job = jobs.get(id);
      if (!job) return { timedOut: false, cancelled: false };
      if (terminal(job.status)) return { timedOut: false, cancelled: false };
      await sleep(POLL_MS, signal);
    }
    return { timedOut: true, cancelled: false };
  }

  async function start(args, exec) {
    const projectPath = resolveProjectPath(args, exec);
    const type = defaultType(args);
    const scope = args.scope && typeof args.scope === 'object' ? { ...args.scope } : {};
    const options = args.options && typeof args.options === 'object' ? { ...args.options } : {};
    let job;
    try {
      job = jobs.start({
        projectPath,
        type,
        scope,
        options: {
          effort: options.effort,
          background: options.background,
          exclude: options.exclude,
          maxTokensBudget: options.max_tokens_budget,
        },
      });
    } catch (error) {
      return {
        ok: false,
        action: 'start',
        error: { code: error?.code ?? 'code-review/bad-request', message: errorText(error) },
      };
    }
    log('info', `tool started ${job.id} (${type}) for ${projectPath}`);
    if (args.wait === false) {
      return { ok: true, action: 'start', waiting: false, job: summaryOf(jobs.get(job.id) ?? job) };
    }
    const outcome = await waitForJob(job.id, exec?.signal);
    const finished = (await jobs.getFull(job.id)) ?? jobs.get(job.id) ?? job;
    return {
      ok: finished.status !== 'failed',
      action: 'start',
      waiting: !outcome.timedOut,
      timedOut: outcome.timedOut,
      cancelled: outcome.cancelled,
      projectPath,
      job: summaryOf(finished),
      findings: pickFindings(finished, { limit: 40 }),
      files: (finished.plan?.files ?? []).slice(0, 40).map((file) => file.path),
    };
  }

  async function status(args) {
    const job = args.job_id ? jobs.get(String(args.job_id)) : jobs.list()[0];
    if (!job) {
      return { ok: false, action: 'status', error: { code: 'code-review/not-found', message: '未找到该评审任务' } };
    }
    return { ok: true, action: 'status', job: summaryOf(job) };
  }

  async function detail(args) {
    const id = args.job_id ?? jobs.list()[0]?.id;
    if (!id) {
      return { ok: false, action: 'detail', error: { code: 'code-review/not-found', message: '当前没有评审记录' } };
    }
    const job = await jobs.getFull(String(id));
    if (!job) {
      return { ok: false, action: 'detail', error: { code: 'code-review/not-found', message: `评审 ${id} 不存在` } };
    }
    return {
      ok: true,
      action: 'detail',
      job: summaryOf(job),
      findings: pickFindings(job, { severity: args.severity, limit: args.limit }),
      files: (job.plan?.files ?? []).slice(0, 60).map((file) => file.path),
    };
  }

  async function list(args) {
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 10));
    const jobsList = jobs.list().slice(0, limit);
    return {
      ok: true,
      action: 'list',
      jobs: jobsList.map(summaryOf),
    };
  }

  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: parameterSchema(),
    output: {
      schema: outputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      const action = typeof args.action === 'string' ? args.action : 'start';
      try {
        if (action === 'start') return await start(args, exec);
        if (action === 'status') return await status(args);
        if (action === 'detail') return await detail(args);
        if (action === 'list') return await list(args);
        return { ok: false, action, error: { code: 'code-review/bad-action', message: `未知 action：${action}` } };
      } catch (error) {
        log('warn', `tool ${action} failed: ${errorText(error)}`);
        return { ok: false, action, error: { code: error?.code ?? 'code-review/tool-failed', message: errorText(error) } };
      }
    },
  };
}

/** Register the tool on the host tools registry (no-op when it is absent). */
export function registerCodeReviewTool(ctx, options) {
  const definition = createCodeReviewToolDefinition(options);
  const register = (scope) => {
    const tools = scope?.tools ?? scope?.get?.('tools');
    if (!tools || typeof tools.register !== 'function') return;
    scope.effect(() => {
      let dispose = null;
      try {
        dispose = tools.register(definition);
      } catch (error) {
        options?.logger?.warn?.(`code review tool registration failed: ${errorText(error)}`);
      }
      return () => {
        try {
          if (typeof dispose === 'function') dispose();
          else dispose?.dispose?.();
        } catch {
          /* disposal is best effort */
        }
      };
    }, 'code-review:tool');
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], register);
  } else {
    register(ctx);
  }
  return definition;
}
