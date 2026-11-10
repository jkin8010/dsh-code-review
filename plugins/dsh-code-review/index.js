/**
 * Host half of the code review studio (`@jkin8010/dsh-code-review`).
 *
 * The plugin owns every side effect: it shells out to the
 * [open-code-review](https://github.com/alibaba/open-code-review) CLI (`ocr`),
 * runs the offline structural analysers, and persists review history. The Web
 * page polls one authenticated RPC endpoint and never touches git or `ocr`
 * itself.
 *
 * Wire protocol (identical envelope to the shipped management routes):
 *   POST /api/code-review  { type:'client-request', method:'code-review',
 *                            rpcId, payload:{ method, payload } }
 *   <-  { type:'server-response', rpcId, result:{ ok, value|error } }
 *
 * Failure policy: collectors and reviews degrade instead of throwing. A missing
 * `ocr`, an unconfigured LLM, or a non-git project leaves the page readable and
 * explains the next action in `health` / `overview`.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as git from './host/git.js';
import * as ocr from './host/ocr.js';
import * as analyze from './host/analyze.js';
import { expandHome, findOcrBinary, normalizeConfig, resolveOcrEnv } from './host/config.js';
import { createJobs } from './host/jobs.js';
import { createLlmReviewer } from './host/llm-review.js';
import { registerCodeReviewTool } from './host/tool.js';
import { createSnapshot, publicJob } from './host/snapshot.js';
import { createStore } from './host/store.js';
import { errorText } from './host/shared.js';

export const name = 'qise-code-review';

const RPC_ENDPOINT = 'code-review';

function createLogger(ctx) {
  let logger = null;
  const resolve = () => {
    if (logger) return logger;
    try {
      const raw = ctx?.logger?.('qise-code-review');
      if (raw) {
        const normalized = {
          info: (...args) => raw.info?.(...args),
          warn: (...args) => raw.warn?.(...args),
          error: (...args) => raw.error?.(...args),
          debug: (...args) => raw.debug?.(...args),
        };
        logger = normalized;
      }
    } catch {
      /* logger is best effort */
    }
    return logger;
  };
  return new Proxy({}, {
    get: (_target, property) => (...args) => {
      try {
        resolve()?.[property]?.(...args);
      } catch {
        /* logging must never break a review */
      }
    },
  });
}

function groupFiles(findings) {
  const map = new Map();
  for (const item of findings ?? []) {
    const entry = map.get(item.path) ?? { path: item.path, findings: 0, severityMax: 'low', severityCounts: { critical: 0, high: 0, medium: 0, low: 0 } };
    entry.findings += 1;
    entry.severityCounts[item.severity] += 1;
    if (item.severity === 'critical' || (item.severity === 'high' && entry.severityMax !== 'critical')) {
      entry.severityMax = item.severity;
    }
    map.set(item.path, entry);
  }
  return [...map.values()].sort((a, b) => b.findings - a.findings);
}

function rpcReply(rpcId, result) {
  // The DSH client rejects a failure envelope whose error lacks a `details`
  // record, replacing it with "invalid server-response failure". Always emit
  // the full shape so the real error message reaches the UI.
  const value = result && result.ok === false
    ? {
      ...result,
      error: {
        code: typeof result.error?.code === 'string' ? result.error.code : 'code-review/failed',
        message: typeof result.error?.message === 'string' ? result.error.message : String(result.error ?? '未知错误'),
        details: result.error?.details && typeof result.error.details === 'object' ? result.error.details : {},
      },
    }
    : result;
  return Response.json({ type: 'server-response', rpcId, result: value });
}

