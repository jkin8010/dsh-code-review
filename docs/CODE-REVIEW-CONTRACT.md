# dsh-code-review — 实现契约 v1

插件包：`plugins/dsh-code-review`（`@jkin8010/dsh-code-review`）。
基于 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)（`ocr` CLI v1.13+）。
左侧栏入口 `sidebar.panellist`（id `code-review`）+ 整页 `main`（key `code-review`）。
Client 通过认证 RPC 取数据，Host 端持有全部 I/O（git / ocr 子进程 / 持久化）。

```js
// client
connection.rpc.call('/api', 'code-review', { method, payload }, undefined)
// host: POST /api/code-review { type:'client-request', method:'code-review', rpcId, payload:{method,payload} }
//       <- { type:'server-response', rpcId, result:{ ok, value|error } }
```

> 本契约是 **唯一事实源**。所有模块按这里的形状生产/消费数据；改字段先改本文件。
> 快照必须是纯 JSON（禁止函数、循环引用、undefined）。所有时间用 ISO-8601 字符串（`new Date().toISOString()`）。

---

## 1. 评审类型

| type | 中文 | OCR 命令 | 必要 scope | 说明 |
|---|---|---|---|---|
| `workspace` | 当前改动 | `ocr review`（staged+unstaged+untracked） | — | 需要 git 仓库；工作区干净时给出「无改动」 |
| `commit` | 单次提交 | `ocr review --commit <sha>` | `commit` | |
| `range` | 分支对比 | `ocr review --from <a> --to <b>` | `from`,`to` | merge-base 语义 |
| `architecture` | 项目架构 | `ocr scan --path <anchors>` + 本地架构分析 | — | 全项目模块依赖图 / 环 / 层次 / 热点 |
| `module` | 代码模块 | `ocr scan --path <paths>` + 本地模块分析 | `paths[]` | 指定目录/文件 |
| `flow` | 信息流 | `ocr scan --path <flow files>` + 本地信息流分析 | `paths[]`（可选） | 入口→服务→数据 业务链路 |

`engine`：
- `ocr`：OCR 自带 LLM（`OCR_LLM_*` / `~/.opencodereview/config.json`），跑 `ocr review/scan`；
- `delegate`：**委托模式**——OCR 仍负责文件选取与规则解析，评审由 DSH 当前会话模型完成
  （`ctx.llm.stream` + `ctx.agentDefaultModel.currentSelection()`），不需要 OCR 的 API Key；
- `structural`：离线结构分析，始终可用。

配置 `engine=auto` 时：OCR LLM 已配置 → `ocr`；否则 DSH 模型可用 → `delegate`；否则 `structural`。
模型评审不可用时自动降级为 structural，并在 summary.notes 里注明。

---

## 2. Host 模块接口（文件级契约）

### `host/config.js`（Lead）

```js
export const DEFAULTS // 见文件
export function normalizeConfig(rawConfig, { hostCwd } = {}) -> Config
export function resolveOcrEnv(config) -> { [env]: string }      // OCR_LLM_URL / OCR_LLM_TOKEN / OCR_LLM_MODEL 等
export function findOcrBinary(config) -> string                  // 绝对路径或 'ocr'
export function projectId(path) -> 'p-<8hex>'
export function projectName(path) -> string
export function expandHome(p) -> string
```

`Config`（normalize 后）：
```js
{
  enabled: true,
  pollSeconds: 2,                 // 前端轮询
  projectRoots: [],               // 自动发现项目（含 .git 的子目录）
  extraProjects: [],              // 额外纳入的项目路径（可非 Git，用于模块/架构/信息流评审）
  projectDepth: 2,                // projectRoots 目录扫描深度（1-3）
  maxProjects: 40,                // 最多纳入的项目数
  // 运行时还会自动并入：DSH 工作区、已评审项目、UI 添加的项目（persist 在 stateDir/projects.json）
  defaultProjectPath: '',         // 空 = 最近提交的已发现项目（或 projectRoots 首项）
  excludeProjects: [],            // 目录名或路径前缀
  stateDir: '~/.dsh/code-review',
  engine: 'auto',                 // auto | ocr | structural
  maxJobs: 200,
  heatmapDays: 365,
  gitScanLimit: 4000,             // git log 最多读取提交数
  ocr: {
    command: '',                  // 空 = 自动探测
    provider: '', model: '',
    llmUrl: '', llmToken: '', llmTokenFile: '',
    effort: 'medium', concurrency: 8, timeoutMin: 15,
    maxTokens: 0, maxTokensBudget: 0,
    extraArgs: [],
  },
}
```

