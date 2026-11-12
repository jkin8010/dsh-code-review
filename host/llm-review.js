import { readProjectFile } from './files.js';
import {
  countFindings, errorText, finding, nowIso, trimText,
} from './shared.js';

/**
 * Delegation-mode reviewer.
 *
 * OCR officially supports delegation: the CLI selects files and resolves rules
 * deterministically, and the host model performs the review. This module is that
 * host-side reviewer for deployments where no separate OCR API key exists — it
 * uses the same model route the DSH session already runs on
 * (`ctx.agentDefaultModel.currentSelection()` + `ctx.llm.stream()`), so the
 * review still works on a stock install. Plain `ocr review` remains the primary
 * engine whenever OCR owns an LLM configuration.
 *
 * The reviewer asks for strict JSON, tolerates prose/fences around it, and turns
 * every failure into a structured result so the job engine can degrade to the
 * offline structural pass instead of failing the review.
 */

const MAX_FILES = 12;
const MAX_FILE_CHARS = 14_000;
const MAX_GROUP_CHARS = 26_000;
const MAX_GROUPS = 6;

const SYSTEM_PROMPT = `你是一名资深代码评审员，只输出严格 JSON，不要输出 Markdown 代码块或解释文字。
评审要求：只报告真实存在、可定位的问题；不确定的不要编造；每条问题必须能对应到给定文件与行号。`;

const OUTPUT_SPEC = `输出格式（严格 JSON）：
{
  "findings": [
    {
      "path": "文件路径（必须与输入一致）",
      "startLine": 起始行号（整数）,
      "endLine": 结束行号（整数）,
      "severity": "critical | high | medium | low",
      "category": "bug | security | performance | maintainability | test | style | documentation | other",
      "title": "一句话问题（<=120 字）",
      "content": "问题说明与修复建议（可多句）",
      "existingCode": "可选：需要修改的原始代码片段",
      "suggestionCode": "可选：建议替换后的代码片段"
    }
  ],
  "projectSummary": "可选：一到两句整体结论"
}
没有问题时输出 {"findings":[],"projectSummary":"未发现需要处理的问题"}`;

function parseDiffByFile(diffText) {
  const sections = new Map();
  const lines = String(diffText ?? '').split('\n');
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current && buffer.length) sections.set(current, buffer.join('\n'));
    buffer = [];
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = line.match(/ b\/(.+)$/);
      current = match ? match[1] : null;
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return sections;
}

