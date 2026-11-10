/**
 * Deterministic mock data for the standalone client preview.
 *
 * The harness loads the real `plugins/dsh-code-review/client.js` and serves this
 * document through a fake `connection.rpc.call`, so the UI is exercised against
 * exactly the shapes in docs/CODE-REVIEW-CONTRACT.md. Nothing here ships with
 * the plugin: it only exists so the page can be rendered and screenshotted
 * without a live Host.
 */

const DAY = 86400_000;

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateKey(ts) {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(key, amount) {
  const [year, month, day] = key.split('-').map(Number);
  return dateKey(new Date(year, month - 1, day + amount).getTime());
}

function iso(ts) {
  return new Date(ts).toISOString();
}

// Small deterministic PRNG so every screenshot run renders the same page.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TODAY = Date.now();
const TODAY_KEY = dateKey(TODAY);

function buildHeatmap(days, profile, random) {
  const to = TODAY_KEY;
  const from = addDays(to, -(days - 1));
  const list = [];
  let cursor = from;
  let total = 0;
  let insertions = 0;
  let deletions = 0;
  let max = 0;
  let busiest = { date: from, commits: 0 };
  let current = 0;
  let longest = 0;
  let run = 0;
  for (let index = 0; index < days; index += 1) {
    const weekday = new Date(`${cursor}T12:00:00`).getDay();
    const weekend = weekday === 0 || weekday === 6;
    const wave = Math.sin(index / 17) * 0.5 + 0.5;
    const chance = (weekend ? 0.22 : 0.82) * wave * profile.density;
    const active = random() < chance;
    const commits = active ? 1 + Math.floor(random() * profile.max) : 0;
    const plus = commits ? 20 + Math.floor(random() * 260 * profile.max / 6) : 0;
    const minus = commits ? 5 + Math.floor(random() * 90 * profile.max / 6) : 0;
    if (commits > 0) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
    total += commits;
    insertions += plus;
    deletions += minus;
    if (commits > max) {
      max = commits;
      busiest = { date: cursor, commits };
    }
    list.push({ date: cursor, commits, insertions: plus, deletions: minus });
    cursor = addDays(cursor, 1);
  }
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index].commits > 0) current += 1;
    else break;
  }
  return {
    from,
    to,
    days: list,
    spark: list.slice(-90).map((day) => day.commits),
    max,
    totalCommits: total,
    totalInsertions: insertions,
    totalDeletions: deletions,
    streaks: { current, longest },
    busiest,
    activeDays: list.filter((day) => day.commits > 0).length,
  };
}

const PROJECT_SEEDS = [
  {
    id: 'p-mopng-api', name: 'mopng-api', path: '/Users/jkin/workspace/jkin8010/mopng-api',
    branch: 'main', head: 'bf9c296', headSubject: '重构 README.md 和 SKILL.md，更新描述和配置说明',
    committedAt: iso(TODAY - 2 * 3600_000), dirty: true, remote: 'https://github.com/jkin8010/mopng-api.git',
    language: 'Python', fileCount: 48, moduleCount: 7, loc: 8_640, density: 0.9, max: 6,
    modules: [
      { id: 'm-mopng', name: 'mopng', path: 'mopng', files: 14, loc: 3_180, lastCommitAt: iso(TODAY - 2 * 3600_000), lastReviewAt: iso(TODAY - 1 * DAY), reviewCount: 5, findings: { critical: 1, high: 2, medium: 3, low: 1, total: 7 }, risk: 'medium' },
      { id: 'm-tests', name: 'tests', path: 'tests', files: 9, loc: 1_240, lastCommitAt: iso(TODAY - 3 * DAY), lastReviewAt: iso(TODAY - 1 * DAY), reviewCount: 2, findings: { critical: 0, high: 0, medium: 1, low: 2, total: 3 }, risk: 'low' },
      { id: 'm-scripts', name: 'scripts', path: 'scripts', files: 6, loc: 640, lastCommitAt: iso(TODAY - 6 * DAY), lastReviewAt: null, reviewCount: 0, findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 }, risk: 'low' },
      { id: 'm-docs', name: 'docs', path: 'docs', files: 8, loc: 1_320, lastCommitAt: iso(TODAY - 6 * DAY), lastReviewAt: null, reviewCount: 0, findings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 }, risk: 'low' },
    ],
  },
  {
    id: 'p-mopng-desktop', name: 'mopng-desktop', path: '/Users/jkin/workspace/jkin8010/mopng-desktop',
    branch: 'main', head: '5de0a44', headSubject: '桌面端接入 mopng 公共 API',
    committedAt: iso(TODAY - 12 * 3600_000), dirty: false, remote: 'https://github.com/jkin8010/mopng-desktop.git',
    language: 'TypeScript', fileCount: 128, moduleCount: 10, loc: 21_600, density: 0.72, max: 7,
    modules: [
      { id: 'm-app', name: 'app', path: 'src/app', files: 31, loc: 5_200, lastCommitAt: iso(TODAY - 12 * 3600_000), lastReviewAt: iso(TODAY - 4 * DAY), reviewCount: 3, findings: { critical: 0, high: 1, medium: 2, low: 1, total: 4 }, risk: 'medium' },
    ],
  },
  {
    id: 'p-fastrtc', name: 'fastrtc-talking-more', path: '/Users/jkin/workspace/jkin8010/fastrtc-talking-more',
    branch: 'main', head: '90ff31a', headSubject: '接入实时语音对话',
    committedAt: iso(TODAY - 3 * DAY), dirty: false, remote: 'https://github.com/jkin8010/fastrtc-talking-more.git',
    language: 'Python', fileCount: 39, moduleCount: 6, loc: 6_300, density: 0.55, max: 4,
    modules: [],
  },
  {
    id: 'p-image-matting', name: 'image-matting', path: '/Users/jkin/workspace/jkin8010/image-matting',
    branch: 'main', head: 'c41e7a2', headSubject: '优化边缘羽化与实时推理',
    committedAt: iso(TODAY - 5 * DAY), dirty: false, remote: 'https://github.com/jkin8010/image-matting.git',
    language: 'Rust', fileCount: 84, moduleCount: 8, loc: 15_200, density: 0.48, max: 5,
    modules: [],
  },
  {
    id: 'p-usee-art-canvas', name: 'usee-art-canvas', path: '/Users/jkin/workspace/jkin8010/usee-art-canvas',
    branch: 'main', head: '6b1f2c9', headSubject: '画布图层与导出管线重构',
    committedAt: iso(TODAY - 8 * DAY), dirty: false, remote: 'https://github.com/jkin8010/usee-art-canvas.git',
    language: 'TypeScript', fileCount: 156, moduleCount: 12, loc: 24_800, density: 0.52, max: 6,
    modules: [],
  },
  {
    id: 'p-synapse-registry', name: 'synapse-registry', path: '/Users/jkin/workspace/jkin8010/synapse-registry',
    branch: 'main', head: 'a31d7e0', headSubject: '注册中心支持模型能力标签',
    committedAt: iso(TODAY - 11 * DAY), dirty: false, remote: 'https://github.com/jkin8010/synapse-registry.git',
    language: 'TypeScript', fileCount: 74, moduleCount: 7, loc: 9_600, density: 0.46, max: 4,
    modules: [],
  },
  {
    id: 'p-synapse-router', name: 'synapse-router', path: '/Users/jkin/workspace/jkin8010/synapse-router',
    branch: 'main', head: '2f6d8b1', headSubject: '路由策略支持按模型与区域分流',
    committedAt: iso(TODAY - 15 * 3600_000), dirty: true, remote: 'https://github.com/jkin8010/synapse-router.git',
    language: 'TypeScript', fileCount: 96, moduleCount: 9, loc: 13_800, density: 0.62, max: 5,
    modules: [],
  },
  {
    id: 'p-dsh-code-review', name: 'dsh-code-review', path: '/Users/jkin/workspace/jkin8010/dsh-code-review',
    branch: 'main', head: 'deaf7fc', headSubject: 'docs: 更新截图与交付说明',
    committedAt: iso(TODAY - 26 * 3600_000), dirty: false, remote: 'https://github.com/jkin8010/dsh-code-review.git',
    language: 'JavaScript', fileCount: 24, moduleCount: 5, loc: 12_800, density: 0.5, max: 3,
    modules: [],
  },
];

