import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyzeArchitecture,
  analyzeDiff,
  analyzeFlow,
  analyzeModule,
} from '../../plugins/dsh-code-review/host/analyze.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const READ = (path) => readFile(path, 'utf8');
const projectOf = (name) => ({
  name,
  path: join(FIXTURES, name),
  language: 'JavaScript',
});

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const CATEGORIES = new Set([
  'bug', 'security', 'performance', 'maintainability',
  'test', 'style', 'documentation', 'other',
]);
const ACTIVITY_LEVELS = new Set(['info', 'success', 'warn']);

function assertAnalysisShape(analysis, label) {
  assert.ok(analysis && typeof analysis === 'object', `${label}: 返回对象`);
  assert.ok(Array.isArray(analysis.findings), `${label}: findings 数组`);
  assert.ok(analysis.metrics && typeof analysis.metrics === 'object', `${label}: metrics 对象`);
  assert.ok(analysis.summary && typeof analysis.summary === 'object', `${label}: summary 对象`);
  assert.ok(typeof analysis.metrics.files === 'number', `${label}: metrics.files 数字`);
  assert.ok(Array.isArray(analysis.summary.notes), `${label}: notes 数组`);
  assert.ok(analysis.summary.notes.length >= 3 && analysis.summary.notes.length <= 6,
    `${label}: notes 3-6 条（实际 ${analysis.summary.notes.length}）`);
  assert.ok(typeof analysis.summary.headline === 'string' && analysis.summary.headline.length > 0,
    `${label}: headline 非空`);
  assert.ok(analysis.summary.headline.length <= 40, `${label}: headline ≤40 字（实际 ${analysis.summary.headline.length}）`);
  assert.ok(Array.isArray(analysis.activity), `${label}: activity 数组`);
  assert.ok(analysis.activity.length >= 5 && analysis.activity.length <= 20,
    `${label}: activity 5-20 条（实际 ${analysis.activity.length}）`);
  for (const item of analysis.activity) {
    assert.ok(typeof item.ts === 'string' && !Number.isNaN(Date.parse(item.ts)), `${label}: activity.ts 是 ISO 时间`);
    assert.ok(ACTIVITY_LEVELS.has(item.level), `${label}: activity.level 合法（${item.level}）`);
    assert.ok(typeof item.text === 'string' && item.text.length > 0, `${label}: activity.text 非空`);
  }
  if (analysis.graph) {
    assert.ok(Array.isArray(analysis.graph.nodes), `${label}: graph.nodes 数组`);
    assert.ok(Array.isArray(analysis.graph.edges), `${label}: graph.edges 数组`);
    assert.ok(Array.isArray(analysis.graph.cycles), `${label}: graph.cycles 数组`);
    assert.ok(analysis.graph.meta && typeof analysis.graph.meta.otherCount === 'number',
      `${label}: graph.meta.otherCount 数字`);
    for (const node of analysis.graph.nodes) {
      assert.ok(typeof node.id === 'string' && node.id.length > 0, `${label}: node.id`);
      assert.ok(typeof node.label === 'string' && node.label.length > 0, `${label}: node.label`);
      assert.ok(typeof node.kind === 'string' && node.kind.length > 0, `${label}: node.kind`);
      assert.ok(typeof node.path === 'string', `${label}: node.path`);
      assert.ok(Number.isFinite(node.loc), `${label}: node.loc 数字`);
      assert.ok(['high', 'medium', 'low'].includes(node.risk), `${label}: node.risk 合法`);
      assert.ok(Array.isArray(node.entryFiles), `${label}: node.entryFiles 数组`);
      assert.ok(node.meta && typeof node.meta === 'object', `${label}: node.meta 对象`);
    }
    for (const edge of analysis.graph.edges) {
      assert.ok(typeof edge.from === 'string' && typeof edge.to === 'string', `${label}: edge from/to`);
      assert.ok(typeof edge.kind === 'string' && edge.kind.length > 0, `${label}: edge.kind`);
      assert.ok(Number.isFinite(edge.count) && edge.count > 0, `${label}: edge.count 正数`);
      assert.ok(['high', 'medium', 'low'].includes(edge.risk), `${label}: edge.risk 合法`);
    }
  }
}