function numberLines(content, maxChars) {
  const lines = String(content ?? '').split('\n');
  let used = 0;
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = `${index + 1}\t${lines[index]}`;
    used += line.length + 1;
    if (used > maxChars) {
      kept.push(`…（截断：仅展示前 ${index} 行，共 ${lines.length} 行）`);
      break;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const CATEGORIES = new Set([
  'bug', 'security', 'performance', 'maintainability', 'test', 'style', 'documentation', 'other',
]);

/**
 * Match a model-reported path to one of the planned files. An exact hit wins;
 * otherwise a directory-suffix hit is accepted only when it is unique —
 * `src/a/index.js` and `test/index.js` both end with `index.js`, and picking
 * the first would attach the finding (and its line numbers) to the wrong file.
 */
function resolveAllowedPath(path, allowedPaths) {
  if (allowedPaths.has(path)) return path;
  const matches = [...allowedPaths].filter(
    (candidate) => candidate.endsWith(`/${path}`) || path.endsWith(`/${candidate}`),
  );
  return matches.length === 1 ? matches[0] : null;
}

function normalizeComments(raw, allowedPaths, { onDrop } = {}) {
  const list = Array.isArray(raw?.findings) ? raw.findings : (Array.isArray(raw) ? raw : []);
  const comments = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const path = String(item.path ?? '').replace(/\\/g, '/').trim();
    if (!path) continue;
    const resolved = resolveAllowedPath(path, allowedPaths);
    if (!resolved) {
      onDrop?.('path', path);
      continue;
    }
    const content = String(item.content ?? item.message ?? '').trim();
    const startLine = Math.floor(Number(item.startLine ?? item.start_line));
    // A finding without a usable line cannot be located or applied; keep the
    // rest of the report but drop this one instead of emitting line 0.
    if (!Number.isInteger(startLine) || startLine < 1) {
      onDrop?.('line', path);
      continue;
    }
    const endRaw = Math.floor(Number(item.endLine ?? item.end_line));
    const endLine = Number.isInteger(endRaw) && endRaw >= startLine ? endRaw : startLine;
    const severity = String(item.severity ?? '').trim().toLowerCase();
    const category = String(item.category ?? '').trim().toLowerCase();
    const title = String(item.title ?? '').trim();
    comments.push({
      path: resolved,
      content,
      start_line: startLine,
      end_line: endLine,
      severity: SEVERITIES.has(severity) ? severity : 'medium',
      category: CATEGORIES.has(category) ? category : 'other',
      title: title || trimText(content, 120),
      suggestion_code: item.suggestionCode ?? item.suggestion_code ?? '',
      existing_code: item.existingCode ?? item.existing_code ?? '',
      thinking: item.thinking ?? '',
    });
  }
  return comments;
}

export function createLlmReviewer({ getLlm, getSelection, logger } = {}) {
  const log = (level, message) => {
    try {
      const sink = logger?.[level] ?? logger?.info;
      sink?.call?.(logger, message);
    } catch {
      /* logging never breaks a review */
    }
  };

  function route() {
    try {
      const llm = getLlm?.();
      const selection = getSelection?.();
      if (!llm || typeof llm.stream !== 'function') {
        return { available: false, provider: null, model: null, error: 'DSH 模型服务不可用' };
      }
      if (!selection?.provider || !selection?.model) {
        return { available: false, provider: null, model: null, error: '未找到当前会话的默认模型' };
      }
      return {
        available: true, provider: selection.provider, model: selection.model, error: null,
      };
    } catch (error) {
      return { available: false, provider: null, model: null, error: errorText(error) };
    }
  }

  async function streamText(prompt, signal) {
    const target = route();
    if (!target.available) throw Object.assign(new Error(target.error), { code: 'code-review/delegate-unavailable' });
    const llm = getLlm();
    const options = {
      provider: target.provider,
      model: target.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    };
    if (signal) options.signal = signal;
    let text = '';
    let usage = null;
    let failure = null;
    for await (const chunk of llm.stream(options)) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      else if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage;
      else if (chunk.type === 'finish') {
        const reason = chunk.reason ?? {};
        if (reason.kind === 'error' || reason.kind === 'aborted') {
          failure = reason.failure ?? { code: reason.kind, message: reason.kind };
        }
      }
    }
    if (failure && !text) {
      const error = new Error(failure.message ?? failure.code ?? '模型调用失败');
      error.code = `code-review/delegate-${failure.code ?? 'failed'}`;
      throw error;
    }
    return { text, usage, target, failure };
  }

  function parseFindings(text, allowedPaths) {
    const candidates = [];
    const fenced = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) candidates.push(fenced[1]);
    candidates.push(text);
    const start = String(text ?? '').indexOf('{');
    const end = String(text ?? '').lastIndexOf('}');
    if (start >= 0 && end > start) candidates.push(String(text).slice(start, end + 1));
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /**
   * Run a delegated review.
   * `plan.files` are the deterministically selected files; `diffText` carries
   * the diff for review-type jobs, otherwise file contents are read.
   */
  async function run({
    project, type, scope, plan, diffText, background, rules, signal, onEvent, onProgress,
  }) {
    const target = route();
    if (!target.available) {
      return { ok: false, error: { code: 'code-review/delegate-unavailable', message: target.error } };
    }
    const planFiles = (plan?.files ?? [])
      .filter((file) => file.willReview !== false && file.path)
      .map((file) => String(file.path))
      .slice(0, MAX_FILES);
    const allowedPaths = new Set(planFiles);
    if (!planFiles.length) {
      return {
        ok: true, comments: [], summary: { filesReviewed: 0, comments: 0, totalTokens: 0 },
        projectSummary: '', warnings: [], sessionId: '', engine: 'delegate',
      };
    }

    const diffSections = diffText ? parseDiffByFile(diffText) : new Map();
    const files = [];
    for (const path of planFiles) {
      const diff = diffSections.get(path);
      let body = '';
      if (diff) {
        body = `以下为该文件的 git diff（只评审新增/修改行）：\n${trimText(diff, MAX_FILE_CHARS)}`;
      } else {
        const content = await readProjectFile(project.path, path);
        if (!content) continue;
        body = `以下为该文件内容（行号\\t代码）：\n${numberLines(content, MAX_FILE_CHARS)}`;
      }
      files.push({ path, body });
    }
    if (!files.length) {
      return {
        ok: true, comments: [], summary: { filesReviewed: 0, comments: 0, totalTokens: 0 },
        projectSummary: '没有可读取的评审内容', warnings: [], sessionId: '', engine: 'delegate',
      };
    }

    const groups = [];
    let current = [];
    let chars = 0;
    for (const file of files) {
      if (current.length && (chars + file.body.length > MAX_GROUP_CHARS || current.length >= 4)) {
        groups.push(current);
        current = [];
        chars = 0;
      }
      current.push(file);
      chars += file.body.length;
    }
    if (current.length) groups.push(current);

    const ruleText = (rules?.rules ?? []).map((rule) => rule.rule).filter(Boolean).join('\n\n');
    const comments = [];
    const warnings = [];
    let totalTokens = 0;
    let filesReviewed = 0;
    let projectSummary = '';
    // Drop counters so a group whose findings were all unusable is not counted
    // as reviewed output without any explanation.
    const groupStats = { path: 0, line: 0 };
    const noteDrop = (reason, path) => {
      groupStats[reason] = (groupStats[reason] ?? 0) + 1;
      if (groupStats[reason] === 1) {
        log('warn', `delegate finding dropped (${reason}): ${path}`);
      }
    };
    let failedGroups = 0;
    const maxFailedGroups = Math.max(1, Math.floor(groups.length / 2));

    for (const [groupIndex, group] of groups.slice(0, MAX_GROUPS).entries()) {
      if (signal?.aborted) {
        return { ok: false, error: { code: 'code-review/cancelled', message: '评审已取消' } };
      }
      const fileBlocks = group.map((file) => `### 文件：${file.path}\n${file.body}`).join('\n\n');
      const prompt = [
        `## 任务：${typeLabel(type)}代码评审`,
        `项目：${project.name}（${project.path}）${project.branch ? ` · 分支 ${project.branch}` : ''}`,
        background ? `## 评审背景\n${trimText(background, 6000)}` : '',
        ruleText ? `## 评审规则\n${trimText(ruleText, 6000)}` : '',
        `## 待评审内容（第 ${groupIndex + 1}/${groups.length} 组）\n${fileBlocks}`,
        OUTPUT_SPEC,
      ].filter(Boolean).join('\n\n');

      onEvent?.({ level: 'info', text: `DSH 模型评审第 ${groupIndex + 1}/${groups.length} 组（${group.map((file) => file.path).join('、')}）` });
      try {
        const { text, usage } = await streamText(`${SYSTEM_PROMPT}\n\n${prompt}`, signal);
        const parsed = parseFindings(text, allowedPaths);
        if (parsed) {
          comments.push(...normalizeComments(parsed, allowedPaths, { onDrop: noteDrop }));
          if (typeof parsed.projectSummary === 'string' && parsed.projectSummary.trim()) {
            projectSummary = parsed.projectSummary.trim();
          }
        } else {
          warnings.push({ type: 'delegate_parse', file: '', message: '模型输出不是合法 JSON，已跳过该组' });
        }
        filesReviewed += group.length;
        if (usage) {
          totalTokens += Number(usage.inputTokens ?? usage.input_tokens ?? 0)
            + Number(usage.outputTokens ?? usage.output_tokens ?? 0);
        }
      } catch (error) {
        // `streamText` reports a cancelled stream as `delegate-aborted`; treating
        // it as an ordinary failure would keep issuing requests on a dead signal.
        if (signal?.aborted
          || error?.code === 'code-review/cancelled'
          || error?.code === 'code-review/delegate-aborted') {
          return { ok: false, error: { code: 'code-review/cancelled', message: '评审已取消' } };
        }
        failedGroups += 1;
        log('warn', `delegate group ${groupIndex + 1} failed: ${errorText(error)}`);
        warnings.push({ type: 'delegate_error', file: '', message: trimText(errorText(error), 240) });
        if (filesReviewed === 0) {
          return { ok: false, error: { code: error?.code ?? 'code-review/delegate-failed', message: errorText(error) } };
        }
        // Most of the groups failing means the surfaced result would be
        // misleadingly "ok" with almost nothing reviewed.
        if (failedGroups >= maxFailedGroups) {
          return {
            ok: false,
            error: {
              code: 'code-review/delegate-failed',
              message: `DSH 模型评审多组失败（${failedGroups}/${groups.length}），已终止：${errorText(error)}`,
            },
            warnings,
          };
        }
      }
      onProgress?.({
        fraction: (groupIndex + 1) / Math.max(1, groups.length),
        detail: `已完成 ${groupIndex + 1}/${groups.length} 组`,
      });
    }

    if (groupStats.path || groupStats.line) {
      warnings.push({
        type: 'delegate_dropped',
        file: '',
        message: `已丢弃 ${groupStats.path + groupStats.line} 条无法定位的 finding（路径不匹配 ${groupStats.path} 条，行号非法 ${groupStats.line} 条）`,
      });
    }

    const normalized = comments.map((comment) => finding(comment));
    const counts = countFindings(normalized);
    return {
      ok: true,
      comments,
      summary: {
        filesReviewed,
        comments: counts.total,
        totalTokens,
        elapsed: '',
      },
      projectSummary,
      warnings,
      sessionId: '',
      engine: 'delegate',
      llm: { provider: target.provider, model: target.model },
      completedAt: nowIso(),
    };
  }

  function status() {
    const target = route();
    return {
      available: target.available,
      provider: target.provider,
      model: target.model,
      error: target.error,
    };
  }

  return { run, status, route };
}

function typeLabel(type) {
  return {
    workspace: '当前改动', commit: '单次提交', range: '分支对比', architecture: '项目架构',
    module: '代码模块', flow: '信息流',
  }[type] ?? type;
}