### `host/shared.js`（Lead）

```js
export const SEVERITIES = ['critical','high','medium','low']
export const CATEGORIES = ['bug','security','performance','maintainability','test','style','documentation','other']
export function nowIso() -> string
export function errorText(e) -> string
export function hash(text, len=12) -> string            // sha1 hex 截断
export function slug(text) -> string                    // 文件名安全
export function dateKey(ts) -> 'YYYY-MM-DD'             // 本地时区
export function addDays(dateKey, n) -> 'YYYY-MM-DD'
export function dayList(from, to) -> string[]
export function severityRank(sev) -> number
export function normalizeSeverity(v) -> 'critical'|'high'|'medium'|'low'
export function normalizeCategory(v) -> CATEGORIES[number]
export function finding(input) -> Finding               // 统一 id/fingerprint/字段
export function countFindings(findings) -> {critical,high,medium,low,total}
export function countBy(findings, key) -> [{key,count}]
export function trimText(text, max) -> string
export function readJsonFile(path, fallback) -> any     // 容错
export async function atomicWriteJson(path, value) -> void
export function parseJsonLoose(text) -> any|null
export function clamp01(n) -> number
export function pct(a,b) -> number                      // 0..100 整数
```

`Finding`：
```js
{
  id: 'f-<12hex>',            // 稳定指纹（path+startLine+content 哈希）
  severity: 'critical|high|medium|low',
  category: 'bug|security|performance|maintainability|test|style|documentation|other',
  path: 'src/x.ts',
  startLine: 0, endLine: 0,   // 0 表示未定位
  title: '一句话问题（≤120字）',   // 从 content 首句截取或规则标题
  content: '详细说明（Markdown 纯文本）',
  suggestionCode: '', existingCode: '', thinking: '',
  source: 'ocr|structural',
  rule: '',                    // 规则 id / 检测器名
  module: '',                  // 顶层模块名（用于统计）
}
```

### `host/store.js`（Lead）

```js
export function createStore({ dir, maxJobs = 200, logger }) -> Store
// Store:
//   await store.init()
//   store.saveJob(job)                    // 内存 + 异步落盘 jobs/<id>.json
//   store.getJob(id) -> Job|null
//   store.listJobs() -> Job[]             // 新→旧
//   store.deleteJob(id) -> boolean
//   store.getStats() -> Stats
//   store.recordReview(job)               // 累加 stats（按天）
//   store.status() -> { state, path, jobs, error }
//   await store.flush()
```
落盘：`<stateDir>/jobs/<id>.json`（完整 Job 含 findings）、`<stateDir>/index.json`（摘要数组）、
`<stateDir>/stats.json`（按天聚合）。写用 tmp+rename，读失败容错。启动只加载 index + stats，findings 按需懒加载。

### `host/git.js`（Teammate A）

```js
export async function discoverProjects({ roots, exclude = [], limit = 24 }) -> ProjectSummary[]
// 扫描 roots 的直接子目录（含 .git），返回按 lastCommitAt 降序的摘要（不含 heatmap.modules 明细）

export async function inspectProject({ repoPath, heatmapDays = 365, moduleDepth = 1, light = false }) -> ProjectView
// 完整 ProjectView：git 元信息 + 语言统计 + 顶层模块 + 一年热力图
// light:true 跳过逐文件 LOC（loc 可为 null），仍给 fileCount/moduleCount/heatmap，供项目卡摘要用

export async function gitHeatmap({ repoPath, days = 365 }) -> Heatmap
export async function moduleTree({ repoPath, depth = 2, maxModules = 60 }) -> ModuleSummary[]
export async function changedFiles({ repoPath, mode, commit, from, to }) -> { files:[{path,insertions,deletions,status}], totalInsertions, totalDeletions }
export async function gitMeta({ repoPath }) -> { kind:'git'|'dir', branch, head, headSubject, committedAt, dirty, remote, error }
```