function assertFindingsComplete(findings, label) {
  assert.ok(findings.length > 0, `${label}: 至少一条 finding`);
  for (const item of findings) {
    assert.match(item.id, /^f-[0-9a-f]+$/, `${label}: finding.id`);
    assert.ok(SEVERITIES.has(item.severity), `${label}: finding.severity（${item.severity}）`);
    assert.ok(CATEGORIES.has(item.category), `${label}: finding.category（${item.category}）`);
    assert.ok(typeof item.path === 'string' && item.path.length > 0, `${label}: finding.path`);
    assert.ok(!item.path.startsWith('/'), `${label}: finding.path 使用 repo 相对路径（${item.path}）`);
    assert.ok(Number.isFinite(item.startLine) && item.startLine >= 0, `${label}: finding.startLine`);
    assert.ok(Number.isFinite(item.endLine) && item.endLine >= item.startLine - 1, `${label}: finding.endLine`);
    assert.ok(typeof item.title === 'string' && item.title.length > 0, `${label}: finding.title`);
    assert.ok(typeof item.content === 'string' && item.content.length > 0, `${label}: finding.content`);
    assert.equal(item.source, 'structural', `${label}: finding.source`);
    assert.ok(typeof item.rule === 'string' && item.rule.length > 0, `${label}: finding.rule`);
    assert.ok(typeof item.module === 'string', `${label}: finding.module`);
  }
}

const architecture = await analyzeArchitecture({ project: projectOf('arch-demo'), files: [], readFile: READ });
const moduleAnalysis = await analyzeModule({
  project: projectOf('module-demo'),
  modulePath: 'src',
  files: ['src/ugly.js', 'src/types.ts', 'src/dup.js', 'src/big.js', 'src/long.js'],
  readFile: READ,
});
const flow = await analyzeFlow({ project: projectOf('flow-demo'), files: [], readFile: READ });
const diffText = await READ(join(FIXTURES, 'diff-demo/patch.diff'));
const diff = await analyzeDiff({
  project: projectOf('diff-demo'),
  files: ['src/app.js'],
  diffText,
  readFile: READ,
});

test('architecture: 循环依赖 / 模块依赖图 / 高风险 finding', () => {
  assertAnalysisShape(architecture, 'architecture');
  assert.ok(architecture.graph, 'architecture: graph 非空');
  assert.ok(architecture.graph.cycles.length >= 2,
    `architecture: 至少 2 组循环依赖（实际 ${architecture.graph.cycles.length}）`);
  assert.ok(architecture.graph.edges.length > 0, 'architecture: 模块依赖边非空');
  assert.ok(architecture.metrics.modules >= 4, 'architecture: 模块数 ≥4');
  assert.ok(architecture.metrics.edges > 0, 'architecture: metrics.edges > 0');
  assert.equal(architecture.metrics.cycles, architecture.graph.cycles.length, 'architecture: metrics.cycles 与 graph 一致');
  assert.ok(architecture.graph.nodes.length <= 40, 'architecture: 节点 ≤40');
  assert.ok(architecture.graph.nodes.every((node) => node.kind === 'module'), 'architecture: 节点 kind=module');
  assert.ok(architecture.graph.edges.every((edge) => edge.kind === 'import'), 'architecture: 边 kind=import');
  assert.ok(architecture.graph.nodes.some((node) => node.entryFiles.length > 0), 'architecture: 入口文件可作为锚点');

  assertFindingsComplete(architecture.findings, 'architecture');
  assert.ok(architecture.findings.some((item) => item.severity === 'high'), 'architecture: 存在 high finding');
  const rules = new Set(architecture.findings.map((item) => item.rule));
  assert.ok(rules.has('arch.cycle'), 'architecture: 命中循环依赖规则');
  assert.ok(rules.has('arch.god-module'), 'architecture: 命中 god module 规则');
  assert.ok(rules.has('arch.missing-tests'), 'architecture: 命中缺测试规则');
  assert.ok(architecture.findings.every((item) => item.module !== ''), 'architecture: finding.module 有归属');
});