const FINDING_LIBRARY = {
  workspace: [
    {
      severity: 'critical', category: 'security', path: 'mopng_api.py', startLine: 118, endLine: 131,
      title: 'URL 白名单仅做前缀匹配，可被相似域名绕过',
      content: '`url.startswith("https://motu.xyz")` 会把 `https://motu.xyz.evil.com/collect` 也放行，攻击者可借公开 API 转发到自己的域名，造成 SSRF 与配额盗用。建议解析 host 后做精确域名或后缀比对，并拒绝非 443 端口与内网地址。',
      existingCode: "if not url.startswith(\"https://motu.xyz\"):\n    raise ValueError(\"invalid url\")",
      suggestionCode: "parsed = urlparse(url)\nif parsed.scheme != \"https\" or parsed.port not in (None, 443):\n    raise ValueError(\"invalid url\")\nif not (parsed.hostname == \"motu.xyz\" or parsed.hostname.endswith(\".motu.xyz\")):\n    raise ValueError(\"invalid url\")",
      source: 'ocr', rule: 'security/ssrf', module: 'mopng',
    },
    {
      severity: 'high', category: 'bug', path: 'mopng_api.py', startLine: 214, endLine: 236,
      title: '重试循环复用上一次的 response 变量',
      content: '循环内 `response` 只在成功分支赋值，第 2 次重试若在 `raise_for_status()` 抛错前退出，会返回上一轮残留的 response，导致调用方拿到过期结果。建议每轮重置为 None，并在循环结束后显式校验。',
      existingCode: "for attempt in range(3):\n    response = session.get(url, timeout=10)\n    if response.ok:\n        break",
      suggestionCode: "response = None\nfor attempt in range(3):\n    response = session.get(url, timeout=10)\n    if response.ok:\n        break\nif response is None or not response.ok:\n    raise RuntimeError(\"motu api failed\")",
      source: 'ocr', rule: 'bug/retry-state', module: 'mopng',
    },
    {
      severity: 'high', category: 'security', path: 'mopng_api.py', startLine: 87, endLine: 92,
      title: '异常日志中回显完整 API Key',
      content: '`logger.exception(\"auth failed: %s\", headers)` 会把 `Authorization` 头完整写进日志文件，日志聚合后等同密钥泄露。应改为只记录 key 的指纹或前 4 位。',
      existingCode: "except HTTPError as exc:\n    logger.exception(\"auth failed: %s\", headers)\n    raise",
      suggestionCode: "except HTTPError as exc:\n    logger.error(\"auth failed: status=%s key=%s***\", exc.status_code, api_key[:4])\n    raise",
      source: 'ocr', rule: 'security/secret-log', module: 'mopng',
    },
    {
      severity: 'medium', category: 'performance', path: 'mopng_api.py', startLine: 150, endLine: 158,
      title: '每次请求都新建 aiohttp session',
      content: '`async with aiohttp.ClientSession()` 放在单次调用里，连接无法复用，高频调用时握手开销明显。建议模块级复用 session，并在应用关闭时释放。',
      source: 'ocr', rule: 'performance/connection-reuse', module: 'mopng',
    },
    {
      severity: 'medium', category: 'maintainability', path: 'mopng_api.py', startLine: 301, endLine: 512,
      title: '函数 `call_mot u_agent` 过长且职责混杂',
      content: '单函数 210 行，同时负责参数拼装、重试、响应解析与错误映射。建议拆成 `build_payload` / `request_with_retry` / `parse_response` 三个私有函数，便于测试与复用。',
      source: 'structural', rule: 'module/long-function', module: 'mopng',
    },
    {
      severity: 'low', category: 'test', path: 'tests/test_api.py', startLine: 0, endLine: 0,
      title: '新增的 URL 校验分支缺少测试',
      content: '本次新增的域名白名单与端口校验没有被测试覆盖，建议补充合法域名、相似域名、内网地址三类用例。',
      source: 'ocr', rule: 'test/missing-branch', module: 'tests',
    },
    {
      severity: 'low', category: 'style', path: 'mopng_api.py', startLine: 12, endLine: 12,
      title: '未使用的 import `json`',
      content: '`import json` 在文件中不再被引用，建议移除。',
      source: 'structural', rule: 'module/unused-import', module: 'mopng',
    },
  ],
  architecture: [
    {
      severity: 'high', category: 'maintainability', path: 'mopng/api/client.py', startLine: 1, endLine: 40,
      title: '`mopng.api` 与 `mopng.models` 之间存在双向依赖环',
      content: '`api/client.py` 导入 `models.task.Task`，而 `models/task.py` 又导入 `api.client.request`。环会放大初始化顺序问题，也让模块无法独立测试。建议把共享 DTO 下沉到 `mopng.contracts`，由两侧单向依赖。',
      source: 'structural', rule: 'architecture/cycle', module: 'api',
    },
    {
      severity: 'medium', category: 'maintainability', path: 'scripts/backfill.py', startLine: 18, endLine: 46,
      title: '运维脚本直接 import 内部实现模块',
      content: '`scripts/backfill.py` 直接引用 `mopng.api.client._session`，绕过了对外接口。建议通过公共函数或独立 CLI 入口暴露能力，否则内部重构会反复破坏脚本。',
      source: 'ocr', rule: 'architecture/boundary', module: 'scripts',
    },
    {
      severity: 'medium', category: 'maintainability', path: 'mopng_api.py', startLine: 1, endLine: 860,
      title: '上帝模块：单文件 860 行承载 6 类职责',
      content: '`mopng_api.py` 同时包含 HTTP 客户端、重试、参数校验、错误映射与 CLI，是仓库中最大的模块。建议按职责拆分到 `client/`、`contract/`、`cli/` 三个包。',
      source: 'structural', rule: 'architecture/god-module', module: 'mopng',
    },
    {
      severity: 'low', category: 'test', path: 'scripts/', startLine: 0, endLine: 0,
      title: '`scripts` 模块没有任何测试',
      content: '脚本目录承载了数据回填与发布操作，却没有测试。至少应覆盖参数解析与失败退出码。',
      source: 'structural', rule: 'architecture/untested-module', module: 'scripts',
    },
  ],
  flow: [
    {
      severity: 'high', category: 'security', path: 'mopng_api.py', startLine: 66, endLine: 84,
      title: '入口 `/v1/messages` 缺少请求体 schema 校验',
      content: '链路：POST /v1/messages → `handle_message` → `call_motu_agent` → 外部 API。入口只检查字段是否存在，未校验类型与长度，超长 `prompt` 会直接进入下游并触发上游 413。',
      source: 'ocr', rule: 'flow/input-validation', module: 'mopng',
    },
    {
      severity: 'high', category: 'bug', path: 'mopng_api.py', startLine: 240, endLine: 288,
      title: '任务写入路径没有幂等键，重试会重复扣费',
      content: '链路：入口 → `create_task` → `INSERT INTO tasks`。客户端超时重试时没有 `idempotency_key`，会生成重复任务并重复调用计费接口。建议入口接收幂等键并落唯一索引。',
      source: 'ocr', rule: 'flow/idempotency', module: 'mopng',
    },
    {
      severity: 'medium', category: 'performance', path: 'mopng_api.py', startLine: 150, endLine: 166,
      title: '外部 HTTP 调用没有显式超时与重试上限',
      content: '链路中的外部调用依赖默认超时，上游变慢时会拖住整个 worker。建议显式设置 connect/read 超时，并对 5xx 做有限次指数退避。',
      source: 'structural', rule: 'flow/external-timeout', module: 'mopng',
    },
    {
      severity: 'medium', category: 'maintainability', path: 'mopng_api.py', startLine: 96, endLine: 104,
      title: '`except Exception` 吞掉错误后返回空结果',
      content: '链路在 `parse_response` 处把异常转成 `{}`，上游无法区分"没有数据"与"下游失败"，导致静默丢单。建议重新抛出带上下文的异常，或返回明确的错误码。',
      source: 'ocr', rule: 'flow/swallowed-error', module: 'mopng',
    },
    {
      severity: 'low', category: 'documentation', path: 'mopng_api.py', startLine: 40, endLine: 48,
      title: '入口与外部依赖的字段映射没有文档',
      content: '`motu` 返回字段与内部 DTO 的映射只存在于代码里，联调时容易错位。建议在模块 docstring 里固定一份字段表。',
      source: 'ocr', rule: 'flow/mapping-doc', module: 'mopng',
    },
  ],
};