`ProjectView`：
```js
{
  id:'p-1a2b3c4d', name:'mopng-api', path:'/Users/.../mopng-api', kind:'git',
  branch:'master', head:'bf9c296', headSubject:'重构 README...', committedAt:'ISO', dirty:false,
  remote:'git@github.com:...', language:'Python', fileCount: 42, moduleCount: 6, loc: 8600,
  modules:[{ id:'m-...', name:'mopng', path:'mopng', files:12, loc:2400, lastCommitAt:'ISO',
             lastReviewAt:'ISO|null', reviewCount:3, findings:{critical:0,high:1,medium:2,low:0,total:3}, risk:'low|medium|high' }],
  heatmap: Heatmap,
  lastReviewAt:'ISO|null', reviewCount: 4, findings:{...}, error: null,
  at:'ISO'
}
```

`Heatmap`：
```js
{
  from:'2025-11-10', to:'2026-11-10', days:[{date:'2026-01-02', commits:3, insertions:120, deletions:30}], // 只含有活动的天？
  max: 12, totalCommits: 812, totalInsertions: 42000, totalDeletions: 12000,
  streaks:{ current: 3, longest: 21 }, busiest:{ date:'2026-03-11', commits:12 },
  activeDays: 240
}
```
> `days` **必须补齐 from→to 每一天**（无活动补 `commits:0,insertions:0,deletions:0`），前端直接画格子。
> 注意：`git log --numstat` 一次读取，禁止 per-day 调用。

### `host/ocr.js`（Teammate A）

```js
export async function probe({ config, env }) -> { available, version, path, error }
export async function probeLlm({ config, env }) -> { configured, provider, model, source, error }
export async function preview({ projectPath, type, scope, config, env }) -> {
  ok, mode, files:[{path,insertions,deletions,status,willReview,reason}],
  totalInsertions, totalDeletions, reviewable, excluded, error
}
// type 映射：workspace|commit|range -> ocr review --preview
//            module                 -> ocr scan --preview --path <scope.paths>
//            scan                   -> ocr scan --preview --path <scope.paths|全仓>
export async function runReview({ jobId, projectPath, type, scope, plan, config, env, background, rules, signal, onEvent, onProgress }) -> {
  ok, status, comments:[FindingRaw], summary:{filesReviewed,comments,totalTokens,inputTokens,outputTokens,elapsed},
  projectSummary, warnings:[{type,file,message}], sessionId, manifest, rawOutputPath, stderrTail, error
}
export async function llmTest({ config, env }) -> { ok, latencyMs, message, error }
```

- 参数组装：`review` / `scan`，统一 `--format json --output <tmpfile> --audience human --repo <projectPath>`，
  `--effort/--concurrency/--timeout/--exclude/--max-tokens/--max-tokens-budget/--background-file`。
  `architecture`/`flow` 用 `scan`；`module` 用 `scan --path`；`workspace/commit/range` 用 `review`。
- LLM：`resolveOcrEnv(config)` 注入 `OCR_LLM_URL/OCR_LLM_TOKEN/OCR_LLM_MODEL`（token 只存在 Host 进程）。
- 进度：JSON 模式下 human 进度写 **stderr**，形如 `[ocr] ...`；解析 `group`/`round`/`token budget`/`Session:`
  行调用 `onProgress`。stdout 是 JSON 但用 `--output` 落文件，stdout 只做兜底。
- 取消：`signal.aborted` 时 kill 子进程（SIGTERM→SIGKILL 2s）。
- 失败分类：`ocr-missing | llm-unconfigured | git | timeout | cancelled | ocr-failed`。
- 原始输出与 stderr 尾部写 `<stateDir>/artifacts/<jobId>.json|.log`。

### `host/analyze.js`（Teammate B）

```js
export async function analyzeArchitecture({ project, files, readFile }) -> ArchAnalysis
export async function analyzeModule({ project, modulePath, files, readFile }) -> ModuleAnalysis
export async function analyzeFlow({ project, files, readFile }) -> FlowAnalysis
export async function analyzeDiff({ project, files, diffText, readFile }) -> DiffAnalysis
```

