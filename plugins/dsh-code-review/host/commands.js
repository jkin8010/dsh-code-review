import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { errorText, nowIso, trimText } from './shared.js';
import { createFixSessionForJob } from './fix.js';

/**
 * Slash command: `/code-review <subcommand> [@project] [options]`.
 *
 * Mirrors the ocr CLI's review families so a project conversation can start a
 * review without opening the Web page. An explicit `@path` (or `--project`) is
 * added to the project list first, which is the "no project configured yet"
 * path the command is designed for.
 */

const COMMAND_NAME = 'code-review';

const USAGE = `用法：/code-review <子命令> [@项目路径] [选项]

子命令：
  changes | workspace | diff      当前改动（staged + unstaged + untracked）
  commit <sha>                     单次提交
  range <from> <to>                分支对比（merge-base）
  architecture | arch              项目架构
  module <路径[,路径]>             代码模块
  workflow | flow [链路名]         信息流 / 业务工作流
  fix [jobId]                      为最近一次（或指定）评审新建修复 Session
  list [数量]                      最近评审
  status [jobId]                   评审进度

选项：
  --fix                 评审完成后自动新建修复 Session
  --async               启动后立即返回，不等待完成
  --project <路径>      项目路径（等价于 @路径；相对当前会话目录）
  --effort <level>      low | medium | high
  --background <文本>   评审背景（帮助模型理解意图）
  --exclude <globs>     逗号分隔的排除规则
  --budget <n>          OCR 本次 token 预算（0=不限）

示例：
  /code-review workflow @test/
  /code-review workflow --fix @test/
  /code-review architecture @/Users/me/project
  /code-review module plugins/dsh-code-review/host --fix
  /code-review changes --effort high
  /code-review commit abc123
  /code-review range main feature/login
  /code-review fix`;

const TYPE_BY_SUBCOMMAND = {
  changes: 'workspace',
  workspace: 'workspace',
  diff: 'workspace',
  review: 'workspace',
  commit: 'commit',
  range: 'range',
  architecture: 'architecture',
  arch: 'architecture',
  module: 'module',
  mod: 'module',
  workflow: 'flow',
  flow: 'flow',
};

const LABEL = {
  workspace: '当前改动', commit: '单次提交', range: '分支对比',
  architecture: '项目架构', module: '代码模块', flow: '信息流',
};

function tokenize(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function parse(raw) {
  const tokens = tokenize(raw);
  const args = {
    subcommand: '',
    positional: [],
    project: '',
    projectExplicit: false,
    fix: false,
    async: false,
    effort: '',
    background: '',
    exclude: '',
    budget: 0,
  };
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--fix' || token === '-f') {
      args.fix = true;
      index += 1;
      continue;
    }
    if (token === '--async' || token === '-a') {
      args.async = true;
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h' || token === 'help') {
      args.subcommand = 'help';
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      const [flag, inline] = token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined];
      // A following token is only a value when it is not itself a flag:
      // `--project --async` is a missing value, not a project called "--async".
      let value = inline;
      if (value === undefined) {
        const next = tokens[index + 1];
        if (next !== undefined && !next.startsWith('-')) {
          value = next;
          index += 1;
        }
      }
      if (flag === '--project' || flag === '--path') {
        if (!value) throw new Error(`${flag} 需要项目路径`);
        args.project = value;
        args.projectExplicit = true;
      } else if (flag === '--effort') {
        if (value === undefined) throw new Error('--effort 需要取值：low | medium | high');
        if (!['low', 'medium', 'high'].includes(String(value))) throw new Error('--effort 只支持 low | medium | high');
        args.effort = String(value);
      } else if (flag === '--background') {
        if (value === undefined) throw new Error('--background 需要评审背景文本');
        args.background = String(value);
      } else if (flag === '--exclude') {
        if (value === undefined) throw new Error('--exclude 需要逗号分隔的排除规则');
        args.exclude = String(value);
      } else if (flag === '--budget') {
        if (value === undefined) throw new Error('--budget 需要 token 数量（0 表示不限）');
        args.budget = Math.max(0, Number(value) || 0);
      } else {
        throw new Error(`未知选项：${flag}`);
      }
      index += 1;
      continue;
    }
    if (token.startsWith('@')) {
      const path = token.slice(1).trim();
      if (!path) throw new Error('@ 后面需要项目路径');
      args.project = path;
      args.projectExplicit = true;
      index += 1;
      continue;
    }
    if (!args.subcommand) args.subcommand = token.toLowerCase();
    else args.positional.push(token);
    index += 1;
  }
  return args;
}