test('architecture: 显式 files 列表（字符串/对象混合）同样可用', async () => {
  const explicit = await analyzeArchitecture({
    project: projectOf('arch-demo'),
    files: [
      'src/users/service.js',
      { path: 'src/billing/charge.js' },
      { path: 'src/billing/ledger/tax.js', loc: 8 },
      { path: 'src/billing/ledger/money.js' },
    ],
    readFile: READ,
  });
  assertAnalysisShape(explicit, 'architecture-explicit');
  assert.equal(explicit.metrics.files, 4, 'architecture-explicit: 只分析传入文件');
  assert.ok(explicit.graph && explicit.graph.cycles.length >= 1, 'architecture-explicit: 显式列表下仍检出循环依赖');
  assert.ok(explicit.findings.some((item) => item.rule === 'arch.cycle' && item.severity === 'high'),
    'architecture-explicit: 循环依赖为 high');
});

test('module: 超大文件 / 长函数 / 危险模式 / 重复代码', () => {
  assertAnalysisShape(moduleAnalysis, 'module');
  assert.ok(moduleAnalysis.graph, 'module: graph 非空');
  assert.ok(moduleAnalysis.graph.nodes.length <= 30, 'module: 节点 ≤30');
  assert.ok(moduleAnalysis.graph.nodes.every((node) => node.kind === 'file'), 'module: 节点 kind=file');
  assert.ok(moduleAnalysis.graph.edges.length >= 1, 'module: 文件依赖边非空');
  assert.ok(moduleAnalysis.graph.edges.every((edge) => edge.kind === 'import'), 'module: 边 kind=import');
  assert.equal(moduleAnalysis.metrics.files, 5, 'module: metrics.files 为实际分析文件数');
  assert.equal(moduleAnalysis.metrics.largestFile.path, 'src/big.js', 'module: largestFile 正确');
  assert.ok(moduleAnalysis.metrics.largestFile.loc > 800, 'module: largestFile 行数 >800');
  assert.ok(moduleAnalysis.metrics.functions >= 5, 'module: 函数数 ≥5');

  assertFindingsComplete(moduleAnalysis.findings, 'module');
  const rules = new Set(moduleAnalysis.findings.map((item) => item.rule));
  for (const rule of [
    'module.large-file', 'module.long-function', 'module.hardcoded-secret',
    'module.dangerous-eval', 'module.empty-catch', 'module.swallowed-error',
    'module.innerHTML', 'module.debug-leftover', 'module.todo',
    'module.duplicate-code', 'module.explicit-any',
  ]) {
    assert.ok(rules.has(rule), `module: 命中 ${rule}`);
  }
  assert.ok(moduleAnalysis.findings.filter((item) => item.severity === 'high').length >= 2, 'module: 至少 2 条 high');
});

test('flow: monorepo 路径别名仍能解析服务与数据节点', async () => {
  const aliasFlow = await analyzeFlow({
    project: projectOf('flow-alias'),
    files: [],
    readFile: READ,
  });
  assertAnalysisShape(aliasFlow, 'flow-alias');
  const kinds = new Set(aliasFlow.graph.nodes.map((node) => node.kind));
  assert.ok(kinds.has('entry'), 'flow-alias: 含 entry');
  assert.ok(kinds.has('service'), 'flow-alias: @/services/order 解析为 service');
  assert.ok(kinds.has('data'), 'flow-alias: service 内的 db 访问解析为 data');
  assert.ok(aliasFlow.flows.some((flow) => flow.data.length > 0), 'flow-alias: 链路含数据步骤');
});

test('flow: 入口超过 40 个时仍保留下游服务/数据节点', async () => {
  const manyFlow = await analyzeFlow({
    project: projectOf('flow-alias'),
    files: [],
    readFile: READ,
  });
  const kinds = new Set(manyFlow.graph.nodes.map((node) => node.kind));
  assert.ok(manyFlow.graph.nodes.length > 40, 'flow-many: 保留超过 40 个节点');
  assert.ok(kinds.has('service'), 'flow-many: 入口很多时仍保留 service');
  assert.ok(kinds.has('data'), 'flow-many: 入口很多时仍保留 data');
});