所有分析返回：
```js
{
  findings: Finding[],
  metrics: {...},                 // 自由结构，前端按需展示
  graph: { nodes:[{id,label,kind,path,files,loc,risk,meta:{}}], edges:[{from,to,kind,count,risk}], cycles:[[id]] } | null,
  summary: { headline, notes:[], stats:{} },
  activity: [{ ts, level, text }],   // 分析过程可读动态
}
```
- `architecture`：模块依赖图（JS/TS import/require、Python import/from、Go import、Java import、Rust use、PHP use/require），
  Tarjan 强连通找环，不稳定依赖（稳定→不稳定）、god module、孤儿模块、缺测试、跨层反向依赖。
- `module`：文件/函数指标、TODO/FIXME、调试残留、空 catch、危险模式、重复窗口、超大文件。
- `flow`：入口识别（Express/Koa/FastAPI/Flask/Spring/Go handler/CLI/飞书事件/前端 fetch）→ 服务调用 → 数据访问
  （SQL/ORM/Redis/队列/外部 HTTP）。findings：缺校验、写路径无事务/幂等、缺鉴权、外部调用无超时/重试、
  吞异常、敏感信息日志。`graph.nodes[].kind`: `entry|service|data|external`，`edges[].kind`: `call|read|write|emit|http`。
- 纯 Node 内置模块，零第三方依赖；对每个文件读取设 256KB 上限。

### `host/prompts.js`（Lead）

```js
export function buildBackground({ type, project, scope, analysis, userBackground }) -> string  // Markdown
export function buildRules({ type, scope, analysis, options }) -> { rules:[{path,rule,merge_system_rule?}] } | null
export function buildTitle({ type, project, scope }) -> { title, subtitle }
```

### `host/jobs.js`（Lead）

```js
export function createJobs({ config, env, store, logger, git, ocr, analyze }) -> Jobs
// Jobs:
//   await jobs.init()                      // 从 store 恢复；把遗留 running 标记为 failed/interrupted
//   jobs.start({ projectId|projectPath, type, scope, options }) -> Job
//   jobs.cancel(id) -> boolean
//   jobs.retry(id) -> Job
//   jobs.get(id) -> Job|null
//   jobs.list() -> Job[]
//   jobs.running() -> Job[]
//   jobs.prune()
//   jobs.dispose()
```
Job 生命周期（`stages`）：
`resolve → plan → structure → ai → merge → report`
（无 AI 时 `ai` 标 `skipped`；`workspace` 无改动直接 completed 并给 message。）
进度：每个 stage 权重 `[5,10,25,50,5,5]`（按启用阶段归一化）；`progress` 0..1；AI 阶段由 `onProgress` 细化。

### `host/snapshot.js`（Lead）

```js
export function createSnapshot({ config, store, jobs, git, ocr, logger }) -> { build(), refreshProjects(), getProject(id), invalidate() }
```
`build()` 必须纯 JSON 且 < 1.5MB（findings 不进 snapshot；只有 `running` job 带最近 20 条 activity）。

---

## 3. Snapshot