function severityCounts(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  for (const item of findings) {
    counts[item.severity] += 1;
    counts.total += 1;
  }
  return counts;
}

function findingsFor(type, seed, count) {
  const source = FINDING_LIBRARY[type] ?? FINDING_LIBRARY.workspace;
  const list = [];
  for (let index = 0; index < count; index += 1) {
    const base = source[index % source.length];
    list.push({
      ...base,
      id: `f-${seed}-${index}`,
      startLine: base.startLine || 0,
      endLine: base.endLine || base.startLine || 0,
    });
  }
  return list;
}

function buildGraph(kind) {
  if (kind === 'flow') {
    return {
      nodes: [
        { id: 'e-messages', label: 'POST /v1/messages', kind: 'entry', path: 'mopng_api.py', files: 1, loc: 60, risk: 'high', entryFiles: ['mopng_api.py'], meta: { line: 66 } },
        { id: 'e-tasks', label: 'POST /v1/tasks', kind: 'entry', path: 'mopng_api.py', files: 1, loc: 42, risk: 'medium', entryFiles: ['mopng_api.py'], meta: { line: 240 } },
        { id: 'e-poll', label: 'GET /v1/tasks/{id}', kind: 'entry', path: 'mopng_api.py', files: 1, loc: 24, risk: 'low', entryFiles: ['mopng_api.py'], meta: { line: 320 } },
        { id: 's-validate', label: 'validate_request', kind: 'service', path: 'mopng/api/validate.py', files: 1, loc: 88, risk: 'high', meta: {} },
        { id: 's-agent', label: 'call_motu_agent', kind: 'service', path: 'mopng/api/client.py', files: 2, loc: 220, risk: 'high', meta: {} },
        { id: 's-task', label: 'create_task', kind: 'service', path: 'mopng/tasks/service.py', files: 2, loc: 140, risk: 'medium', meta: {} },
        { id: 'd-tasks', label: 'tasks 表', kind: 'data', path: 'migrations/001_tasks.sql', files: 1, loc: 30, risk: 'high', meta: { kind: 'sql' } },
        { id: 'd-cache', label: 'Redis 结果缓存', kind: 'data', path: 'mopng/cache.py', files: 1, loc: 70, risk: 'low', meta: { kind: 'cache' } },
        { id: 'x-motu', label: 'motu.xyz API', kind: 'external', path: 'mopng_api.py', files: 1, loc: 0, risk: 'medium', meta: { protocol: 'https' } },
      ],
      edges: [
        { from: 'e-messages', to: 's-validate', kind: 'call', count: 2, risk: 'high' },
        { from: 's-validate', to: 's-agent', kind: 'call', count: 2, risk: 'high' },
        { from: 's-agent', to: 'x-motu', kind: 'http', count: 3, risk: 'medium' },
        { from: 'e-tasks', to: 's-task', kind: 'call', count: 2, risk: 'high' },
        { from: 's-task', to: 'd-tasks', kind: 'write', count: 3, risk: 'high' },
        { from: 'e-poll', to: 'd-tasks', kind: 'read', count: 2, risk: 'low' },
        { from: 's-task', to: 'd-cache', kind: 'write', count: 1, risk: 'low' },
        { from: 's-agent', to: 'd-cache', kind: 'read', count: 1, risk: 'low' },
      ],
      cycles: [],
    };
  }
  return {
    nodes: [
      { id: 'm-mopng-api', label: 'mopng_api', kind: 'module', path: 'mopng_api.py', files: 1, loc: 860, risk: 'high', entryFiles: ['mopng_api.py'], meta: {} },
      { id: 'm-api', label: 'api', kind: 'module', path: 'mopng/api', files: 6, loc: 1_420, risk: 'high', entryFiles: ['mopng/api/client.py'], meta: {} },
      { id: 'm-models', label: 'models', kind: 'module', path: 'mopng/models', files: 4, loc: 620, risk: 'medium', entryFiles: ['mopng/models/task.py'], meta: {} },
      { id: 'm-tasks', label: 'tasks', kind: 'module', path: 'mopng/tasks', files: 5, loc: 980, risk: 'medium', entryFiles: ['mopng/tasks/service.py'], meta: {} },
      { id: 'm-validate', label: 'validate', kind: 'module', path: 'mopng/validate', files: 3, loc: 410, risk: 'low', entryFiles: ['mopng/validate/schema.py'], meta: {} },
      { id: 'm-cache', label: 'cache', kind: 'module', path: 'mopng/cache', files: 2, loc: 180, risk: 'low', entryFiles: ['mopng/cache.py'], meta: {} },
      { id: 'm-config', label: 'config', kind: 'module', path: 'mopng/config.py', files: 1, loc: 120, risk: 'low', entryFiles: ['mopng/config.py'], meta: {} },
      { id: 'm-errors', label: 'errors', kind: 'module', path: 'mopng/errors.py', files: 1, loc: 90, risk: 'low', entryFiles: ['mopng/errors.py'], meta: {} },
      { id: 'm-scripts', label: 'scripts', kind: 'module', path: 'scripts', files: 6, loc: 640, risk: 'medium', entryFiles: ['scripts/backfill.py'], meta: {} },
      { id: 'm-tests', label: 'tests', kind: 'module', path: 'tests', files: 9, loc: 1_240, risk: 'low', entryFiles: [], meta: {} },
      { id: 'm-docs', label: 'docs', kind: 'module', path: 'docs', files: 8, loc: 1_320, risk: 'low', entryFiles: [], meta: {} },
    ],
    edges: [
      { from: 'm-mopng-api', to: 'm-api', kind: 'import', count: 4, risk: 'low' },
      { from: 'm-mopng-api', to: 'm-tasks', kind: 'import', count: 3, risk: 'low' },
      { from: 'm-mopng-api', to: 'm-config', kind: 'import', count: 2, risk: 'low' },
      { from: 'm-api', to: 'm-models', kind: 'import', count: 3, risk: 'high' },
      { from: 'm-models', to: 'm-api', kind: 'import', count: 1, risk: 'high' },
      { from: 'm-api', to: 'm-validate', kind: 'import', count: 2, risk: 'low' },
      { from: 'm-api', to: 'm-cache', kind: 'import', count: 2, risk: 'low' },
      { from: 'm-api', to: 'm-errors', kind: 'import', count: 2, risk: 'low' },
      { from: 'm-tasks', to: 'm-models', kind: 'import', count: 3, risk: 'medium' },
      { from: 'm-tasks', to: 'm-cache', kind: 'import', count: 1, risk: 'low' },
      { from: 'm-tasks', to: 'm-errors', kind: 'import', count: 1, risk: 'low' },
      { from: 'm-validate', to: 'm-errors', kind: 'import', count: 1, risk: 'low' },
      { from: 'm-scripts', to: 'm-api', kind: 'import', count: 2, risk: 'medium' },
      { from: 'm-scripts', to: 'm-models', kind: 'import', count: 1, risk: 'medium' },
      { from: 'm-tests', to: 'm-api', kind: 'import', count: 3, risk: 'low' },
      { from: 'm-tests', to: 'm-tasks', kind: 'import', count: 2, risk: 'low' },
      { from: 'm-docs', to: 'm-mopng-api', kind: 'import', count: 0, risk: 'low' },
    ],
    cycles: [['m-api', 'm-models']],
  };
}