test('flow: 入口识别 / 服务链路 / 数据节点 / 缺校验 finding', () => {
  assertAnalysisShape(flow, 'flow');
  assert.ok(flow.graph, 'flow: graph 非空');
  assert.ok(flow.metrics.entries >= 2, `flow: 至少 2 个入口（实际 ${flow.metrics.entries}）`);
  assert.ok(Array.isArray(flow.flows) && flow.flows.length >= 2, 'flow: flows 数组 ≥2 条');
  assert.ok(flow.metrics.byKind.http >= 2, 'flow: 至少 2 个 HTTP 入口');
  const kinds = new Set(flow.graph.nodes.map((node) => node.kind));
  assert.ok(kinds.has('entry'), 'flow: graph 含 entry 节点');
  assert.ok(kinds.has('data') || kinds.has('external'), 'flow: graph 含 data/external 节点');
  assert.ok(kinds.has('service'), 'flow: graph 含 service 节点');
  assert.ok(flow.graph.edges.length > 0, 'flow: graph 边非空');
  assert.ok(flow.graph.nodes.length <= 40, 'flow: 节点 ≤40');
  for (const edge of flow.graph.edges) {
    assert.ok(['call', 'read', 'write', 'emit', 'http'].includes(edge.kind), `flow: edge.kind 合法（${edge.kind}）`);
  }
  for (const item of flow.flows) {
    assert.ok(item.id.startsWith('flow-'), 'flow: flow.id');
    assert.ok(item.entry && item.entry.file && item.entry.line > 0, 'flow: flow.entry 有真实行号');
    assert.ok(Array.isArray(item.steps), 'flow: flow.steps 数组');
    assert.ok(Array.isArray(item.data), 'flow: flow.data 数组');
    for (const step of item.steps) {
      assert.ok(typeof step.label === 'string' && step.label.length > 0, 'flow: step.label');
      assert.ok(typeof step.file === 'string' && step.file.length > 0, 'flow: step.file');
    }
    for (const dataItem of item.data) {
      assert.ok(typeof dataItem.kind === 'string', 'flow: data.kind');
      assert.ok(typeof dataItem.name === 'string' && dataItem.name.length > 0, 'flow: data.name');
      assert.ok(dataItem.line > 0, 'flow: data.line 有真实行号');
    }
  }

  assertFindingsComplete(flow.findings, 'flow');
  const rules = new Set(flow.findings.map((item) => item.rule));
  assert.ok(rules.has('flow.missing-validation'), 'flow: 命中缺参数校验');
  assert.ok(rules.has('flow.write-without-transaction'), 'flow: 命中写路径无事务');
  assert.ok(rules.has('flow.swallowed-error'), 'flow: 命中吞异常');
  assert.ok(rules.has('flow.sensitive-log'), 'flow: 命中敏感日志');
  assert.ok(rules.has('flow.missing-auth'), 'flow: 命中疑似缺鉴权');
  assert.ok(flow.findings.some((item) => item.severity === 'high'), 'flow: 存在 high finding');
  assert.ok(flow.findings.every((item) => item.path.startsWith('src/') || item.path.startsWith('web/')),
    'flow: finding.path 为 repo 相对路径');
});

test('diff: 新增行启发式 / 真实行号 / 字段完整', () => {
  assertAnalysisShape(diff, 'diff');
  assert.equal(diff.graph, null, 'diff: graph 为 null');
  assert.equal(diff.metrics.mode, 'patch', 'diff: 使用 patch 模式');
  assert.equal(diff.metrics.files, 1, 'diff: 分析 1 个文件');
  assert.ok(diff.metrics.addedLines >= 10, 'diff: 新增行统计');
  assertFindingsComplete(diff.findings, 'diff');
  assert.ok(diff.findings.length >= 2, `diff: 至少 2 条 finding（实际 ${diff.findings.length}）`);
  const rules = new Set(diff.findings.map((item) => item.rule));
  assert.ok(rules.has('diff.hardcoded-secret'), 'diff: 命中硬编码密钥');
  assert.ok(rules.has('diff.empty-catch'), 'diff: 命中空 catch');
  assert.ok(rules.has('diff.innerhtml'), 'diff: 命中 innerHTML');
  assert.ok(rules.has('diff.debug-leftover'), 'diff: 命中调试残留');
  assert.ok(diff.findings.some((item) => item.severity === 'high'), 'diff: 存在 high finding');
  const secret = diff.findings.find((item) => item.rule === 'diff.hardcoded-secret');
  assert.equal(secret.path, 'src/app.js', 'diff: 命中文件路径');
  assert.equal(secret.startLine, 11, 'diff: 新增行真实行号（hunk +10 后第 2 行）');
  assert.ok(diff.findings.every((item) => item.startLine > 0), 'diff: 所有 finding 有真实行号');
});