```jsonc
{
  "generatedAt": "ISO", "version": 12, "ok": true,
  "config": {
    "projectRoots": ["/Users/jkin/workspace/jkin8010"],
    "defaultProjectId": "p-...",
    "pollSeconds": 2, "stateDir": "~/.dsh/code-review",
    "engineMode": "auto",          // 配置值
    "enginePlan": "ocr",           // 实际生效：ocr | delegate | structural
    "ocrBin": "/Users/.../ocr", "ocrVersion": "open-code-review v1.13.6",
    "llmConfigured": true, "llmDelegate": false,
    "llmProvider": "deepseek", "llmModel": "deepseek-chat",
    "maxJobs": 200
  },
  "health": {
    "ocr":   { "state": "ok",             // ok | missing | unconfigured | error
               "version": "v1.13.6", "path": "...", "error": null, "checkedAt": "ISO" },
    "llm":   { "state": "configured",     // configured(OCR LLM) | delegate(DSH 模型) | unconfigured | unknown | error
               "provider": "deepseek", "model": "deepseek-chat", "source": "config|env|file|dsh|none",
               "delegateAvailable": true, "delegateProvider": "deepseek-account", "delegateModel": "deepseek-flash",
               "error": null, "checkedAt": "ISO" },
    "git":   { "state": "ok", "projects": 8, "error": null, "checkedAt": "ISO" },
    "store": { "state": "ok", "path": "...", "jobs": 24, "error": null }
  },
  "project": ProjectView,              // 当前选中项目（完整，含一年 heatmap + modules）
  "projects": ProjectView[],           // 摘要（heatmap 只留 totals/streaks/spark(90天提交数数组)，modules 只留 top 6），按 lastCommitAt 排序
  "overview": {
    "reviewsTotal": 32, "reviews7d": 9, "reviewsToday": 2,
    "running": 1, "queued": 0,
    "findings": { "critical": 3, "high": 12, "medium": 24, "low": 9, "total": 48 },
    "filesReviewed": 214, "tokens": 318000, "modulesCovered": 18, "projectsCount": 8,
    "lastReviewAt": "ISO", "streakDays": 4, "successRate": 0.93
  },
  "jobs": Job[],                        // 新→旧，最多 40；含 stages/activity，不含 findings
  "activity": [{ "id": "a-...", "ts": "ISO", "kind": "review|finding|system|project",
                 "level": "info|success|warn|error", "text": "...", "jobId": "rv-...", "projectId": "p-..." }],
  "stats": {
    "days": [{ "date": "2026-11-09", "reviews": 2, "findings": 7, "critical": 1, "files": 21, "tokens": 41000 }], // 365 天补齐
    "byType": [{ "type": "workspace", "count": 12 }],
    "bySeverity": [{ "severity": "high", "count": 12 }],
    "byCategory": [{ "category": "bug", "count": 20 }],
    "byProject": [{ "projectId": "p-...", "name": "mopng-api", "count": 6, "findings": 18, "lastAt": "ISO" }],
    "topModules": [{ "projectId": "p-...", "projectName": "mopng-api", "module": "mopng", "count": 4, "findings": 11,
                     "lastAt": "ISO", "risk": "high" }],
    "recentProjects": [{ "projectId": "p-...", "name": "mopng-api", "path": "...", "lastAt": "ISO",
                         "reviewCount": 6, "findings": 18, "health": "ok|dirty|error" }],
    "heatmap": Heatmap                  // 跨项目合并（commits + reviews + findings 每天）
  }
}
```

`Job`（摘要，snapshot 用）：
```js
{
  id:'rv-20261110-092500-3f9a', seq:32,
  projectId:'p-...', projectName:'mopng-api', projectPath:'/Users/.../mopng-api',
  type:'workspace', title:'当前改动评审 · mopng-api', subtitle:'review · 12 files / +340 -86',
  scope:{ paths:[], commit:'', from:'', to:'', flowId:'' },
  engine:'ocr|delegate|structural',
  engineDetail:{ engineMode:'ocr', ocr:true, delegate:false, llmConfigured:true,
                 provider:'deepseek', model:'deepseek-chat' },
  options:{ effort:'medium', background:'', exclude:'', maxTokensBudget:0 },
  status:'queued|running|completed|failed|cancelled',
  stage:{ key:'ai', label:'AI 评审', index:3, total:6 },
  progress:0.62,
  createdAt:'ISO', startedAt:'ISO|null', finishedAt:'ISO|null', durationMs:12000|null,
  counts:{ filesPlanned:12, filesReviewed:8, findings:5,
           bySeverity:{critical:0,high:2,medium:2,low:1}, byCategory:{bug:3,...}, tokens:41000, modules:3 },
  stages:[{ key:'plan', label:'选取文件', status:'done', startedAt:'ISO', finishedAt:'ISO', detail:'12 个文件' }],
  activity:[{ ts:'ISO', level:'info', text:'OCR 已完成 3/5 组' }],   // 最多 40
  plan:{ files:[...], totalInsertions:340, totalDeletions:86, reviewable:10, excluded:2 },
  summary:{ headline:'发现 5 个问题：2 高 2 中', projectSummary:'', notes:[],
            coverage:{ reviewable:10, reviewed:8, failed:1, waived:0 } },
  error:null, artifacts:{ rawOutputPath:'...', ocrSessionId:'' },
  graph: { nodes:[], edges:[], cycles:[] } | null,   // architecture / flow / module 才有（Graph）
  summary: { ..., modules:['mopng','tests'] }        // 用于「热点模块」统计
}
```

### `job` RPC 返回

```js
{ job: Job, findings: Finding[], files: [{path, findings, severityMax}], graph: Graph|null }
```

---

