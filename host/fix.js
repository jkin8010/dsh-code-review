import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorText } from './shared.js';

/**
 * Fix-session creation shared by the `fix.create` RPC and the `/code-review fix`
 * command. The Host creates a real DSH Session in the project directory and
 * sends the review findings as the first user message.
 */

/** Findings keep the fix session small: the model gets the top items only. */
const FIX_MAX_FINDINGS = 24;
const FIX_CONTENT_CHARS = 500;
const FIX_SUGGESTION_CHARS = 400;

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function oneLine(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Render the fix prompt. Exported so it can be unit-tested without a session. */
export function buildFixPrompt(job, findings, {
  maxFindings = FIX_MAX_FINDINGS, contentChars = FIX_CONTENT_CHARS, suggestionChars = FIX_SUGGESTION_CHARS,
} = {}) {
  const list = (Array.isArray(findings) ? findings : []).filter((item) => item && typeof item === 'object');
  const sorted = [...list].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4));
  const lines = [];
  for (const item of sorted.slice(0, maxFindings)) {
    // Every field is user/model supplied JSON: never emit `[undefined/undefined]`.
    const severity = oneLine(item.severity, 20) || 'medium';
    const category = oneLine(item.category, 20) || 'other';
    const path = oneLine(item.path, 400) || '(未知文件)';
    const line = Number(item.startLine);
    const location = Number.isFinite(line) && line > 0 ? `${path}:${Math.floor(line)}` : path;
    const title = oneLine(item.title, 200) || oneLine(item.content, 120) || '(无标题)';
    lines.push(`- [${severity}/${category}] ${location} — ${title}`);
    if (item.content) lines.push(`  ${oneLine(item.content, contentChars)}`);
    if (item.suggestionCode) lines.push(`  建议代码：${oneLine(item.suggestionCode, suggestionChars)}`);
  }
  const extra = sorted.length > maxFindings ? `\n（另有 ${sorted.length - maxFindings} 条，见代码评审中心详情页）` : '';
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

/**
 * Create a session in the reviewed project and send the fix prompt.
 * @param controller - DSH `sessionController` host service.
 * @param job - completed review job with findings.
 * @param logger - plugin logger.
 * @returns structured result; prompt failures still return the new session id.
 */
export async function createFixSessionForJob({ controller, workspaceRegistry, job, logger, stateDir }) {
  if (!controller || typeof controller.create !== 'function') {
    const error = new Error('当前 DSH 环境不支持从插件创建会话（sessionController 不可用）');
    error.code = 'code-review/session-unavailable';
    throw error;
  }
  // Public entry point (`fix.create` RPC and `/code-review fix`): validate the
  // job here so callers get a stable code instead of an internal TypeError.
  if (!job || typeof job !== 'object' || !job.id) {
    const error = new Error('缺少要修复的评审任务');
    error.code = 'code-review/invalid-job';
    throw error;
  }
  const projectPath = typeof job.projectPath === 'string' ? job.projectPath.trim() : '';
  if (!projectPath) {
    const error = new Error('评审任务缺少项目路径，无法创建修复会话');
    error.code = 'code-review/invalid-job';
    throw error;
  }
  const findings = Array.isArray(job.findings) ? job.findings : [];
  const prompt = buildFixPrompt(job, findings);
  // Prefer creating inside the project's Workspace so the new Session is grouped
  // under the project and the UI can open it directly.
  let workspace = null;
  try {
    const list = typeof workspaceRegistry?.list === 'function' ? workspaceRegistry.list() : [];
    workspace = (Array.isArray(list) ? list : []).find((item) => item?.path === projectPath) ?? null;
    if (!workspace && typeof workspaceRegistry?.create === 'function') {
      workspace = await workspaceRegistry.create(projectPath);
    }
  } catch (error) {
    logger?.warn?.(`fix session workspace lookup failed: ${errorText(error)}`);
  }
  const workspaceId = workspace?.id ?? workspace?.workspaceId;
  let created;
  try {
    created = await controller.create(workspaceId ? { workspaceId } : { cwd: projectPath });
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
  // Gateway strict codecs validate the wire request; requestId must be a UUID,
  // and it is unique per session so two fixes of the same job cannot collide.
  const requestId = randomUUID();
  try {
    if (typeof controller.prompt === 'function') {
      await controller.prompt(
        { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }], requestId },
        { kind: 'user', rpcId: requestId },
      );
    }
  } catch (cause) {
    const promptError = errorText(cause);
    logger?.warn?.(`fix prompt failed for ${job.id}: ${promptError}`);
    if (stateDir) {
      // Keep an on-disk trace so `fix.create` failures are diagnosable without
      // opening a devtools console on the running Host.
      void appendFile(join(stateDir, 'fix-errors.jsonl'), `${JSON.stringify({
        at: new Date().toISOString(), jobId: job.id, sessionId, error: promptError,
      })}\n`).catch(() => {});
    }
    // The session is intentionally retained on a prompt failure: the caller can
    // still open it, and the prompt text is returned for a clipboard fallback.
    return {
      sessionId,
      jobId: job.id,
      prompted: false,
      findings: findings.length,
      prompt,
      title: job.title,
      projectName: job.projectName,
      promptError,
      error: { code: 'code-review/fix-prompt-failed', message: promptError },
    };
  }
  return {
    sessionId,
    jobId: job.id,
    prompted: true,
    findings: findings.length,
    prompt,
    title: job.title,
    projectName: job.projectName,
  };
}
