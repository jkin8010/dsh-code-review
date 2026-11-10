import { randomUUID } from 'node:crypto';
import { errorText } from './shared.js';

/**
 * Fix-session creation shared by the `fix.create` RPC and the `/code-review fix`
 * command. The Host creates a real DSH Session in the project directory and
 * sends the review findings as the first user message.
 */

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

/**
 * Create a session in the reviewed project and send the fix prompt.
 * @param controller - DSH `sessionController` host service.
 * @param job - completed review job with findings.
 * @param logger - plugin logger.
 * @returns structured result; prompt failures still return the new session id.
 */
export async function createFixSessionForJob({ controller, job, logger }) {
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
  // Gateway strict codecs validate the wire request; requestId must be a UUID.
  const requestId = randomUUID();
  try {
    if (typeof controller.prompt === 'function') {
      await controller.prompt(
        { sessionId, content: [{ type: 'text', text: prompt }], requestId },
        { kind: 'user', rpcId: requestId },
      );
    }
  } catch (cause) {
    logger?.warn?.(`fix prompt failed for ${job.id}: ${errorText(cause)}`);
    return {
      sessionId,
      jobId: job.id,
      prompted: false,
      findings: findings.length,
      prompt,
      error: { code: 'code-review/fix-prompt-failed', message: errorText(cause) },
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
