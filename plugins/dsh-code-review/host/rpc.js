import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ocr from './ocr.js';
import { expandHome, resolveOcrEnv } from './config.js';
import { createFixSessionForJob } from './fix.js';
import { errorText, findingKey } from './shared.js';
import { publicJob } from './snapshot.js';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function groupFiles(findings) {
  const map = new Map();
  for (const item of findings ?? []) {
    const entry = map.get(item.path) ?? {
      path: item.path, findings: 0, severityMax: 'low',
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
    };
    const severity = Object.hasOwn(SEVERITY_RANK, item.severity) ? item.severity : 'low';
    entry.findings += 1;
    entry.severityCounts[severity] += 1;
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[entry.severityMax]) entry.severityMax = severity;
    map.set(item.path, entry);
  }
  return [...map.values()].sort((a, b) => b.findings - a.findings);
}

/**
 * RPC dispatch for the authenticated `/api/code-review` endpoint.
 *
 * Kept out of the plugin entry so `apply()` only wires subsystems: each case
 * maps one client method onto snapshot/jobs/store services and translates a
 * thrown error into the shared failure envelope.
 */
export function createRpcHandler({ config, snapshot, jobs, getServices, logger }) {
  const services = () => (typeof getServices === 'function' ? getServices() : {});
  return async (method, payload = {}) => {
    switch (method) {
      case 'snapshot':
        return snapshot.get(payload ?? {});
      case 'job': {
        const job = await jobs.getFull(payload?.id);
        if (!job) {
          const error = new Error(`评审 ${payload?.id} 不存在`);
          error.code = 'code-review/not-found';
          throw error;
        }
        const findings = (Array.isArray(job.findings) ? job.findings : [])
          .map((finding) => ({ ...finding, key: findingKey(finding) }));
        return {
          job: publicJob(job, { activity: 40 }),
          findings,
          resolutions: job.resolutions ?? {},
          resolvedCount: job.resolvedCount ?? Object.keys(job.resolutions ?? {}).length,
          files: groupFiles(findings),
          graph: job.graph ?? null,
        };
      }
      case 'start': {
        const job = jobs.start(payload ?? {});
        return { job: publicJob(job, { activity: 40 }) };
      }
      case 'cancel':
        return { ok: jobs.cancel(payload?.id), job: publicJob(jobs.get(payload?.id) ?? {}) };
      case 'retry': {
        const job = jobs.retry(payload?.id);
        return { job: job ? publicJob(job, { activity: 40 }) : null };
      }
      case 'delete':
        return { ok: await jobs.delete(payload?.id) };
      case 'finding.resolve': {
        const result = await jobs.resolveFinding(payload?.jobId, payload?.key, payload?.resolved !== false);
        return result;
      }
      case 'project':
        return { project: await snapshot.getProject(payload ?? {}) };
      case 'fix.create': {
        const job = await jobs.getFull(payload?.jobId);
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
        return createFixSessionForJob({
          controller: services().sessionController,
          workspaceRegistry: services().workspaceRegistry,
          job,
          logger,
        });
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


}

const RPC_ENDPOINT = 'code-review';

export function rpcReply(rpcId, result) {
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

export function registerRpc(ctx, handler, logger) {
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

/** Mount the authenticated RPC route through the connection registry. */
export function mountRpcRoute(ctx, handler, logger) {
  const register = (scope) => {
    const registry = scope.get?.('connection')?.fetch ?? scope.connection?.fetch;
    if (typeof registry?.register !== 'function') {
      logger.warn('connection.fetch is unavailable; the code review API cannot be registered');
      return null;
    }
    const off = registerRpc(scope, handler, logger);
    return off;
  };
  if (typeof ctx.inject === 'function') {
    let off = null;
    ctx.inject(['connection'], (scope) => {
      off = register(scope);
    });
    return { dispose: () => { try { void off?.(); } catch { /* best effort */ } } };
  }
  return { dispose: () => { try { void register(ctx)?.(); } catch { /* best effort */ } } };
}
