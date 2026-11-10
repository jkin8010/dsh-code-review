import { trimText } from './shared.js';

/**
 * Prompt material for the OCR engine.
 *
 * OCR reviews a diff (`ocr review`) or whole files (`ocr scan`) with a
 * `--background` context block and optional project rules (`--rule`). The
 * plugin turns its local analysis — module graph, flow map, diff plan — into
 * that context so the same engine can answer four different review questions
 * instead of only "is this diff correct".
 */

const TYPE_LABEL = {
  workspace: '当前改动',
  commit: '单次提交',
  range: '分支对比',
  architecture: '项目架构',
  module: '代码模块',
  flow: '信息流 / 业务工作流',
};

const TYPE_FOCUS = {
  workspace: [
    '只评审本次改动引入的问题，不要求重构既有代码',
    '关注正确性、边界条件、错误处理、并发/资源释放、安全与测试缺口',
  ],
  commit: [
    '以这次提交的意图为线索，检查实现是否与提交信息一致',
    '关注回归风险：被改动的调用方、配置、迁移与兼容性',
  ],
  range: [
    '把两个 ref 的差异当成一个整体特性来审',
    '关注跨文件契约（接口/类型/协议）、迁移顺序、灰度与回滚',
  ],
  architecture: [
    '从模块边界、依赖方向、层次与耦合度评估架构健康度',
    '识别循环依赖、跨层反向依赖、上帝模块、不稳定依赖、重复职责',
    '区分「阻塞性问题」与「演进建议」，给出现阶段可执行的调整路径',
  ],
  module: [
    '以模块为单元，检查职责内聚、对外契约、错误处理与可测试性',
    '识别模块内部重复、过长函数、隐式全局状态、缺少输入校验',
  ],
  flow: [
    '沿着「入口 → 服务 → 数据/外部依赖」追踪一条业务信息流',
    '检查每一步的校验、鉴权、事务边界、幂等、错误传播与数据泄露',
    '指出链路中缺失的一环、被吞掉的失败和没有超时/重试的外部调用',
  ],
};

function bulletList(items, fallback = '暂无') {
  const list = (items ?? []).filter(Boolean);
  if (!list.length) return `- ${fallback}`;
  return list.map((item) => `- ${item}`).join('\n');
}

export function typeLabel(type) {
  return TYPE_LABEL[type] ?? type;
}

export function buildTitle({ type, project, scope }) {
  const name = project?.name ?? '项目';
  const label = typeLabel(type);
  let subtitle = '';
  if (type === 'commit' && scope?.commit) subtitle = `commit ${String(scope.commit).slice(0, 12)}`;
  else if (type === 'range') subtitle = `${scope?.from || 'base'} → ${scope?.to || 'HEAD'}`;
  else if (type === 'module') {
    const paths = (scope?.paths ?? []).slice(0, 3).join('、');
    subtitle = paths || '未选择模块';
  } else if (type === 'flow') {
    subtitle = scope?.flowName ? `链路 · ${scope.flowName}` : '业务信息流';
  } else if (type === 'architecture') subtitle = '模块依赖 · 分层 · 耦合';
  else subtitle = 'staged + unstaged + untracked';
  return { title: `${label}评审 · ${name}`, subtitle };
}