## 4. RPC 方法

| method | payload | 返回 |
|---|---|---|
| `snapshot` | `{ projectId? }`（传则切换当前项目） | Snapshot |
| `job` | `{ id, includeFindings?:true }` | `{job, findings, files, graph}` |
| `start` | `{ projectId?, projectPath?, type, scope?, options? }` | `{ job }` |
| `cancel` | `{ id }` | `{ ok, job }` |
| `retry` | `{ id }` | `{ job }` |
| `delete` | `{ id }` | `{ ok }` |
| `project` | `{ projectId?, projectPath?, refresh? }` | `{ project: ProjectView }` |
| `finding.resolve` | `{ jobId, key, resolved? }` | `{ job, resolutions, resolvedCount }`；持久化“已修复/撤销”标记（key 由 `job` 返回的 findings[].key 提供） |
| `fix.create` | `{ jobId }` | `{ sessionId, jobId, prompted, findings, title?, projectName?, error? }`；在项目目录新建会话并发送修复提示词 |
| `project.browse` | `{ path? }` | `{ path, parent, roots:[{name,path}], entries:[{name,path,hidden}] }`；内置目录浏览器，任意环境可用 |
| `project.add` | `{ path }`（绝对路径，Git 或普通目录） | `{ project, snapshot }`，持久化 + 设为当前 |
| `project.remove` | `{ path }` | `{ ok, snapshot }`（已评审项目保留，仅移出「已添加」） |
| `graph` | `{ projectId?, projectPath?, kind:'architecture'\|'flow' }` | `{ graph, summary, findings }` |
| `refresh` | `{ scope?:'projects'\|'all' }` | Snapshot |
| `llmTest` | `{}` | `{ ok, latencyMs, message, error }` |
| `ping` | `{}` | `{ ok, at }` |

错误：`{ ok:false, error:{ code:'code-review/<slug>', message } }`，不抛异常给客户端。

### 斜杠命令 `code-review`

Host 通过 `ctx.commands.register` 注册全局命令：

```text
/code-review <changes|commit|range|architecture|module|workflow|fix|list|status|help> [@项目路径] [选项]
选项：--fix --async --project <path> --effort <low|medium|high> --background <text> --exclude <globs> --budget <n>
```
- `@path` / `--project`：先用 `snapshot.addProjectPath()` 加入项目（持久化），再用 `jobs.start` 评审
- 默认等待评审结束（≤10min）并返回摘要/findings；`--fix` 调 `createFixSessionForJob`
- handler 返回 `{ kind:'success'|'error', text }`；解析失败返回错误 + 用法

### 模型工具 `code_review`

Host 通过 `ctx.tools.register` 注册（无 tools 服务的 profile 自动跳过），用于项目对话内触发评审：

```js
{
  name: 'code_review',
  parameters: {
    action: 'start|status|detail|list',        // required
    project_path?: string,                     // 省略 = 当前会话 cwd
    type?: 'workspace|commit|range|architecture|module|flow',
    scope?: { paths?: string[], commit?, from?, to? },
    options?: { effort?, background?, exclude?, max_tokens_budget? },
    wait?: boolean,                            // start 默认 true，等待完成（≤12min）
    job_id?: string, severity?: string, limit?: number,
  },
  output: { ok, action, job, findings?, files?, jobs?, error?, timedOut?, cancelled? }
}
```
`start` 直接复用 `jobs.start`，等待完成后用 `jobs.getFull` 返回摘要与 findings；`wait:false` 立即返回任务 id。
工具输出为纯 JSON，`output.render` 渲染成对话文本；`execute` 内不抛异常，失败以 `ok:false` 返回。

---

## 5. Client UI（Teammate C）

单文件 `client.js`，`window.__ModuleLoader__.load({ id, factory(require) })`，只用 `require('react')`。
入口返回 `{ inject:['slots','connection'], apply(ctx) }`，注册 `sidebar.panellist`（id `code-review`）+ `main`（key `code-review`）。
Locale：`ctx.get('locale')` + `locale.register('code-review', dict)`，`locale/zh.json` / `locale/en.json` 只放 `meta`。

**页面结构（整页，深色高级数据台）**