const FLOWS = [
  { id: 'flow-1', name: '消息转发主链路', entry: { kind: 'route', name: 'POST /v1/messages', file: 'mopng_api.py', line: 66 }, steps: [{ kind: 'service', label: 'validate_request', file: 'mopng/api/validate.py', line: 12 }, { kind: 'service', label: 'call_motu_agent', file: 'mopng/api/client.py', line: 88 }], data: [{ kind: 'external', name: 'motu.xyz API', file: 'mopng_api.py', line: 0 }, { kind: 'cache', name: 'Redis 结果缓存', file: 'mopng/cache.py', line: 20 }] },
  { id: 'flow-2', name: '异步任务创建', entry: { kind: 'route', name: 'POST /v1/tasks', file: 'mopng_api.py', line: 240 }, steps: [{ kind: 'service', label: 'create_task', file: 'mopng/tasks/service.py', line: 30 }, { kind: 'service', label: 'enqueue', file: 'mopng/tasks/queue.py', line: 15 }], data: [{ kind: 'table', name: 'tasks 表', file: 'migrations/001_tasks.sql', line: 1 }] },
  { id: 'flow-3', name: '任务状态轮询', entry: { kind: 'route', name: 'GET /v1/tasks/{id}', file: 'mopng_api.py', line: 320 }, steps: [{ kind: 'service', label: 'load_task', file: 'mopng/tasks/service.py', line: 74 }], data: [{ kind: 'table', name: 'tasks 表', file: 'migrations/001_tasks.sql', line: 1 }] },
  { id: 'flow-4', name: '数据回填脚本', entry: { kind: 'cli', name: 'scripts/backfill.py', file: 'scripts/backfill.py', line: 1 }, steps: [{ kind: 'service', label: 'iter_pending', file: 'mopng/tasks/service.py', line: 120 }], data: [{ kind: 'table', name: 'tasks 表', file: 'migrations/001_tasks.sql', line: 1 }] },
];