test('diff: 无 diffText 时回退到文件轻量检查', async () => {
  const fallback = await analyzeDiff({
    project: projectOf('module-demo'),
    files: ['src/ugly.js'],
    diffText: '',
    readFile: READ,
  });
  assertAnalysisShape(fallback, 'diff-fallback');
  assert.equal(fallback.metrics.mode, 'fallback', 'diff-fallback: 模式为 fallback');
  assertFindingsComplete(fallback.findings, 'diff-fallback');
  assert.ok(fallback.findings.some((item) => item.rule === 'diff.debug-leftover'), 'diff-fallback: 命中调试残留');
  assert.ok(fallback.findings.some((item) => item.rule === 'diff.empty-catch'), 'diff-fallback: 命中空 catch');
});

test('architecture: 多语言 import 解析（Python/Go/Java/Rust/PHP/Ruby）', async () => {
  const multilang = await analyzeArchitecture({
    project: projectOf('arch-multilang'),
    files: [],
    readFile: READ,
  });
  assertAnalysisShape(multilang, 'architecture-multilang');
  assert.ok(multilang.metrics.files >= 12, `architecture-multilang: 解析文件（${multilang.metrics.files}）`);
  assert.ok(multilang.metrics.modules >= 10, `architecture-multilang: 顶层模块（${multilang.metrics.modules}）`);
  assert.ok(multilang.metrics.edges >= 5, `architecture-multilang: 跨模块依赖边（${multilang.metrics.edges}）`);
  assert.equal(multilang.metrics.unresolvedImports, 0, 'architecture-multilang: 无未解析的相对/同仓依赖');
  assert.ok(multilang.metrics.languages.length >= 6, 'architecture-multilang: 识别 6 种语言');
  const langs = new Set(multilang.metrics.languages.map((item) => item.language));
  for (const lang of ['py', 'go', 'java', 'rust', 'php', 'ruby']) {
    assert.ok(langs.has(lang), `architecture-multilang: 识别 ${lang}`);
  }
  const edgePairs = new Set(multilang.graph.edges.map((edge) => `${edge.from}->${edge.to}`));
  for (const pair of ['pyentry->pyservice', 'goentry->goservice', 'javaentry->javaservice', 'phpentry->phpservice', 'rubyentry->rubyservice']) {
    assert.ok(edgePairs.has(pair), `architecture-multilang: 依赖边 ${pair}`);
  }
  assert.ok(multilang.graph.nodes.every((node) => node.kind === 'module' && Array.isArray(node.entryFiles)),
    'architecture-multilang: 节点 kind=module 且带 entryFiles');
});

test('空项目：四个分析器都返回合法结构且不抛异常', async () => {
  const emptyProject = { name: 'empty-demo', path: join(FIXTURES, 'empty-demo') };
  const results = await Promise.all([
    analyzeArchitecture({ project: emptyProject, files: [], readFile: READ }),
    analyzeModule({ project: emptyProject, modulePath: 'src', files: [], readFile: READ }),
    analyzeFlow({ project: emptyProject, files: [], readFile: READ }),
    analyzeDiff({ project: emptyProject, files: [], diffText: '', readFile: READ }),
  ]);
  const [emptyArch, emptyModule, emptyFlow, emptyDiff] = results;
  for (const [label, analysis] of [
    ['empty-architecture', emptyArch],
    ['empty-module', emptyModule],
    ['empty-flow', emptyFlow],
    ['empty-diff', emptyDiff],
  ]) {
    assertAnalysisShape(analysis, label);
    assert.deepEqual(analysis.findings, [], `${label}: findings 为空`);
    assert.equal(analysis.metrics.files, 0, `${label}: metrics.files 为 0`);
  }
  assert.ok(emptyArch.graph && emptyArch.graph.nodes.length === 0, 'empty-architecture: 空图');
  assert.deepEqual(emptyArch.graph.cycles, [], 'empty-architecture: 无 cycles');
  assert.ok(emptyModule.graph && emptyModule.graph.nodes.length === 0, 'empty-module: 空图');
  assert.ok(emptyFlow.graph && emptyFlow.graph.nodes.length === 0, 'empty-flow: 空图');
  assert.equal(emptyDiff.graph, null, 'empty-diff: graph 为 null');
});