function terminal(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

const WAIT_POLL_MS = 1000;
const WAIT_TIMEOUT_MS = 10 * 60_000;

/**
 * Sleep that also wakes on abort. The signal is checked up front because an
 * already-aborted signal never fires its event again — without that check a
 * cancelled review would sit through one full poll interval per loop.
 */
function sleep(ms, signal) {
  return new Promise((resolvePromise) => {
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

function countLine(counts) {
  const c = counts ?? {};
  const parts = [];
  if (c.bySeverity?.critical) parts.push(`${c.bySeverity.critical} 严重`);
  if (c.bySeverity?.high) parts.push(`${c.bySeverity.high} 高`);
  if (c.bySeverity?.medium) parts.push(`${c.bySeverity.medium} 中`);
  if (c.bySeverity?.low) parts.push(`${c.bySeverity.low} 低`);
  return `${Number(c.findings ?? 0)} 个问题${parts.length ? `（${parts.join(' · ')}）` : ''}`;
}

function findingsText(findings, limit = 8) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...(findings ?? [])].sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4));
  const rows = sorted.slice(0, limit).map((item) => {
    const location = item.startLine ? `${item.path}:${item.startLine}` : item.path;
    return `  - [${item.severity}/${item.category}] ${location} — ${item.title}`;
  });
  if (sorted.length > limit) rows.push(`  - …另有 ${sorted.length - limit} 条，查看详情`);
  return rows.join('\n');
}