function projectBlock(project) {
  if (!project) return '';
  const lines = [
    `- 项目：${project.name}（${project.path}）`,
    project.branch ? `- 分支：${project.branch}${project.dirty ? '（工作区有未提交改动）' : ''}` : null,
    project.head ? `- HEAD：${project.head}${project.headSubject ? ` ${trimText(project.headSubject, 80)}` : ''}` : null,
    project.language ? `- 主语言：${project.language}` : null,
    Number.isFinite(project.loc) ? `- 规模：${project.fileCount ?? '?'} 文件 / ${project.loc} 行 / ${project.moduleCount ?? '?'} 顶层模块` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

function architectureBlock(analysis) {
  if (!analysis) return '';
  const graph = analysis.graph ?? {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const cycles = Array.isArray(graph.cycles) ? graph.cycles : [];
  const top = nodes
    .slice()
    .sort((a, b) => Number(b.loc ?? 0) - Number(a.loc ?? 0))
    .slice(0, 12)
    .map((node) => {
      const fanIn = edges.filter((edge) => edge.to === node.id).length;
      const fanOut = edges.filter((edge) => edge.from === node.id).length;
      return `- ${node.label}：${node.files ?? '?'} 文件 / ${node.loc ?? '?'} 行，扇入 ${fanIn}，扇出 ${fanOut}`;
    });
  const cycleText = cycles.slice(0, 6).map((cycle) => {
    const labels = cycle.map((id) => nodes.find((node) => node.id === id)?.label ?? id);
    return `- ${labels.join(' → ')} → ${labels[0]}`;
  });
  return [
    '### 本地架构分析（确定性结果，可作为评审依据）',
    `模块数 ${nodes.length}，依赖边 ${edges.length}，循环依赖 ${cycles.length} 组。`,
    top.length ? `\n规模最大的模块：\n${top.join('\n')}` : '',
    cycleText.length ? `\n已发现的循环依赖：\n${cycleText.join('\n')}` : '',
    analysis.summary?.headline ? `\n分析结论：${analysis.summary.headline}` : '',
  ].filter(Boolean).join('\n');
}

function flowBlock(analysis) {
  if (!analysis) return '';
  const flows = Array.isArray(analysis.flows) ? analysis.flows : [];
  if (!flows.length) return '### 本地信息流分析\n未识别到稳定的入口链路，请基于文件内容判断业务走向。';
  const lines = flows.slice(0, 8).map((flow, index) => {
    const steps = (flow.steps ?? []).map((step) => step.label).filter(Boolean);
    const data = (flow.data ?? []).map((item) => item.name).filter(Boolean);
    return `${index + 1}. 入口 ${flow.entry?.name ?? '?'}（${flow.entry?.file ?? '?'}）\n   路径：${steps.join(' → ') || '直接处理'}\n   数据：${data.join('、') || '无显式数据访问'}`;
  });
  return [
    '### 本地信息流分析（确定性结果，可作为评审依据）',
    `识别到 ${flows.length} 条候选业务链路，下面列出前 ${Math.min(flows.length, 8)} 条：`,
    lines.join('\n'),
  ].join('\n');
}

function moduleBlock(analysis) {
  if (!analysis) return '';
  const metrics = analysis.metrics ?? {};
  const notes = analysis.summary?.notes ?? [];
  return [
    '### 本地模块分析（确定性结果，可作为评审依据）',
    `文件 ${metrics.files ?? '?'}，代码行 ${metrics.loc ?? '?'}，最大文件 ${metrics.largestFile?.path ?? '—'}（${metrics.largestFile?.loc ?? '?'} 行）`,
    notes.length ? `\n${bulletList(notes)}` : '',
  ].filter(Boolean).join('\n');
}

/** Markdown context passed to OCR through `--background`. */
export function buildBackground({ type, project, scope, analysis, userBackground, diff }) {
  const sections = [
    `## 本次评审任务：${typeLabel(type)}`,
    `你正在为一个已经在开发的真实项目做代码评审。请把下面提供的项目事实当作已知信息，不要臆造文件或接口。`,
    projectBlock(project),
    TYPE_FOCUS[type]?.length ? `### 关注点\n${bulletList(TYPE_FOCUS[type])}` : '',
  ];

  if (type === 'commit') sections.push(`### 评审对象\n- 提交：${scope?.commit ?? '?'}`);
  if (type === 'range') sections.push(`### 评审对象\n- 基线：${scope?.from ?? '?'}\n- 目标：${scope?.to ?? '?'}`);
  if (type === 'module') sections.push(`### 评审范围\n- 模块路径：${(scope?.paths ?? []).join(', ') || '整个项目'}`);
  if (type === 'architecture') sections.push(architectureBlock(analysis));
  if (type === 'flow') sections.push(flowBlock(analysis));
  if (type === 'module') sections.push(moduleBlock(analysis));

  if (diff?.files?.length) {
    const shown = diff.files.slice(0, 20).map((file) => `- ${file.path} (+${file.insertions ?? 0} -${file.deletions ?? 0})`);
    sections.push(`### 改动概览\n共 ${diff.files.length} 个文件：\n${shown.join('\n')}${diff.files.length > 20 ? '\n- …' : ''}`);
  }

  if (String(userBackground ?? '').trim()) {
    sections.push(`### 用户补充背景\n${trimText(userBackground, 4000)}`);
  }

  sections.push([
    '### 输出要求',
    '- 只报告真实存在、可定位的问题；给出文件路径与行号区间。',
    '- 每条问题带 severity（critical/high/medium/low）与 category（bug/security/performance/maintainability/test/style/documentation/other）。',
    '- 架构与信息流评审允许给跨文件的结构性结论，但也必须尽量指向具体文件。',
    '- 不要复述这份背景，不要编造未提供的代码。',
  ].join('\n'));

  return sections.filter(Boolean).join('\n\n');
}

const ARCH_RULES = `从架构视角评审这个文件：
1. 检查依赖方向是否与模块分层一致，是否存在跨层反向依赖或对具体实现的硬编码依赖。
2. 检查循环依赖、隐式全局状态、单例与初始化顺序问题。
3. 检查模块边界是否清晰：对外暴露的接口是否最小、稳定，内部实现是否泄漏。
4. 检查配置、日志、错误处理、资源生命周期是否有一致策略。
5. 识别上帝模块/超大类，指出应按职责拆分的位置。
只报告有实际证据的问题；结构性建议要给出可落地的调整方向。`;

const MODULE_RULES = `从模块视角评审这个文件：
1. 检查输入校验、边界条件、错误处理与失败恢复是否完整。
2. 检查是否存在过长函数、重复逻辑、隐式共享状态、难以测试的副作用。
3. 检查对外契约（参数、返回、异常、事件）是否清晰稳定。
4. 检查资源释放、并发安全、超时与重试。
5. 检查该模块的测试缺口。
每条问题给出文件路径与行号区间，并区分严重度。`;

const FLOW_RULES = `从业务信息流视角评审这个文件：
1. 追踪入口（路由/事件/任务/CLI）到服务到数据/外部依赖的完整链路，指出链路中断或绕过。
2. 检查每个入口的鉴权、参数校验、限流与幂等。
3. 检查写路径的事务边界、一致性、失败补偿与重试。
4. 检查外部调用的超时、重试、降级，以及错误是否被吞掉。
5. 检查敏感数据是否被记录、透传或写入不该写入的位置。
报告问题时说明它在链路中的位置与影响。`;

const DIFF_RULES = `只评审本次改动：
1. 正确性、边界条件、空值与类型问题。
2. 错误处理与资源释放。
3. 安全与数据保护。
4. 并发、幂等与性能退化。
5. 明显的测试缺口。
不要要求重构本次改动之外的代码。`;

/** `--rule` payload: one rule per review type, merged with OCR's built-ins. */
export function buildRules({ type, scope } = {}) {
  let pattern = '**';
  if (type === 'module' && Array.isArray(scope?.paths) && scope.paths.length) {
    // The module scan is already scoped by --path; a broad glob keeps every
    // selected file covered while merge_system_rule adds built-in checks.
    pattern = '**';
  }
  const rule = type === 'architecture'
    ? ARCH_RULES
    : type === 'flow'
      ? FLOW_RULES
      : type === 'module'
        ? MODULE_RULES
        : DIFF_RULES;
  return {
    rules: [
      { path: pattern, rule, merge_system_rule: true },
    ],
  };
}

export function buildScanAnchorPaths(type, analysis, project) {
  if (type === 'flow') {
    const files = new Set();
    for (const flow of analysis?.flows ?? []) {
      const entryFile = flow?.entry?.file;
      if (entryFile) files.add(entryFile);
      for (const step of flow?.steps ?? []) if (step?.file) files.add(step.file);
      for (const item of flow?.data ?? []) if (item?.file) files.add(item.file);
    }
    return [...files].slice(0, 24);
  }
  if (type === 'architecture') {
    const anchors = new Set();
    for (const file of ['README.md', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'compose.yaml', 'docker-compose.yml', 'Dockerfile', '.env.example']) {
      if (project?.path) anchors.add(file);
    }
    // Entry points of the largest modules are the cheapest architecture anchors.
    const nodes = (analysis?.graph?.nodes ?? [])
      .slice()
      .sort((a, b) => Number(b.loc ?? 0) - Number(a.loc ?? 0))
      .slice(0, 8);
    for (const node of nodes) {
      for (const file of node.entryFiles ?? []) anchors.add(file);
    }
    return [...anchors].slice(0, 24);
  }
  return [];
}

export function buildSummaryNotes({ type, engine, analysis, ocrResult }) {
  const notes = [];
  if (engine === 'structural') {
    notes.push('当前仅完成离线结构分析：OCR 的 LLM 尚未配置，AI 评审已跳过。');
  }
  if (ocrResult?.warnings?.length) {
    notes.push(`OCR 报告 ${ocrResult.warnings.length} 条告警：${trimText(ocrResult.warnings[0]?.message ?? '', 160)}`);
  }
  if (analysis?.summary?.errors?.length) {
    notes.push(`结构分析有 ${analysis.summary.errors.length} 个文件读取失败。`);
  }
  return notes;
}