function buildJobList(random, projects) {
  const specs = [
    { type: 'architecture', daysAgo: 0.01, status: 'running', findings: 0, title: '项目架构评审 · mopng-api', subtitle: '模块依赖 · 分层 · 耦合', progress: 0.62, stage: 'ai' },
    { type: 'workspace', daysAgo: 0.06, status: 'queued', findings: 0, title: '当前改动评审 · helpkit-chat', subtitle: 'staged + unstaged + untracked', progress: 0, stage: 'resolve' },
    { type: 'workspace', daysAgo: 0.3, status: 'completed', findings: 7, title: '当前改动评审 · mopng-api', subtitle: 'staged + unstaged + untracked' },
    { type: 'flow', daysAgo: 0.8, status: 'completed', findings: 5, title: '信息流评审 · mopng-api', subtitle: '业务信息流 · 4 条链路' },
    { type: 'module', daysAgo: 1.1, status: 'completed', findings: 4, title: '代码模块评审 · mopng-api', subtitle: 'mopng/api · mopng/tasks' },
    { type: 'range', daysAgo: 1.4, status: 'completed', findings: 3, title: '分支对比评审 · helpkit-chat', subtitle: 'main → feature/ticket-attachments' },
    { type: 'commit', daysAgo: 1.9, status: 'failed', findings: 0, title: '单次提交评审 · prompt-hub', subtitle: 'commit 7c9b120' },
    { type: 'architecture', daysAgo: 2.2, status: 'completed', findings: 4, title: '项目架构评审 · helpkit-chat', subtitle: '模块依赖 · 分层 · 耦合' },
    { type: 'workspace', daysAgo: 2.6, status: 'completed', findings: 2, title: '当前改动评审 · prompt-hub', subtitle: 'staged + unstaged + untracked' },
    { type: 'module', daysAgo: 3.1, status: 'cancelled', findings: 0, title: '代码模块评审 · banyugou-browser-extension', subtitle: 'src/content' },
    { type: 'flow', daysAgo: 3.4, status: 'completed', findings: 3, title: '信息流评审 · helpkit-chat', subtitle: '业务信息流 · 3 条链路' },
    { type: 'workspace', daysAgo: 4.2, status: 'completed', findings: 1, title: '当前改动评审 · fastrtc-talking-more', subtitle: 'staged + unstaged + untracked' },
    { type: 'architecture', daysAgo: 5.3, status: 'completed', findings: 2, title: '项目架构评审 · mopng-desktop', subtitle: '模块依赖 · 分层 · 耦合' },
    { type: 'module', daysAgo: 6.1, status: 'completed', findings: 5, title: '代码模块评审 · hexapod-evolve', subtitle: 'gaits · simulation' },
    { type: 'workspace', daysAgo: 7.4, status: 'completed', findings: 0, title: '当前改动评审 · helpkit-chat', subtitle: 'staged + unstaged + untracked' },
    { type: 'flow', daysAgo: 8.6, status: 'completed', findings: 4, title: '信息流评审 · banyugou-browser-extension', subtitle: '业务信息流 · 2 条链路' },
    { type: 'commit', daysAgo: 9.2, status: 'completed', findings: 2, title: '单次提交评审 · mopng-api', subtitle: 'commit bf9c296' },
    { type: 'workspace', daysAgo: 10.5, status: 'completed', findings: 3, title: '当前改动评审 · prompt-hub', subtitle: 'staged + unstaged + untracked' },
    { type: 'architecture', daysAgo: 12.1, status: 'completed', findings: 6, title: '项目架构评审 · helpkit-chat', subtitle: '模块依赖 · 分层 · 耦合' },
    { type: 'module', daysAgo: 13.4, status: 'completed', findings: 2, title: '代码模块评审 · prompt-hub', subtitle: 'src/server' },
    { type: 'workspace', daysAgo: 15.2, status: 'completed', findings: 1, title: '当前改动评审 · hexapod-evolve', subtitle: 'staged + unstaged + untracked' },
    { type: 'flow', daysAgo: 17.6, status: 'completed', findings: 3, title: '信息流评审 · mopng-api', subtitle: '业务信息流 · 4 条链路' },
    { type: 'range', daysAgo: 19.3, status: 'completed', findings: 4, title: '分支对比评审 · prompt-hub', subtitle: 'main → release/1.4' },
    { type: 'workspace', daysAgo: 22.1, status: 'completed', findings: 2, title: '当前改动评审 · mopng-desktop', subtitle: 'staged + unstaged + untracked' },
    { type: 'architecture', daysAgo: 25.4, status: 'completed', findings: 3, title: '项目架构评审 · mopng-api', subtitle: '模块依赖 · 分层 · 耦合' },
    { type: 'module', daysAgo: 28.8, status: 'completed', findings: 1, title: '代码模块评审 · helpkit-chat', subtitle: 'src/app' },
    { type: 'workspace', daysAgo: 33.2, status: 'completed', findings: 0, title: '当前改动评审 · thinking-about-intelligence', subtitle: 'staged + unstaged + untracked' },
    { type: 'flow', daysAgo: 36.5, status: 'completed', findings: 2, title: '信息流评审 · mopng-desktop', subtitle: '业务信息流 · 2 条链路' },
    { type: 'workspace', daysAgo: 42.1, status: 'completed', findings: 5, title: '当前改动评审 · banyugou-browser-extension', subtitle: 'staged + unstaged + untracked' },
    { type: 'architecture', daysAgo: 51.3, status: 'completed', findings: 2, title: '项目架构评审 · prompt-hub', subtitle: '模块依赖 · 分层 · 耦合' },
  ];
  const projectOf = (type, index) => {
    if (type === 'workspace') return projects[[0, 1, 0, 2, 3, 4][index % 6] ?? projects[0]];
    if (type === 'architecture') return projects[index % 4];
    if (type === 'flow') return projects[index % 4];
    if (type === 'module') return projects[index % 4];
    return projects[(index + 2) % projects.length];
  };
  return specs.map((spec, index) => {
    const project = projectOf(spec.type, index);
    // Keep the visible title, the project chip and the project path consistent.
    const typeLabel = {
      workspace: '当前改动评审', commit: '单次提交评审', range: '分支对比评审',
      architecture: '项目架构评审', module: '代码模块评审', flow: '信息流评审',
    }[spec.type] ?? spec.type;
    spec.title = `${typeLabel} · ${project.name}`;
    const created = TODAY - spec.daysAgo * DAY;
    const duration = spec.status === 'running' ? null : 46_000 + Math.floor(random() * 260_000);
    const findingType = spec.type === 'architecture' ? 'architecture' : spec.type === 'flow' ? 'flow' : 'workspace';
    const rawFindings = spec.findings ? findingsFor(findingType, index, spec.findings) : [];
    // Findings in the library describe mopng-api; remap them onto the project
    // that actually owns this job so paths and module names stay believable.
    const remapPath = (path) => {
      if (project.name === 'mopng-api') return path;
      const language = project.language;
      if (language === 'Rust') {
        return String(path)
          .replace(/^mopng_api\.py$/, 'src/lib.rs')
          .replace(/^mopng\/api\/client\.py$/, 'src/client.rs')
          .replace(/^mopng\/api\/validate\.py$/, 'src/validate.rs')
          .replace(/^mopng\/tasks\/service\.py$/, 'src/tasks/service.rs')
          .replace(/^mopng\//, 'src/')
          .replace(/^migrations\//, 'migrations/')
          .replace(/^tests\//, 'tests/')
          .replace(/^scripts\//, 'examples/');
      }
      if (language === 'TypeScript') {
        return String(path)
          .replace(/^mopng_api\.py$/, 'src/index.ts')
          .replace(/^mopng\/api\/client\.py$/, 'src/api/client.ts')
          .replace(/^mopng\/api\/validate\.py$/, 'src/api/validate.ts')
          .replace(/^mopng\/tasks\/service\.py$/, 'src/tasks/service.ts')
          .replace(/^mopng\//, 'src/')
          .replace(/^migrations\//, 'src/db/')
          .replace(/^tests\//, 'test/')
          .replace(/^scripts\//, 'tools/');
      }
      if (language === 'Python') {
        return String(path)
          .replace(/^mopng_api\.py$/, 'app.py')
          .replace(/^mopng\/api\/client\.py$/, 'app/api/client.py')
          .replace(/^mopng\/api\/validate\.py$/, 'app/api/validate.py')
          .replace(/^mopng\/tasks\/service\.py$/, 'app/tasks/service.py')
          .replace(/^mopng\//, 'app/')
          .replace(/^migrations\//, 'db/')
          .replace(/^tests\//, 'tests/')
          .replace(/^scripts\//, 'scripts/');
      }
      return String(path)
        .replace(/^mopng_api\.py$/, 'src/index.js')
        .replace(/^mopng\/api\/client\.py$/, 'src/api/client.js')
        .replace(/^mopng\/api\/validate\.py$/, 'src/api/validate.js')
        .replace(/^mopng\/tasks\/service\.py$/, 'src/tasks/service.js')
        .replace(/^mopng\//, 'src/')
        .replace(/^migrations\//, 'db/')
        .replace(/^tests\//, 'test/')
        .replace(/^scripts\//, 'scripts/');
    };
    const remapModule = (module) => (project.name === 'mopng-api' ? module : ({ mopng: 'src', api: 'src', models: 'src', tasks: 'src', tests: 'test', scripts: 'tools' }[module] ?? module));
    const findings = rawFindings.map((item) => ({
      ...item,
      path: remapPath(item.path),
      module: remapModule(item.module),
      existingCode: item.existingCode,
      suggestionCode: item.suggestionCode,
    }));
    const counts = severityCounts(findings);
    const stages = [
      { key: 'resolve', label: '解析项目', status: 'done', startedAt: iso(created), finishedAt: iso(created + 1_200), detail: `${project.branch} · ${project.head}` },
      { key: spec.type === 'architecture' || spec.type === 'flow' ? 'structure' : 'plan', label: spec.type === 'architecture' || spec.type === 'flow' ? '结构分析' : '选取文件', status: 'done', startedAt: iso(created + 1_200), finishedAt: iso(created + 9_000), detail: spec.type === 'architecture' ? '11 模块 · 17 依赖 · 1 环' : spec.type === 'flow' ? '4 条链路 · 9 节点' : '12 个文件 · +340 -86' },
      { key: 'ai', label: 'AI 评审', status: spec.status === 'running' ? 'running' : (spec.status === 'failed' || spec.status === 'cancelled' ? 'failed' : 'done'), startedAt: iso(created + 9_000), finishedAt: spec.status === 'running' ? null : iso(created + (duration ?? 60_000)), detail: spec.status === 'running' ? '已完成 3/5 组' : `${spec.findings} 条发现` },
      { key: 'merge', label: '归并去重', status: spec.status === 'completed' ? 'done' : (spec.status === 'running' ? 'pending' : 'skipped'), startedAt: null, finishedAt: null, detail: '' },
      { key: 'report', label: '生成报告', status: spec.status === 'completed' ? 'done' : (spec.status === 'running' ? 'pending' : 'skipped'), startedAt: null, finishedAt: null, detail: '' },
    ];
    const stage = spec.status === 'running' ? { key: 'ai', label: 'AI 评审', index: 3, total: 5 } : { key: 'report', label: '生成报告', index: 5, total: 5 };
    const byCategory = {};
    for (const item of findings) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
    const modules = [...new Set(findings.map((item) => item.module))];
    const activity = [
      { ts: iso(created + 800), level: 'info', text: `项目已就绪：${project.name}（${project.path}）` },
      { ts: iso(created + 2_400), level: 'info', text: `${spec.type === 'architecture' ? '结构分析已完成：11 模块 · 17 依赖 · 1 环' : spec.type === 'flow' ? '结构分析已完成：4 条链路 · 9 节点' : '已选取 12 个文件（+340 -86）'}` },
      { ts: iso(created + 12_000), level: 'info', text: 'OCR 开始分组评审（5 组）' },
      { ts: iso(created + 24_000), level: 'info', text: 'Plan completed for group "mopng-api"' },
      { ts: iso(created + 31_000), level: 'info', text: '组 1/5 完成，发现 2 条问题' },
      { ts: iso(created + 44_000), level: 'info', text: '组 2/5 完成，发现 3 条问题' },
      { ts: iso(created + 58_000), level: 'info', text: '组 3/5 完成，未发现新问题' },
      { ts: iso(created + 60_000), level: 'success', text: `评审完成：${spec.findings} 个问题 · 8 个文件` },
    ];
    const job = {
      id: `rv-20261110-${String(100000 + index)}`,
      seq: 40 - index,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      projectKind: 'git',
      type: spec.type,
      title: spec.title,
      subtitle: spec.subtitle,
      scope: {
        paths: spec.type === 'module' ? ['mopng/api', 'mopng/tasks'] : [],
        commit: spec.type === 'commit' ? '7c9b120' : '',
        from: spec.type === 'range' ? 'main' : '',
        to: spec.type === 'range' ? 'feature/ticket-attachments' : '',
        flowName: spec.type === 'flow' ? '消息转发主链路' : '',
      },
      engine: index % 7 === 3 ? 'delegate' : (index % 6 === 5 ? 'structural' : 'ocr'),
      engineDetail: (() => {
        const engine = index % 7 === 3 ? 'delegate' : (index % 6 === 5 ? 'structural' : 'ocr');
        if (engine === 'structural') {
          return { engineMode: 'structural', ocr: false, delegate: false, llmConfigured: false, provider: null, model: null };
        }
        if (engine === 'delegate') {
          return { engineMode: 'delegate', ocr: false, delegate: true, llmConfigured: true, provider: 'deepseek-account', model: 'deepseek-flash' };
        }
        return { engineMode: 'ocr', ocr: true, delegate: false, llmConfigured: true, provider: 'deepseek', model: 'deepseek-chat' };
      })(),
      options: { effort: 'medium', background: '', exclude: '', maxTokensBudget: 0 },
      status: spec.status,
      stage,
      progress: spec.status === 'completed' ? 1 : spec.status === 'running' ? spec.progress : spec.status === 'queued' ? 0 : 0.42,
      createdAt: iso(created),
      startedAt: iso(created + 900),
      finishedAt: spec.status === 'running' || spec.status === 'queued' ? null : iso(created + 900 + (duration ?? 0)),
      durationMs: spec.status === 'running' || spec.status === 'queued' ? null : (duration ?? 0),
      counts: {
        filesPlanned: 12,
        filesReviewed: spec.status === 'completed' ? 8 : 0,
        findings: spec.findings,
        bySeverity: counts,
        byCategory,
        tokens: spec.findings ? 41_000 + index * 2_400 : 0,
        modules: modules.length,
      },
      stages,
      activity: spec.status === 'running' ? activity.slice(0, 6) : activity,
      plan: {
        files: [
          { path: remapPath('mopng_api.py'), insertions: 128, deletions: 42, status: 'modified', willReview: true },
          { path: remapPath('mopng/api/client.py'), insertions: 86, deletions: 12, status: 'modified', willReview: true },
          { path: remapPath('mopng/api/validate.py'), insertions: 54, deletions: 0, status: 'added', willReview: true },
          { path: remapPath('mopng/tasks/service.py'), insertions: 42, deletions: 18, status: 'modified', willReview: true },
          { path: remapPath('tests/test_api.py'), insertions: 30, deletions: 14, status: 'modified', willReview: true },
          { path: 'README.md', insertions: 0, deletions: 0, status: 'modified', willReview: false },
        ],
        totalInsertions: 340,
        totalDeletions: 86,
        reviewable: 10,
        excluded: 2,
        mode: 'review',
      },
      summary: {
        headline: spec.status === 'running'
          ? '评审进行中'
          : spec.status === 'failed'
            ? 'LLM 连接失败，评审中断'
            : spec.status === 'cancelled'
              ? '评审已取消'
              : spec.findings === 0
                ? '未发现问题，评审通过'
                : `发现 ${spec.findings} 个问题：${counts.critical ? `${counts.critical} 严重 · ` : ''}${counts.high ? `${counts.high} 高 · ` : ''}${counts.medium} 中 · ${counts.low} 低`,
        projectSummary: spec.type === 'architecture'
          ? '项目按 api / models / tasks / validate 分层，边界总体清晰；api 与 models 之间存在双向依赖，是当前最需要处理的架构问题。'
          : spec.type === 'flow'
            ? '主链路「消息转发」在入口校验与幂等上存在缺口；外部调用缺少显式超时，失败时会静默返回空结果。'
            : '本次改动集中在 mopng_api.py 的鉴权与重试逻辑，安全与状态处理是主要风险点。',
        notes: index % 6 === 5 ? ['当前仅完成离线结构分析：OCR 的 LLM 尚未配置，AI 评审已跳过。'] : [],
        coverage: { reviewable: 10, reviewed: spec.status === 'completed' ? 8 : 0, failed: spec.status === 'failed' ? 2 : 0, waived: 0 },
        bySeverity: counts,
        modules,
      },
      error: spec.status === 'failed'
        ? { code: 'code-review/ocr-failed', message: 'OCR 调用 LLM 失败：401 Unauthorized（请运行 ocr config provider 重新配置）' }
        : null,
      artifacts: { rawOutputPath: `/Users/jkin/.dsh/code-review/artifacts/${index}.json`, ocrSessionId: `sess-${1000 + index}` },
      graph: spec.type === 'architecture' ? buildGraph('architecture') : spec.type === 'flow' ? buildGraph('flow') : null,
    };
    return { job, findings, findingType };
  });
}

function fillDays(days, entries) {
  const map = new Map(entries.map((entry) => [entry.date, entry]));
  const result = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const key = addDays(TODAY_KEY, -index);
    result.push(map.get(key) ?? { date: key, reviews: 0, findings: 0, critical: 0, files: 0, tokens: 0 });
  }
  return result;
}

export function buildMock() {
  const random = mulberry32(20261110);
  const projects = PROJECT_SEEDS.map((seed) => {
    const heatmap = buildHeatmap(365, { density: seed.density, max: seed.max }, random);
    return {
      id: seed.id,
      name: seed.name,
      path: seed.path,
      kind: 'git',
      branch: seed.branch,
      head: seed.head,
      headSubject: seed.headSubject,
      committedAt: seed.committedAt,
      dirty: seed.dirty,
      remote: seed.remote,
      language: seed.language,
      fileCount: seed.fileCount,
      moduleCount: seed.moduleCount,
      loc: seed.loc,
      modules: seed.modules,
      heatmap,
      at: iso(TODAY),
    };
  });
  const current = projects[0];
  const { job: runningJob } = buildJobList(random, projects)[0];
  const jobEntries = buildJobList(random, projects);
  const jobs = jobEntries.map((entry) => entry.job);
  const detailMap = new Map(jobEntries.map((entry) => [entry.job.id, entry]));

  for (const job of jobs) {
    if (job.status === 'running') Object.assign(job, { graph: buildGraph('architecture') });
  }

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  const byCategory = new Map();
  const reviewDays = new Map();
  const modules = new Map();
  const projectCounts = new Map();
  let filesReviewed = 0;
  let tokens = 0;
  for (const { job, findings } of jobEntries) {
    if (job.status !== 'completed') continue;
    for (const item of findings) {
      bySeverity[item.severity] += 1;
      bySeverity.total += 1;
      byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1);
      const key = `${job.projectId}\u0000${item.module}`;
      const entry = modules.get(key) ?? { projectId: job.projectId, projectName: job.projectName, module: item.module, count: 0, findings: 0, lastAt: null, risk: 'low' };
      entry.count += 1;
      entry.findings += 1;
      entry.lastAt = job.finishedAt;
      if (item.severity === 'critical' || (item.severity === 'high' && entry.risk !== 'critical')) entry.risk = item.severity;
      modules.set(key, entry);
    }
    filesReviewed += job.counts.filesReviewed;
    tokens += job.counts.tokens;
    const day = reviewDays.get(dateKey(new Date(job.finishedAt).getTime())) ?? { reviews: 0, findings: 0, critical: 0, files: 0, tokens: 0 };
    day.reviews += 1;
    day.findings += job.counts.findings;
    day.critical += job.counts.bySeverity.critical;
    day.files += job.counts.filesReviewed;
    day.tokens += job.counts.tokens;
    reviewDays.set(dateKey(new Date(job.finishedAt).getTime()), day);
    const project = projectCounts.get(job.projectId) ?? { projectId: job.projectId, name: job.projectName, count: 0, findings: 0, lastAt: null };
    project.count += 1;
    project.findings += job.counts.findings;
    project.lastAt = job.finishedAt;
    projectCounts.set(job.projectId, project);
  }

  const statsDays = fillDays(365, [...reviewDays.entries()].map(([date, value]) => ({ date, ...value })));
  const mergedHeat = (() => {
    const map = new Map(current.heatmap.days.map((day) => [day.date, day]));
    return statsDays.map((day) => {
      const commit = map.get(day.date) ?? { commits: 0, insertions: 0, deletions: 0 };
      return { ...commit, reviews: day.reviews, findings: day.findings, critical: day.critical };
    });
  })();
  const heatmap = {
    from: current.heatmap.from,
    to: current.heatmap.to,
    days: mergedHeat,
    spark: mergedHeat.slice(-90).map((day) => day.commits + day.reviews * 3),
    max: mergedHeat.reduce((best, day) => Math.max(best, day.commits), 0),
    totalCommits: current.heatmap.totalCommits,
    totalInsertions: current.heatmap.totalInsertions,
    totalDeletions: current.heatmap.totalDeletions,
    totalReviews: mergedHeat.reduce((sum, day) => sum + day.reviews, 0),
    totalFindings: mergedHeat.reduce((sum, day) => sum + day.findings, 0),
    streaks: current.heatmap.streaks,
    busiest: current.heatmap.busiest,
    activeDays: current.heatmap.activeDays,
  };

  const summary = {
    reviewsTotal: jobs.length,
    reviews7d: jobs.filter((job) => new Date(job.createdAt).getTime() >= TODAY - 7 * DAY).length,
    reviewsToday: jobs.filter((job) => job.createdAt.slice(0, 10) === TODAY_KEY).length,
    running: jobs.filter((job) => job.status === 'running').length,
    queued: jobs.filter((job) => job.status === 'queued').length,
    findings: bySeverity,
    filesReviewed,
    tokens,
    modulesCovered: modules.size,
    projectsCount: projects.length,
    lastReviewAt: jobs.filter((job) => job.finishedAt).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0]?.finishedAt ?? null,
    streakDays: 6,
    successRate: 0.93,
    completed: jobs.filter((job) => job.status === 'completed').length,
    failed: jobs.filter((job) => job.status === 'failed').length,
  };

  const snapshot = {
    generatedAt: iso(TODAY),
    version: 184,
    ok: true,
    config: {
      hostVersion: '0.5.4',
      projectRoots: ['/Users/jkin/workspace/jkin8010'],
      defaultProjectId: current.id,
      defaultProjectPath: '/Users/jkin/workspace/jkin8010/mopng-api',
      pollSeconds: 2,
      stateDir: '/Users/jkin/.dsh/code-review',
      engineMode: 'auto',
      ocrBin: '/Users/jkin/.nvm/versions/node/v24.15.0/bin/ocr',
      ocrVersion: 'open-code-review v1.13.6',
      llmConfigured: true,
      llmProvider: 'deepseek',
      llmModel: 'deepseek-chat',
      maxJobs: 200,
    },
    health: {
      ocr: { state: 'ok', version: 'v1.13.6', path: '/Users/jkin/.nvm/versions/node/v24.15.0/bin/ocr', error: null, checkedAt: iso(TODAY) },
      llm: { state: 'configured', provider: 'deepseek', model: 'deepseek-chat', source: 'config', error: null, checkedAt: iso(TODAY) },
      git: { state: 'ok', projects: projects.length, error: null, checkedAt: iso(TODAY) },
      store: { state: 'ok', path: '/Users/jkin/.dsh/code-review', jobs: jobs.length, error: null },
    },
    project: { ...current, lastReviewAt: jobs.find((job) => job.projectId === current.id && job.finishedAt)?.finishedAt ?? null, reviewCount: jobs.filter((job) => job.projectId === current.id).length, findings: bySeverity },
    projects: projects.map((project, index) => {
      const count = projectCounts.get(project.id) ?? { count: 0, findings: 0, lastAt: null };
      return {
        ...project,
        heatmap: {
          from: project.heatmap.from, to: project.heatmap.to, spark: project.heatmap.spark,
          max: project.heatmap.max, totalCommits: project.heatmap.totalCommits,
          totalInsertions: project.heatmap.totalInsertions, totalDeletions: project.heatmap.totalDeletions,
          streaks: project.heatmap.streaks, busiest: project.heatmap.busiest, activeDays: project.heatmap.activeDays,
        },
        modules: project.modules.slice(0, 6),
        lastReviewAt: count.lastAt,
        reviewCount: count.count,
        findings: index === 0 ? bySeverity : { critical: 0, high: Math.floor(random() * 2), medium: Math.floor(random() * 4), low: Math.floor(random() * 3), total: 0 },
      };
    }),
    overview: summary,
    jobs: jobs.slice(0, 40).map((job) => ({ ...job, graph: undefined })),
    activity: (() => {
      const events = [];
      for (const { job } of jobEntries.slice(0, 12)) {
        for (const event of job.activity.slice(-3)) {
          events.push({
            id: `a-${job.id}-${event.ts}`,
            ts: event.ts,
            kind: event.level === 'success' ? 'finding' : 'review',
            level: event.level,
            text: `${job.projectName} · ${event.text}`,
            jobId: job.id,
            projectId: job.projectId,
            type: job.type,
          });
        }
      }
      events.push({ id: 'a-project', ts: iso(TODAY - 2 * 3600_000), kind: 'project', level: 'info', text: 'mopng-api 检测到 1 个未提交改动文件', jobId: null, projectId: current.id, type: null });
      events.push({ id: 'a-llm', ts: iso(TODAY - 3 * 3600_000), kind: 'system', level: 'success', text: 'OCR LLM 连接正常 · deepseek-chat', jobId: null, projectId: null, type: null });
      return events.sort((a, b) => b.ts.localeCompare(a.ts));
    })(),
    stats: {
      days: statsDays,
      byType: ['workspace', 'architecture', 'flow', 'module', 'range', 'commit'].map((type) => ({ type, count: jobs.filter((job) => job.type === type).length })),
      bySeverity: Object.entries(bySeverity).filter(([key]) => key !== 'total').map(([severity, count]) => ({ severity, count })),
      byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
      byProject: [...projectCounts.values()].sort((a, b) => b.count - a.count),
      topModules: [...modules.values()].sort((a, b) => b.count - a.count).slice(0, 16),
      recentProjects: projects.slice(0, 8).map((project) => {
        const count = projectCounts.get(project.id) ?? { count: 0, findings: 0, lastAt: null };
        return {
          projectId: project.id, name: project.name, path: project.path,
          lastAt: count.lastAt, reviewCount: count.count, findings: count.findings,
          health: project.dirty ? 'dirty' : 'ok', spark: project.heatmap.spark,
        };
      }),
      heatmap,
    },
  };

  // Ensure the running job appears first and carries live activity.
  snapshot.jobs = [runningJob, ...snapshot.jobs.filter((job) => job.id !== runningJob.id)].slice(0, 40);

  function jobDetail(id) {
    const entry = detailMap.get(id) ?? detailMap.get(jobs[0].id);
    const { job, findings } = entry;
    const fileMap = new Map();
    for (const item of findings) {
      const file = fileMap.get(item.path) ?? { path: item.path, findings: 0, severityMax: 'low', severityCounts: { critical: 0, high: 0, medium: 0, low: 0 } };
      file.findings += 1;
      file.severityCounts[item.severity] += 1;
      if (item.severity === 'critical' || (item.severity === 'high' && file.severityMax !== 'critical')) file.severityMax = item.severity;
      fileMap.set(item.path, file);
    }
    return {
      job: { ...job, activity: job.activity },
      findings,
      files: [...fileMap.values()].sort((a, b) => b.findings - a.findings),
      graph: job.graph ?? (job.type === 'architecture' ? buildGraph('architecture') : job.type === 'flow' ? buildGraph('flow') : null),
    };
  }

  function graph(kind) {
    const built = buildGraph(kind === 'flow' ? 'flow' : 'architecture');
    const findings = kind === 'flow' ? FINDING_LIBRARY.flow : FINDING_LIBRARY.architecture;
    return {
      graph: built,
      summary: {
        headline: kind === 'flow' ? '识别到 4 条业务链路，其中 2 条存在高优先级风险' : '11 个模块、17 条依赖、1 组循环依赖',
        notes: kind === 'flow'
          ? ['消息转发主链路缺少入口 schema 校验', '任务写入路径没有幂等键', '外部调用缺少显式超时']
          : ['api 与 models 双向依赖形成环', 'mopng_api.py 是最大的上帝模块', 'scripts 直接依赖内部实现'],
        stats: kind === 'flow' ? { flows: 4, entries: 3, data: 3 } : { modules: 11, edges: 17, cycles: 1 },
      },
      findings,
      metrics: kind === 'flow' ? { flows: 4 } : { modules: 11, edges: 17, cycles: 1, maxFanIn: 4, maxFanOut: 4 },
      cached: false,
    };
  }

  function rpc(method, payload = {}) {
    switch (method) {
      case 'snapshot':
        snapshot.version += 1;
        return snapshot;
      case 'job':
        return jobDetail(payload.id);
      case 'graph':
        return graph(payload.kind);
      case 'start': {
        const type = payload.type ?? 'workspace';
        const project = projects.find((item) => item.id === payload.projectId) ?? projects[0];
        const job = {
          ...jobs[0],
          id: `rv-${Date.now()}`,
          seq: 99,
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          type,
          title: `${type === 'architecture' ? '项目架构' : type === 'flow' ? '信息流' : type === 'module' ? '代码模块' : '当前改动'}评审 · ${project.name}`,
          subtitle: payload.scope?.paths?.join('、') ?? '',
          status: 'queued',
          progress: 0,
          createdAt: iso(Date.now()),
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          counts: { filesPlanned: 0, filesReviewed: 0, findings: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, total: 0 }, byCategory: {}, tokens: 0, modules: 0 },
          stages: [
            { key: 'resolve', label: '解析项目', status: 'pending', startedAt: null, finishedAt: null, detail: '' },
            { key: 'plan', label: '选取文件', status: 'pending', startedAt: null, finishedAt: null, detail: '' },
            { key: 'structure', label: '结构分析', status: 'pending', startedAt: null, finishedAt: null, detail: '' },
            { key: 'ai', label: 'AI 评审', status: 'pending', startedAt: null, finishedAt: null, detail: '' },
            { key: 'merge', label: '归并去重', status: 'pending', startedAt: null, finishedAt: null, detail: '' },
            { key: 'report', label: '生成报告', status: 'pending', startedAt: null, finishedAt: null, detail: '' },
          ],
          activity: [{ ts: iso(Date.now()), level: 'info', text: '已加入队列' }],
          summary: null,
          error: null,
          graph: null,
        };
        jobs.unshift(job);
        snapshot.jobs.unshift(job);
        return { job };
      }
      case 'cancel':
      case 'delete':
        return { ok: true };
      case 'retry':
        return { job: jobs[0] };
      case 'refresh':
        return snapshot;
      case 'llmTest':
        return { ok: true, latencyMs: 412, message: 'LLM connected: deepseek/deepseek-chat', error: null };
      case 'project':
        return { project: projects.find((item) => item.id === payload.projectId) ?? current };
      // Simulates a Host plugin older than the UI: the client must fall back to
      // the DSH Client Remote session endpoints.
      case 'fix.create':
        return { ok: false, error: { code: 'gateway/bad-request', message: '未知方法：fix.create', details: {} } };
      case 'project.browse': {
        const dir = String(payload?.path ?? '/Users/jkin/workspace');
        return {
          path: dir,
          parent: '/Users/jkin',
          roots: [
            { name: '工作区', path: '/Users/jkin/workspace' },
            { name: '主目录', path: '/Users/jkin' },
          ],
          entries: [
            { name: 'jkin8010', path: '/Users/jkin/workspace/jkin8010', hidden: false },
            { name: 'qise-tech', path: '/Users/jkin/workspace/qise-tech', hidden: false },
            { name: 'synapse-router', path: '/Users/jkin/workspace/synapse-router', hidden: false },
          ],
        };
      }
      case 'project.add': {
        const path = String(payload.path ?? '').trim();
        const project = {
          ...current,
          id: `p-${Buffer.from(path).toString('hex').slice(0, 10)}`,
          name: path.split('/').filter(Boolean).pop() || 'project',
          path, branch: '—', head: '', headSubject: '', dirty: false, lastReviewAt: null, reviewCount: 0,
        };
        projects.unshift(project);
        snapshot.projects.unshift({ ...project });
        snapshot.project = project;
        snapshot.config.addedProjects = [...(snapshot.config.addedProjects ?? []), path];
        return { project, snapshot };
      }
      case 'ping':
        return { ok: true, at: iso(Date.now()) };
      default:
        return { ok: true };
    }
  }

  return {
    snapshot,
    detail: jobDetail,
    graph,
    rpc,
    projects,
    jobs,
    flows: FLOWS,
  };
}

export const MOCK = buildMock();