- HUD：品牌 + 项目切换器（下拉）+ 健康徽章（OCR/LLM/Git）+ 最近动态 + 「新建 Review」主按钮。
- Tabs：`总览` / `评审` / `项目` / `架构` / `信息流` /（齿轮=设置）。
- 总览：
  - 6 个大数字卡（Review 总数、近 7 天、进行中、问题总数、已审文件、覆盖模块），带环比/迷你走势。
  - **GitHub 风格热力图**：53 周 × 7 天，月份/星期标签、tooltip（日期/提交/增删/评审数/问题数）、
    色阶（0 到 max 五档）、图例、年份/指标切换（提交 vs 评审 vs 问题）；右侧显示当前连续天数/最长连续/最忙一天。
  - 实时「评审队列」：running/queued 卡片带 stage 进度条、当前阶段、耗时、activity 滚动；点击进详情。
  - 「最近 Review」列表：类型徽章、项目、文件数、问题分级、耗时、状态；点击进详情。
  - 「最近项目」：卡片 + mini 热力图 + 最近评审时间 + 问题数。
  - 「热点模块」：模块名/项目/评审次数/问题数/风险色条。
  - 「动态」：时间轴（最近 100），新事件闪入。
- 评审：全部 job 列表 + 状态/类型/项目筛选 + 搜索；行内展开最近 activity；点击进详情。
- 详情（页内切换，返回按钮）：标题/类型/项目/引擎/耗时/tokens；阶段时间线（完成/进行/跳过）；
  summary headline + projectSummary；finding 列表按 severity 分组，支持按 category/文件过滤、搜索；
  每条 finding：file:line、严重度/类别徽章、内容、代码片段（existing → suggestion 双栏 diff 风格）、
  「复制建议」；右侧 sticky 概览：问题分布、涉及文件、覆盖率、原始 OCR 会话/session id、重新运行/取消。
- 项目：项目卡网格（branch/head/dirty/language/模块数/LOC/热力图/最近 review）；选中切换当前项目。
- 架构：模块依赖图（SVG，节点大小=LOC，颜色=风险，环高亮），右侧指标（模块数/环/最大扇入/不稳定依赖）、
  module 表（可排序）；点击节点过滤下方 findings。
- 信息流：入口→服务→数据 三列/泳道图（SVG 连线，风险边高亮），点节点看关联文件与 findings；列出 flow 摘要。
- 新建 Review 弹层：项目、6 种类型卡（推荐/说明/预计范围）、scope 输入（commit/from-to/模块路径多选/背景说明/
  effort/engine/exclude/budget），提交后立即出现在队列。
- 空态/加载态/错误态齐全；轮询失败保留最后好数据并降级显示，指数退避。
- 设置抽屉：显示 OCR 路径/版本、LLM 配置状态与配置命令、项目根目录、状态目录、轮询间隔、热力图年份。

**视觉**：深色（#0a0f1a 底），玻璃卡片细边框，主色青绿 #35e0c8，严重度色 critical #ff5d6c / high #ff8f4d /
medium #ffd166 / low #6ea8fe；字体 system-ui + ui-monospace；圆角 12-16；克制的渐变与光晕；
running 用呼吸点 + 进度流动；数字 count-up；热力图格子入场 stagger；不堆砌霓虹。

**预览自检**：`tests/code-review/preview/` 用 mock Snapshot 渲染 client.js（模拟 `__ModuleLoader__`/connection/slots/locale），
Playwright 截图到 `docs/screenshots/code-review-*.png`，并做关键断言（无 console error、热力图 371 格、详情可打开等）。

---

## 6. 文件归属 / 并发约定

| 路径 | Owner |
|---|---|
| `plugins/dsh-code-review/{index.js,package.json,cordis.patch.yml,icon.svg,README.md}` | Lead |
| `plugins/dsh-code-review/host/{config,shared,store,snapshot,jobs,prompts}.js` | Lead |
| `plugins/dsh-code-review/host/{git,ocr}.js` | A |
| `plugins/dsh-code-review/host/analyze.js` | B |
| `plugins/dsh-code-review/{client.js,locale/*.json}` + `tests/code-review/preview/**` | C |
| `tests/code-review/{git-ocr,analyze}*.mjs` | A/B 各自 |
| `docs/CODE-REVIEW-CONTRACT.md` | Lead（别人只读） |

改共享文件前先在任务板留言。只允许在归属文件内写。