export function createCodeReviewCommand({
  jobs, snapshot, getSessionController, getWorkspaceRegistry, config, logger,
} = {}) {
  const log = (level, message) => {
    try {
      const sink = logger?.[level] ?? logger?.info;
      sink?.call?.(logger, message);
    } catch {
      /* logging must never break a command */
    }
  };

  function sessionCwd(invocation) {
    const cwd = invocation?.agent?.session?.header?.cwd;
    if (typeof cwd === 'string' && cwd) return cwd;
    return config?.defaultProjectPath || process.cwd();
  }

  function resolveProject(args, invocation) {
    const raw = String(args.project ?? '').trim();
    const cwd = sessionCwd(invocation);
    if (!raw) return cwd;
    return isAbsolute(raw) ? raw : resolve(cwd, raw);
  }

  async function ensureProject(path, explicit) {
    if (!explicit) return path;
    // `resolve` has already resolved `..`; register only a real directory so a
    // stray `@../../x` cannot make the plugin scan something outside the session.
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Error(`项目路径不存在：${path}`);
    }
    if (!info.isDirectory()) throw new Error(`项目路径不是目录：${path}`);
    const project = await snapshot.addProjectPath(path);
    return project?.path ?? path;
  }

  function jobList() {
    const raw = jobs.list?.();
    return Array.isArray(raw) ? raw.filter((job) => job && job.id) : [];
  }

  function latestJob(projectPath) {
    const list = jobList();
    if (projectPath) {
      const match = list.find((job) => job.projectPath === projectPath);
      if (match) return match;
    }
    return list[0] ?? null;
  }

  /**
   * Wait for a terminal job state.
   * @returns `{ status: 'done', job }`, `{ status: 'aborted' | 'missing' | 'timedOut', job }`
   * — a single enum so callers cannot forget the `missing` branch.
   */
  async function waitJob(id, signal, { timeoutMs = WAIT_TIMEOUT_MS, pollMs = WAIT_POLL_MS } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) {
        jobs.cancel(id);
        return { status: 'aborted', job: jobs.get(id) };
      }
      const job = jobs.get(id);
      if (!job) return { status: 'missing', job: null };
      if (terminal(job.status)) return { status: 'done', job };
      await sleep(pollMs, signal);
    }
    return { status: 'timedOut', job: jobs.get(id) };
  }

  async function fixJob(job, controller) {
    try {
      const workspaceRegistry = typeof getWorkspaceRegistry === 'function' ? getWorkspaceRegistry() : null;
      const result = await createFixSessionForJob({ controller, workspaceRegistry, job, logger, stateDir: config?.stateDir });
      return result;
    } catch (error) {
      return { error: errorText(error) };
    }
  }

  function fixText(result) {
    if (!result) return '';
    if (result.error) return `\n⚠️ 修复会话创建失败：${result.error}`;
    if (result.prompted === false) {
      return `\n⚠️ 修复会话已创建（${result.sessionId}），但提示词发送失败：${errorText(result.error?.message)}`;
    }
    return `\n🛠️ 已新建修复 Session：${result.sessionId}（提示词已发送，可在左侧会话列表打开）`;
  }

  async function runReview(args, invocation) {
    const sub = args.subcommand || 'workflow';
    const type = TYPE_BY_SUBCOMMAND[sub];
    if (!type) throw new Error(`未知子命令：${sub}`);
    const scope = {};
    if (type === 'commit') {
      const commit = args.positional[0];
      if (!commit) throw new Error('用法：/code-review commit <sha>');
      scope.commit = commit;
    }
    if (type === 'range') {
      const [from, to] = args.positional;
      if (!from || !to) throw new Error('用法：/code-review range <from> <to>');
      scope.from = from;
      scope.to = to;
    }
    if (type === 'module') {
      const paths = (args.positional.join(',') || '').split(',').map((item) => item.trim()).filter(Boolean);
      if (!paths.length) throw new Error('用法：/code-review module <路径[,路径]>');
      scope.paths = paths;
    }
    if (type === 'flow' && args.positional[0]) scope.flowName = args.positional[0];

    const requestedPath = resolveProject(args, invocation);
    const projectPath = await ensureProject(requestedPath, args.projectExplicit);

    let job;
    try {
      job = jobs.start({
        projectPath,
        type,
        scope,
        options: {
          effort: args.effort || undefined,
          background: args.background || undefined,
          exclude: args.exclude || undefined,
          maxTokensBudget: args.budget || undefined,
        },
      });
    } catch (error) {
      return { kind: 'error', text: `启动评审失败：${errorText(error)}` };
    }
    log('info', `command started ${job.id} (${type}) for ${projectPath}`);

    if (args.async) {
      return {
        kind: 'success',
        text: `已启动${LABEL[type]}评审：${job.id}\n项目：${job.projectPath || projectPath}\n进度与详情：侧栏「代码评审中心」→ 评审`,
      };
    }

    const wait = await waitJob(job.id, invocation?.signal);
    if (wait.status === 'aborted') {
      return { kind: 'error', text: `评审已取消：${job.id}` };
    }
    if (wait.status === 'missing') {
      return {
        kind: 'error',
        text: `评审任务已不存在：${job.id}\n可能已被清理（超出 maxJobs 上限或手动删除），请重新执行评审，或在侧栏查看最近记录。`,
      };
    }
    const finished = (await jobs.getFull(job.id)) ?? jobs.get(job.id) ?? job;
    if (wait.status === 'timedOut') {
      return {
        kind: 'success',
        text: `⏳ 评审仍在运行：${job.id}\n当前阶段：${finished.stage?.label ?? '—'}（${Math.round((finished.progress ?? 0) * 100)}%）\n完成后可在侧栏查看详情，或再次执行 /code-review status ${job.id}`,
      };
    }
    if (!finished || finished.status === 'failed' || finished.status === 'cancelled') {
      return {
        kind: 'error',
        text: `评审未完成：${job.id}\n原因：${errorText(finished?.error?.message ?? finished?.message ?? '未知错误')}`,
      };
    }

    const findings = Array.isArray(finished.findings) ? finished.findings : [];
    const lines = [
      `✅ ${LABEL[type]}评审完成 · ${finished.projectName ?? ''}（${finished.projectPath ?? projectPath}）`,
      `任务：${finished.id} · 引擎 ${finished.engine ?? '—'}${finished.durationMs ? ` · 耗时 ${Math.round(finished.durationMs / 1000)}s` : ''}`,
      `${finished.summary?.headline ?? countLine(finished.counts)}`,
    ];
    if (findings.length) {
      lines.push('问题：', findingsText(findings));
    } else {
      lines.push('未发现需要处理的问题。');
    }
    if (finished.summary?.projectSummary) lines.push('', `总结：${trimText(finished.summary.projectSummary, 500)}`);
    if (finished.summary?.notes?.length) lines.push('', ...finished.summary.notes.map((note) => `注：${note}`));
    lines.push('', `完整详情：侧栏「代码评审中心」→ 评审 → ${finished.id}`);

    if (args.fix) {
      if (!findings.length) {
        lines.push('', '（未发现问题，跳过修复会话）');
      } else {
        const controller = typeof getSessionController === 'function' ? getSessionController() : null;
        lines.push(fixText(await fixJob(finished, controller)));
      }
    }
    return { kind: 'success', text: lines.join('\n') };
  }

  async function runFix(args, invocation) {
    const requestedPath = resolveProject(args, invocation);
    const projectPath = args.projectExplicit ? await ensureProject(requestedPath, true) : '';
    let job = null;
    if (args.positional[0]) {
      job = await jobs.getFull(args.positional[0]);
      if (!job) return { kind: 'error', text: `评审 ${args.positional[0]} 不存在` };
    } else {
      job = latestJob(projectPath || '');
      if (!job) return { kind: 'error', text: '还没有评审记录，请先执行 /code-review workflow 等命令' };
      job = await jobs.getFull(job.id);
    }
    if (!job) return { kind: 'error', text: '未找到可修复的评审' };
    // `getFull` may hand back a store-owned object: build a normalized copy
    // instead of mutating the cached job.
    const fixable = { ...job, findings: Array.isArray(job.findings) ? job.findings : [] };
    if (!fixable.findings.length) return { kind: 'success', text: `评审 ${job.id} 没有需要修复的问题` };
    const controller = typeof getSessionController === 'function' ? getSessionController() : null;
    const result = await fixJob(fixable, controller);
    if (result?.error) return { kind: 'error', text: `创建修复会话失败：${result.error}` };
    return {
      kind: 'success',
      text: [
        `🛠️ 已为评审 ${job.id} 新建修复 Session：${result.sessionId}`,
        `项目：${job.projectName ?? ''}（${job.projectPath ?? ''}）`,
        `已发送 ${result.findings} 条 findings 的修复提示词。`,
        '',
        '会话已出现在左侧会话列表；如果客户端支持会自动跳转。',
      ].join('\n'),
    };
  }

  function runList(args) {
    const limit = Math.max(1, Math.min(20, Number(args.positional[0]) || 8));
    const list = jobList().slice(0, limit);
    if (!list.length) return { kind: 'success', text: '还没有评审记录' };
    return {
      kind: 'success',
      text: [
        `最近 ${list.length} 次评审：`,
        ...list.map((job) => `- ${job.id} [${job.type}] ${job.projectName ?? ''} · ${job.status}${job.summary?.headline ? ` · ${job.summary.headline}` : ''}`),
      ].join('\n'),
    };
  }

  async function runStatus(args) {
    const id = args.positional[0];
    const job = id ? jobs.get(id) : latestJob('');
    if (!job) return { kind: 'error', text: id ? `评审 ${id} 不存在` : '还没有评审记录' };
    return {
      kind: 'success',
      text: [
        `评审 ${job.id} · ${job.status}`,
        `项目：${job.projectName ?? ''}（${job.projectPath ?? ''}）`,
        `阶段：${job.stage?.label ?? '—'}（${Math.round((job.progress ?? 0) * 100)}%）`,
        job.summary?.headline ? `结果：${job.summary.headline}` : '',
      ].filter(Boolean).join('\n'),
    };
  }

  return {
    name: COMMAND_NAME,
    description: '代码评审：执行改动/架构/模块/信息流评审，支持 @项目路径 与 --fix 新建修复会话',
    input: { hint: 'workflow|architecture|module|changes @项目 [--fix] [--effort high]' },
    async handler(invocation) {
      let args;
      try {
        args = parse(invocation?.rawInput);
      } catch (error) {
        return { kind: 'error', text: `${errorText(error)}\n\n${USAGE}` };
      }
      const sub = args.subcommand;
      try {
        if (!sub || sub === 'help' || sub === '?') return { kind: 'success', text: USAGE };
        if (sub === 'fix') return await runFix(args, invocation);
        if (sub === 'list' || sub === 'ls') return runList(args);
        if (sub === 'status' || sub === 'st') return await runStatus(args);
        if (!TYPE_BY_SUBCOMMAND[sub]) {
          return { kind: 'error', text: `未知子命令：${sub}\n\n${USAGE}` };
        }
        return await runReview(args, invocation);
      } catch (error) {
        log('warn', `command failed: ${errorText(error)}`);
        return { kind: 'error', text: `命令执行失败：${errorText(error)}` };
      }
    },
  };
}

export { COMMAND_NAME, USAGE };