function registerRpc(ctx, handler, logger) {
  const registry = ctx.get?.('connection')?.fetch;
  if (typeof registry?.register !== 'function') return null;
  return registry.register({
    path: `/api/${RPC_ENDPOINT}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (type !== 'application/json') return new Response('unsupported media type', { status: 415 });
      let message;
      try {
        message = await request.json();
      } catch {
        return new Response('invalid json', { status: 400 });
      }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid';
      const call = message?.payload;
      if (message?.type !== 'client-request' || message?.method !== RPC_ENDPOINT
        || typeof call?.method !== 'string' || !Object.hasOwn(call, 'payload')) {
        return rpcReply(rpcId, {
          ok: false,
          error: { code: 'gateway/bad-request', message: 'Malformed code review request.' },
        });
      }
      try {
        const value = await handler(call.method, call.payload ?? {});
        return rpcReply(rpcId, { ok: true, value });
      } catch (error) {
        logger?.warn?.(`rpc ${call.method} failed: ${errorText(error)}`);
        return rpcReply(rpcId, {
          ok: false,
          error: { code: error?.code ?? 'code-review/failed', message: errorText(error) },
        });
      }
    },
  });
}

async function resolveConfiguredToken(config) {
  if (config.ocr.llmToken || !config.ocr.llmTokenFile) return;
  try {
    const text = (await readFile(config.ocr.llmTokenFile, 'utf8')).trim();
    if (text) config.ocr.llmToken = text;
  } catch {
    /* the probe reports the missing credential source */
  }
}

function buildFixPrompt(job, findings) {
  const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...findings].sort((a, b) => (severityRank[a.severity] ?? 4) - (severityRank[b.severity] ?? 4));
  const lines = [];
  for (const item of sorted.slice(0, 24)) {
    const location = item.startLine ? `${item.path}:${item.startLine}` : item.path;
    lines.push(`- [${item.severity}/${item.category}] ${location} — ${item.title}`);
    if (item.content) lines.push(`  ${String(item.content).replace(/\s+/g, ' ').slice(0, 500)}`);
    if (item.suggestionCode) lines.push(`  建议代码：${String(item.suggestionCode).replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  const extra = sorted.length > 24 ? `\n（另有 ${sorted.length - 24} 条，见代码评审中心详情页）` : '';
  return [
    `你是代码修复助手。项目「${job.projectName ?? ''}」刚完成一次${job.type}评审，报告标题：${job.title ?? ''}。`,
    '请根据下面的 findings 修复代码。要求：',
    '1. 先阅读相关文件与调用方，确认问题真实存在；不确定的不要改。',
    '2. 优先处理 critical / high，其次 medium；low 可按性价比处理。',
    '3. 保持最小改动与现有代码风格，不引入无关重构。',
    '4. 修改后运行相关测试/构建；最后用中文汇总：改了什么、为什么、还剩什么没解决。',
    '',
    `共 ${sorted.length} 条问题：`,
    ...lines,
    extra,
    '',
    '如果某条 finding 判断为误报，请说明理由并跳过，不要为了“修复”而改坏代码。',
  ].filter(Boolean).join('\n');
}

export function apply(ctx, rawConfig) {
  const logger = createLogger(ctx);
  const config = normalizeConfig(rawConfig, { hostCwd: process.cwd() });
  if (!config.enabled) {
    logger.info('code review studio disabled by configuration');
    return;
  }
  config.ocr.bin = findOcrBinary(config);

  let jobsApi = null;
  const jobsAccessor = {
    list: () => jobsApi?.list() ?? [],
    get: (id) => jobsApi?.get(id) ?? null,
    running: () => jobsApi?.running() ?? [],
  };
  const store = createStore({
    dir: config.stateDir,
    maxJobs: config.maxJobs,
    logger: () => logger,
  });

  // The DSH model route doubles as OCR's delegation mode: OCR still selects the
  // files and resolves rules, the session model performs the review. Both
  // services are looked up lazily so plugin mount order does not matter.
  const getLlm = () => {
    try {
      return ctx.get?.('llm') ?? undefined;
    } catch {
      return undefined;
    }
  };
  const getSelection = () => {
    try {
      return ctx.get?.('agentDefaultModel')?.currentSelection?.();
    } catch {
      return undefined;
    }
  };
  const llmReviewer = createLlmReviewer({ getLlm, getSelection, logger });

  const snapshot = createSnapshot({
    config,
    store,
    jobs: jobsAccessor,
    git,
    ocr,
    analyze,
    logger,
    defaultProjectPath: config.defaultProjectPath,
    getDelegateStatus: () => llmReviewer.status(),
  });

  const getEnginePlan = () => {
    if (config.engine === 'structural') return { mode: 'structural', llmConfigured: false };
    const ocrLlm = snapshot.getLlmState();
    if (config.engine === 'ocr') {
      return {
        mode: 'ocr',
        llmConfigured: Boolean(ocrLlm.ocrConfigured),
        provider: ocrLlm.provider ?? null,
        model: ocrLlm.model ?? null,
      };
    }
    if (ocrLlm.ocrConfigured) {
      return {
        mode: 'ocr',
        llmConfigured: true,
        provider: ocrLlm.provider ?? null,
        model: ocrLlm.model ?? null,
      };
    }
    const delegate = llmReviewer.status();
    if (delegate.available) {
      return {
        mode: 'delegate',
        llmConfigured: true,
        provider: delegate.provider ?? null,
        model: delegate.model ?? null,
      };
    }
    return { mode: 'structural', llmConfigured: false };
  };

  jobsApi = createJobs({
    config,
    env: resolveOcrEnv(config),
    store,
    logger,
    ocr,
    analyze,
    llmReviewer,
    getEnginePlan,
    projectResolver: (args) => snapshot.getProject(args),
    getLlmState: () => snapshot.getLlmState(),
  });

  // Conversational entry: one model-facing tool backing "在对话里 review 当前项目".
  registerCodeReviewTool(ctx, { jobs: jobsApi, config, logger });

  const handler = async (method, payload = {}) => {
    switch (method) {
      case 'snapshot':
        return snapshot.get(payload ?? {});
      case 'job': {
        const job = await jobsApi.getFull(payload?.id);
        if (!job) {
          const error = new Error(`评审 ${payload?.id} 不存在`);
          error.code = 'code-review/not-found';
          throw error;
        }
        const findings = Array.isArray(job.findings) ? job.findings : [];
        return {
          job: publicJob(job, { activity: 40 }),
          findings,
          files: groupFiles(findings),
          graph: job.graph ?? null,
        };
      }
      case 'start': {
        const job = jobsApi.start(payload ?? {});
        return { job: publicJob(job, { activity: 40 }) };
      }
      case 'cancel':
        return { ok: jobsApi.cancel(payload?.id), job: publicJob(jobsApi.get(payload?.id) ?? {}) };
      case 'retry': {
        const job = jobsApi.retry(payload?.id);
        return { job: job ? publicJob(job, { activity: 40 }) : null };
      }
      case 'delete':
        return { ok: await jobsApi.delete(payload?.id) };
      case 'project':
        return { project: await snapshot.getProject(payload ?? {}) };
      case 'fix.create': {
        const job = await jobsApi.getFull(payload?.jobId);
        if (!job) {
          const error = new Error(`评审 ${payload?.jobId} 不存在`);
          error.code = 'code-review/not-found';
          throw error;
        }
        if (!job.projectPath) {
          const error = new Error('该评审没有记录项目路径，无法创建修复会话');
          error.code = 'code-review/bad-request';
          throw error;
        }
        const controller = ctx.get?.('sessionController');
        if (!controller || typeof controller.create !== 'function') {
          const error = new Error('当前 DSH 环境不支持从插件创建会话（sessionController 不可用）');
          error.code = 'code-review/session-unavailable';
          throw error;
        }
        const findings = Array.isArray(job.findings) ? job.findings : [];
        const prompt = buildFixPrompt(job, findings);
        let created;
        try {
          created = await controller.create({ cwd: job.projectPath });
        } catch (cause) {
          const error = new Error(`创建修复会话失败：${errorText(cause)}`);
          error.code = 'code-review/session-failed';
          throw error;
        }
        const sessionId = created?.sessionId ? String(created.sessionId) : '';
        if (!sessionId) {
          const error = new Error('创建修复会话失败：未返回 sessionId');
          error.code = 'code-review/session-failed';
          throw error;
        }
        const requestId = `code-review-fix-${job.id}-${Date.now()}`;
        try {
          if (typeof controller.prompt === 'function') {
            await controller.prompt(
              { sessionId, content: [{ type: 'text', text: prompt }], requestId },
              { kind: 'user', rpcId: requestId },
            );
          }
        } catch (cause) {
          logger.warn(`fix prompt failed for ${job.id}: ${errorText(cause)}`);
          return {
            sessionId,
            jobId: job.id,
            prompted: false,
            findings: findings.length,
            error: { code: 'code-review/fix-prompt-failed', message: errorText(cause) },
          };
        }
        return {
          sessionId,
          jobId: job.id,
          prompted: true,
          findings: findings.length,
          title: job.title,
          projectName: job.projectName,
        };
      }
      case 'project.browse': {
        const requested = expandHome(String(payload?.path ?? '').trim()) || homedir();
        let info = null;
        try {
          info = await stat(requested);
        } catch {
          const error = new Error(`目录不存在：${requested}`);
          error.code = 'code-review/not-found';
          throw error;
        }
        const target = info.isDirectory() ? requested : dirname(requested);
        let entries = [];
        try {
          entries = await readdir(target, { withFileTypes: true });
        } catch (cause) {
          const error = new Error(`目录不可读：${target}（${errorText(cause)}）`);
          error.code = 'code-review/bad-request';
          throw error;
        }
        const dirs = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => ({
            name: entry.name,
            path: join(target, entry.name),
            hidden: entry.name.startsWith('.'),
          }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
          .slice(0, 500);
        const parent = dirname(target);
        const roots = [];
        const candidates = [
          ...(config.projectRoots ?? []).map((root) => expandHome(root)),
          homedir(),
        ];
        for (const path of candidates) {
          if (!path || !existsSync(path) || roots.some((root) => root.path === path)) continue;
          roots.push({ name: path === homedir() ? '主目录' : path.split('/').filter(Boolean).pop(), path });
        }
        return {
          path: target,
          parent: parent === target ? null : parent,
          roots: roots.slice(0, 6),
          entries: dirs,
        };
      }
      case 'project.add': {
        const project = await snapshot.addProjectPath(payload?.path);
        return { project, snapshot: snapshot.build() };
      }
      case 'project.remove':
        return { ok: await snapshot.removeProjectPath(payload?.path), snapshot: snapshot.build() };
      case 'graph':
        return snapshot.getGraph({
          projectId: payload?.projectId,
          projectPath: payload?.projectPath,
          kind: payload?.kind === 'flow' ? 'flow' : 'architecture',
          force: Boolean(payload?.force),
        });
      case 'refresh':
        return snapshot.refreshAll();
      case 'llmTest': {
        const result = await ocr.llmTest({ config, env: resolveOcrEnv(config) });
        return result;
      }
      case 'ping':
        return { ok: true, at: new Date().toISOString() };
      default: {
        const error = new Error(`未知方法：${method}`);
        error.code = 'code-review/bad-method';
        throw error;
      }
    }
  };

  const registerRoute = (scope) => {
    const off = registerRpc(scope, handler, logger);
    if (!off) logger.warn('connection.fetch is unavailable; the code review API cannot be registered');
    scope.effect(() => () => {
      void off?.();
    }, 'code-review:rpc');
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (scope) => registerRoute(scope));
  } else {
    registerRoute(ctx);
  }

  let flushTimer = null;
  let pruneTimer = null;
  ctx.effect(() => {
    let disposed = false;
    void (async () => {
      await resolveConfiguredToken(config);
      await store.init();
      if (disposed) return;
      await jobsApi.init();
      if (disposed) return;
      await snapshot.init();
      if (disposed) return;
      flushTimer = setInterval(() => {
        void store.flush();
      }, 15_000);
      flushTimer.unref?.();
      pruneTimer = setInterval(() => {
        try {
          jobsApi.prune();
        } catch (error) {
          logger.warn(`prune failed: ${errorText(error)}`);
        }
      }, 60_000);
      pruneTimer.unref?.();
      logger.info(`code review studio ready (${config.stateDir}, ocr=${config.ocr.bin || 'missing'})`);
    })().catch((error) => {
      logger.error(`code review studio failed to start: ${errorText(error)}`);
    });
    return () => {
      disposed = true;
      if (flushTimer) clearInterval(flushTimer);
      if (pruneTimer) clearInterval(pruneTimer);
      jobsApi?.dispose();
      snapshot.dispose();
      void store.flush();
    };
  }, 'code-review:lifecycle');
}
