# dsh-code-review — Implementation Contract v1

English | [简体中文](CODE-REVIEW-CONTRACT.zh.md)

Plugin package: `plugins/dsh-code-review` (`@jkin8010/dsh-code-review`).
Built on [alibaba/open-code-review](https://github.com/alibaba/open-code-review) (`ocr` CLI v1.13+).
Sidebar entry `sidebar.panellist` (id `code-review`) + full page `main` (key `code-review`).
The client fetches data over authenticated RPC; the host owns all I/O (git / ocr subprocesses / persistence).

```js
// client
connection.rpc.call('/api', 'code-review', { method, payload }, undefined)
// host: POST /api/code-review { type:'client-request', method:'code-review', rpcId, payload:{method,payload} }
//       <- { type:'server-response', rpcId, result:{ ok, value|error } }
```

> This contract is the **single source of truth**. Every module produces/consumes data in the shapes defined here; change this file first when changing fields.
> Snapshots must be plain JSON (no functions, circular references or undefined). All times are ISO-8601 strings (`new Date().toISOString()`).

---

## 1. Review types

| type | Name | OCR command | Required scope | Notes |
|---|---|---|---|---|
| `workspace` | Current changes | `ocr review` (staged+unstaged+untracked) | — | Requires a git repository; reports "no changes" when the working tree is clean |
| `commit` | Single commit | `ocr review --commit <sha>` | `commit` | |
| `range` | Branch comparison | `ocr review --from <a> --to <b>` | `from`,`to` | merge-base semantics |
| `architecture` | Project architecture | `ocr scan --path <anchors>` + local architecture analysis | — | Whole-project module dependency graph / cycles / layers / hotspots |
| `module` | Code module | `ocr scan --path <paths>` + local module analysis | `paths[]` | Specified directory/files |
| `flow` | Information flow | `ocr scan --path <flow files>` + local information-flow analysis | `paths[]` (optional) | Entry→service→data business chain |

`engine`:
- `ocr`: OCR's own LLM (`OCR_LLM_*` / `~/.opencodereview/config.json`), runs `ocr review/scan`;
- `delegate`: **delegation mode** — OCR still handles file selection and rule resolution, while the review itself is
  performed by the DSH current-session model (`ctx.llm.stream` + `ctx.agentDefaultModel.currentSelection()`); no OCR API key needed;
- `structural`: offline structural analysis, always available.

With `engine=auto`: OCR LLM configured → `ocr`; otherwise DSH model available → `delegate`; otherwise `structural`.
When model review is unavailable it automatically degrades to structural and notes this in summary.notes.

---

## 2. Host module interfaces (file-level contract)

### `host/config.js` (Lead)

```js
export const DEFAULTS // see file
export function normalizeConfig(rawConfig, { hostCwd } = {}) -> Config
export function resolveOcrEnv(config) -> { [env]: string }      // OCR_LLM_URL / OCR_LLM_TOKEN / OCR_LLM_MODEL etc.
export function findOcrBinary(config) -> string                  // absolute path or 'ocr'
export function projectId(path) -> 'p-<8hex>'
export function projectName(path) -> string
export function expandHome(p) -> string
```

`Config` (after normalize):
```js
{
  enabled: true,
  pollSeconds: 2,                 // frontend polling
  projectRoots: [],               // auto-discovered projects (subdirectories containing .git)
  extraProjects: [],              // extra project paths to include (may be non-Git, used for module/architecture/flow reviews)
  projectDepth: 2,                // directory scan depth for projectRoots (1-3)
  maxProjects: 40,                // maximum number of projects to include
  // at runtime these are also merged in: the DSH workspace, already-reviewed projects, projects added in the UI (persisted in stateDir/projects.json)
  defaultProjectPath: '',         // empty = the most recently committed discovered project (or the first projectRoots entry)
  excludeProjects: [],            // directory names or path prefixes
  stateDir: '~/.dsh/code-review',
  engine: 'auto',                 // auto | ocr | structural
  maxJobs: 200,
  heatmapDays: 365,
  gitScanLimit: 4000,             // max commits read from git log
  ocr: {
    command: '',                  // empty = auto-detect
    provider: '', model: '',
    llmUrl: '', llmToken: '', llmTokenFile: '',
    effort: 'medium', concurrency: 8, timeoutMin: 15,
    maxTokens: 0, maxTokensBudget: 0,
    extraArgs: [],
  },
}
```

### `host/shared.js` (Lead)

```js
export const SEVERITIES = ['critical','high','medium','low']
export const CATEGORIES = ['bug','security','performance','maintainability','test','style','documentation','other']
export function nowIso() -> string
export function errorText(e) -> string
export function hash(text, len=12) -> string            // truncated sha1 hex
export function slug(text) -> string                    // filename-safe
export function dateKey(ts) -> 'YYYY-MM-DD'             // local timezone
export function addDays(dateKey, n) -> 'YYYY-MM-DD'
export function dayList(from, to) -> string[]
export function severityRank(sev) -> number
export function normalizeSeverity(v) -> 'critical'|'high'|'medium'|'low'
export function normalizeCategory(v) -> CATEGORIES[number]
export function finding(input) -> Finding               // unified id/fingerprint/fields
export function countFindings(findings) -> {critical,high,medium,low,total}
export function countBy(findings, key) -> [{key,count}]
export function trimText(text, max) -> string
export function readJsonFile(path, fallback) -> any     // fault-tolerant
export async function atomicWriteJson(path, value) -> void
export function parseJsonLoose(text) -> any|null
export function clamp01(n) -> number
export function pct(a,b) -> number                      // integer 0..100
```

`Finding`:
```js
{
  id: 'f-<12hex>',            // stable fingerprint (hash of path+startLine+content)
  severity: 'critical|high|medium|low',
  category: 'bug|security|performance|maintainability|test|style|documentation|other',
  path: 'src/x.ts',
  startLine: 0, endLine: 0,   // 0 means unlocated
  title: 'one-line problem (≤120 chars)',   // first sentence of content, or the rule title
  content: 'detailed explanation (Markdown plain text)',
  suggestionCode: '', existingCode: '', thinking: '',
  source: 'ocr|structural',
  rule: '',                    // rule id / detector name
  module: '',                  // top-level module name (for statistics)
}
```

### `host/store.js` (Lead)

```js
export function createStore({ dir, maxJobs = 200, logger }) -> Store
// Store:
//   await store.init()
//   store.saveJob(job)                    // memory + async write to jobs/<id>.json
//   store.getJob(id) -> Job|null
//   store.listJobs() -> Job[]             // newest→oldest
//   store.deleteJob(id) -> boolean
//   store.getStats() -> Stats
//   store.recordReview(job)               // accumulate stats (per day)
//   store.status() -> { state, path, jobs, error }
//   await store.flush()
```
Persistence: `<stateDir>/jobs/<id>.json` (full Job including findings), `<stateDir>/index.json` (array of summaries),
`<stateDir>/stats.json` (per-day aggregates). Writes use tmp+rename, reads are fault-tolerant. On startup only index + stats are loaded; findings are lazy-loaded on demand.

### `host/git.js` (Teammate A)

```js
export async function discoverProjects({ roots, exclude = [], limit = 24 }) -> ProjectSummary[]
// scans the direct subdirectories of roots (those containing .git), returns summaries sorted by lastCommitAt descending (without heatmap.modules detail)

export async function inspectProject({ repoPath, heatmapDays = 365, moduleDepth = 1, light = false }) -> ProjectView
// full ProjectView: git metadata + language stats + top-level modules + one-year heatmap
// light:true skips per-file LOC (loc may be null), still returns fileCount/moduleCount/heatmap, for project card summaries

export async function gitHeatmap({ repoPath, days = 365 }) -> Heatmap
export async function moduleTree({ repoPath, depth = 2, maxModules = 60 }) -> ModuleSummary[]
export async function changedFiles({ repoPath, mode, commit, from, to }) -> { files:[{path,insertions,deletions,status}], totalInsertions, totalDeletions }
export async function gitMeta({ repoPath }) -> { kind:'git'|'dir', branch, head, headSubject, committedAt, dirty, remote, error }
```

`ProjectView`:
```js
{
  id:'p-1a2b3c4d', name:'mopng-api', path:'/Users/.../mopng-api', kind:'git',
  branch:'master', head:'bf9c296', headSubject:'Refactor README...', committedAt:'ISO', dirty:false,
  remote:'git@github.com:...', language:'Python', fileCount: 42, moduleCount: 6, loc: 8600,
  modules:[{ id:'m-...', name:'mopng', path:'mopng', files:12, loc:2400, lastCommitAt:'ISO',
             lastReviewAt:'ISO|null', reviewCount:3, findings:{critical:0,high:1,medium:2,low:0,total:3}, risk:'low|medium|high' }],
  heatmap: Heatmap,
  lastReviewAt:'ISO|null', reviewCount: 4, findings:{...}, error: null,
  at:'ISO'
}
```

`Heatmap`:
```js
{
  from:'2025-11-10', to:'2026-11-10', days:[{date:'2026-01-02', commits:3, insertions:120, deletions:30}], // only days with activity?
  max: 12, totalCommits: 812, totalInsertions: 42000, totalDeletions: 12000,
  streaks:{ current: 3, longest: 21 }, busiest:{ date:'2026-03-11', commits:12 },
  activeDays: 240
}
```
> `days` **must cover every day from from→to** (fill inactive days with `commits:0,insertions:0,deletions:0`) so the frontend can draw cells directly.
> Note: read `git log --numstat` in a single pass; per-day invocations are forbidden.

### `host/ocr.js` (Teammate A)

```js
export async function probe({ config, env }) -> { available, version, path, error }
export async function probeLlm({ config, env }) -> { configured, provider, model, source, error }
export async function preview({ projectPath, type, scope, config, env }) -> {
  ok, mode, files:[{path,insertions,deletions,status,willReview,reason}],
  totalInsertions, totalDeletions, reviewable, excluded, error
}
// type mapping: workspace|commit|range -> ocr review --preview
//               module                 -> ocr scan --preview --path <scope.paths>
//               scan                   -> ocr scan --preview --path <scope.paths|whole repo>
export async function runReview({ jobId, projectPath, type, scope, plan, config, env, background, rules, signal, onEvent, onProgress }) -> {
  ok, status, comments:[FindingRaw], summary:{filesReviewed,comments,totalTokens,inputTokens,outputTokens,elapsed},
  projectSummary, warnings:[{type,file,message}], sessionId, manifest, rawOutputPath, stderrTail, error
}
export async function llmTest({ config, env }) -> { ok, latencyMs, message, error }
```

- Argument assembly: `review` / `scan`, always `--format json --output <tmpfile> --audience human --repo <projectPath>`,
  plus `--effort/--concurrency/--timeout/--exclude/--max-tokens/--max-tokens-budget/--background-file`.
  `architecture`/`flow` use `scan`; `module` uses `scan --path`; `workspace/commit/range` use `review`.
- LLM: `resolveOcrEnv(config)` injects `OCR_LLM_URL/OCR_LLM_TOKEN/OCR_LLM_MODEL` (the token exists only in the Host process).
- Progress: in JSON mode human progress goes to **stderr** as `[ocr] ...`; parse the `group`/`round`/`token budget`/`Session:`
  lines and call `onProgress`. stdout is JSON but is written via `--output`, so stdout is only a fallback.
- Cancellation: kill the subprocess when `signal.aborted` (SIGTERM→SIGKILL after 2s).
- Failure classification: `ocr-missing | llm-unconfigured | git | timeout | cancelled | ocr-failed`.
- Raw output and the stderr tail are written to `<stateDir>/artifacts/<jobId>.json|.log`.

### `host/analyze.js` (Teammate B)

```js
export async function analyzeArchitecture({ project, files, readFile }) -> ArchAnalysis
export async function analyzeModule({ project, modulePath, files, readFile }) -> ModuleAnalysis
export async function analyzeFlow({ project, files, readFile }) -> FlowAnalysis
export async function analyzeDiff({ project, files, diffText, readFile }) -> DiffAnalysis
```

All analyses return:
```js
{
  findings: Finding[],
  metrics: {...},                 // free-form structure, rendered by the frontend as needed
  graph: { nodes:[{id,label,kind,path,files,loc,risk,meta:{}}], edges:[{from,to,kind,count,risk}], cycles:[[id]] } | null,
  summary: { headline, notes:[], stats:{} },
  activity: [{ ts, level, text }],   // readable progress of the analysis
}
```
- `architecture`: module dependency graph (JS/TS import/require, Python import/from, Go import, Java import, Rust use, PHP use/require),
  Tarjan SCC cycle detection, unstable dependencies (stable→unstable), god modules, orphan modules, missing tests, cross-layer reverse dependencies.
- `module`: file/function metrics, TODO/FIXME, leftover debug code, empty catch, dangerous patterns, duplicate windows, oversized files.
- `flow`: entry identification (Express/Koa/FastAPI/Flask/Spring/Go handler/CLI/Feishu events/frontend fetch) → service calls → data access
  (SQL/ORM/Redis/queue/external HTTP). findings: missing validation, write paths without transactions/idempotency, missing authorization,
  external calls without timeout/retry, swallowed exceptions, sensitive data in logs. `graph.nodes[].kind`: `entry|service|data|external`,
  `edges[].kind`: `call|read|write|emit|http`.
- Pure Node built-in modules, zero third-party dependencies; each file read is capped at 256KB.

### `host/prompts.js` (Lead)

```js
export function buildBackground({ type, project, scope, analysis, userBackground }) -> string  // Markdown
export function buildRules({ type, scope, analysis, options }) -> { rules:[{path,rule,merge_system_rule?}] } | null
export function buildTitle({ type, project, scope }) -> { title, subtitle }
```

### `host/jobs.js` (Lead)

```js
export function createJobs({ config, env, store, logger, git, ocr, analyze }) -> Jobs
// Jobs:
//   await jobs.init()                      // restore from store; mark leftover running jobs as failed/interrupted
//   jobs.start({ projectId|projectPath, type, scope, options }) -> Job
//   jobs.cancel(id) -> boolean
//   jobs.retry(id) -> Job
//   jobs.get(id) -> Job|null
//   jobs.list() -> Job[]
//   jobs.running() -> Job[]
//   jobs.prune()
//   jobs.dispose()
```
Job lifecycle (`stages`):
`resolve → plan → structure → ai → merge → report`
(without AI, `ai` is marked `skipped`; a `workspace` run with no changes completes immediately with a message.)
Progress: each stage weight is `[5,10,25,50,5,5]` (normalized over the enabled stages); `progress` is 0..1; the AI stage is refined by `onProgress`.

### `host/snapshot.js` (Lead)

```js
export function createSnapshot({ config, store, jobs, git, ocr, logger }) -> { build(), refreshProjects(), getProject(id), invalidate() }
```
`build()` must be plain JSON and < 1.5MB (findings do not go into the snapshot; only `running` jobs carry the latest 20 activity entries).

---

## 3. Snapshot

```jsonc
{
  "generatedAt": "ISO", "version": 12, "ok": true,
  "config": {
    "projectRoots": ["/Users/jkin/workspace/jkin8010"],
    "defaultProjectId": "p-...",
    "pollSeconds": 2, "stateDir": "~/.dsh/code-review",
    "engineMode": "auto",          // configured value
    "enginePlan": "ocr",           // actually in effect: ocr | delegate | structural
    "ocrBin": "/Users/.../ocr", "ocrVersion": "open-code-review v1.13.6",
    "llmConfigured": true, "llmDelegate": false,
    "llmProvider": "deepseek", "llmModel": "deepseek-chat",
    "maxJobs": 200
  },
  "health": {
    "ocr":   { "state": "ok",             // ok | missing | unconfigured | error
               "version": "v1.13.6", "path": "...", "error": null, "checkedAt": "ISO" },
    "llm":   { "state": "configured",     // configured(OCR LLM) | delegate(DSH model) | unconfigured | unknown | error
               "provider": "deepseek", "model": "deepseek-chat", "source": "config|env|file|dsh|none",
               "delegateAvailable": true, "delegateProvider": "deepseek-account", "delegateModel": "deepseek-flash",
               "error": null, "checkedAt": "ISO" },
    "git":   { "state": "ok", "projects": 8, "error": null, "checkedAt": "ISO" },
    "store": { "state": "ok", "path": "...", "jobs": 24, "error": null }
  },
  "project": ProjectView,              // currently selected project (complete, including one-year heatmap + modules)
  "projects": ProjectView[],           // summaries (heatmap keeps only totals/streaks/spark (array of 90 days of commit counts), modules keep only top 6), sorted by lastCommitAt
  "overview": {
    "reviewsTotal": 32, "reviews7d": 9, "reviewsToday": 2,
    "running": 1, "queued": 0,
    "findings": { "critical": 3, "high": 12, "medium": 24, "low": 9, "total": 48 },
    "filesReviewed": 214, "tokens": 318000, "modulesCovered": 18, "projectsCount": 8,
    "lastReviewAt": "ISO", "streakDays": 4, "successRate": 0.93
  },
  "jobs": Job[],                        // newest→oldest, at most 40; includes stages/activity, excludes findings
  "activity": [{ "id": "a-...", "ts": "ISO", "kind": "review|finding|system|project",
                 "level": "info|success|warn|error", "text": "...", "jobId": "rv-...", "projectId": "p-..." }],
  "stats": {
    "days": [{ "date": "2026-11-09", "reviews": 2, "findings": 7, "critical": 1, "files": 21, "tokens": 41000 }], // 365 days, gap-filled
    "byType": [{ "type": "workspace", "count": 12 }],
    "bySeverity": [{ "severity": "high", "count": 12 }],
    "byCategory": [{ "category": "bug", "count": 20 }],
    "byProject": [{ "projectId": "p-...", "name": "mopng-api", "count": 6, "findings": 18, "lastAt": "ISO" }],
    "topModules": [{ "projectId": "p-...", "projectName": "mopng-api", "module": "mopng", "count": 4, "findings": 11,
                     "lastAt": "ISO", "risk": "high" }],
    "recentProjects": [{ "projectId": "p-...", "name": "mopng-api", "path": "...", "lastAt": "ISO",
                         "reviewCount": 6, "findings": 18, "health": "ok|dirty|error" }],
    "heatmap": Heatmap                  // merged across projects (commits + reviews + findings per day)
  }
}
```

`Job` (summary, used by the snapshot):
```js
{
  id:'rv-20261110-092500-3f9a', seq:32,
  projectId:'p-...', projectName:'mopng-api', projectPath:'/Users/.../mopng-api',
  type:'workspace', title:'Current changes review · mopng-api', subtitle:'review · 12 files / +340 -86',
  scope:{ paths:[], commit:'', from:'', to:'', flowId:'' },
  engine:'ocr|delegate|structural',
  engineDetail:{ engineMode:'ocr', ocr:true, delegate:false, llmConfigured:true,
                 provider:'deepseek', model:'deepseek-chat' },
  options:{ effort:'medium', background:'', exclude:'', maxTokensBudget:0 },
  status:'queued|running|completed|failed|cancelled',
  stage:{ key:'ai', label:'AI review', index:3, total:6 },
  progress:0.62,
  createdAt:'ISO', startedAt:'ISO|null', finishedAt:'ISO|null', durationMs:12000|null,
  counts:{ filesPlanned:12, filesReviewed:8, findings:5,
           bySeverity:{critical:0,high:2,medium:2,low:1}, byCategory:{bug:3,...}, tokens:41000, modules:3 },
  stages:[{ key:'plan', label:'Select files', status:'done', startedAt:'ISO', finishedAt:'ISO', detail:'12 files' }],
  activity:[{ ts:'ISO', level:'info', text:'OCR finished 3/5 groups' }],   // at most 40
  plan:{ files:[...], totalInsertions:340, totalDeletions:86, reviewable:10, excluded:2 },
  summary:{ headline:'Found 5 problems: 2 high, 2 medium', projectSummary:'', notes:[],
            coverage:{ reviewable:10, reviewed:8, failed:1, waived:0 } },
  error:null, artifacts:{ rawOutputPath:'...', ocrSessionId:'' },
  graph: { nodes:[], edges:[], cycles:[] } | null,   // only for architecture / flow / module (Graph)
  summary: { ..., modules:['mopng','tests'] }        // used for "hot module" statistics
}
```

### `job` RPC return

```js
{ job: Job, findings: Finding[], files: [{path, findings, severityMax}], graph: Graph|null }
```

---

## 4. RPC methods

| method | payload | Returns |
|---|---|---|
| `snapshot` | `{ projectId? }` (switches the current project when provided) | Snapshot |
| `job` | `{ id, includeFindings?:true }` | `{job, findings, files, graph}` |
| `start` | `{ projectId?, projectPath?, type, scope?, options? }` | `{ job }` |
| `cancel` | `{ id }` | `{ ok, job }` |
| `retry` | `{ id }` | `{ job }` |
| `delete` | `{ id }` | `{ ok }` |
| `project` | `{ projectId?, projectPath?, refresh? }` | `{ project: ProjectView }` |
| `fix.mark` | `{ jobId, sessionId? }` | `{ job, fixAt }`；记录该报告创建过修复会话，用于后续自动校验 |
| `job.recheck` | `{ jobId }` | `{ job }`；按相同 type/scope 复评，未再出现的旧 finding 自动标记已修复 |
| `finding.resolve` | `{ jobId, key, resolved? }` | `{ job, resolutions, resolvedCount }`; persists the "fixed/undone" mark (the key comes from `findings[].key` returned by `job`) |
| `fix.create` | `{ jobId }` | `{ sessionId, jobId, prompted, findings, title?, projectName?, error? }`; creates a new session in the project directory and sends the fix prompt |
| `project.browse` | `{ path? }` | `{ path, parent, roots:[{name,path}], entries:[{name,path,hidden}] }`; built-in directory browser, works in any environment |
| `project.add` | `{ path }` (absolute path, Git or a plain directory) | `{ project, snapshot }`, persisted + made current |
| `project.remove` | `{ path }` | `{ ok, snapshot }` (already-reviewed projects are kept, only removed from the "added" set) |
| `graph` | `{ projectId?, projectPath?, kind:'architecture'\|'flow' }` | `{ graph, summary, findings }` |
| `refresh` | `{ scope?:'projects'\|'all' }` | Snapshot |
| `llmTest` | `{}` | `{ ok, latencyMs, message, error }` |
| `ping` | `{}` | `{ ok, at }` |

Errors: `{ ok:false, error:{ code:'code-review/<slug>', message } }`; never throw at the client.

### Slash command `code-review`

The Host registers a global command through `ctx.commands.register`:

```text
/code-review <changes|commit|range|architecture|module|workflow|fix|list|status|help> [@project path] [options]
Options: --fix --async --project <path> --effort <low|medium|high> --background <text> --exclude <globs> --budget <n>
```
- `@path` / `--project`: first add the project with `snapshot.addProjectPath()` (persisted), then review with `jobs.start`
- By default it waits for the review to finish (≤10min) and returns the summary/findings; `--fix` calls `createFixSessionForJob`
- The handler returns `{ kind:'success'|'error', text }`; a parse failure returns an error plus the usage text

### Model tool `code_review`

The Host registers it through `ctx.tools.register` (profiles without a tools service skip it automatically), so reviews can be triggered from a project conversation:

```js
{
  name: 'code_review',
  parameters: {
    action: 'start|status|detail|list',        // required
    project_path?: string,                     // omitted = current session cwd
    type?: 'workspace|commit|range|architecture|module|flow',
    scope?: { paths?: string[], commit?, from?, to? },
    options?: { effort?, background?, exclude?, max_tokens_budget? },
    wait?: boolean,                            // start defaults to true, waits for completion (≤12min)
    job_id?: string, severity?: string, limit?: number,
  },
  output: { ok, action, job, findings?, files?, jobs?, error?, timedOut?, cancelled? }
}
```
`start` reuses `jobs.start` directly and, once the run finishes, returns the summary and findings via `jobs.getFull`; `wait:false` returns the task id immediately.
Tool output is plain JSON, `output.render` renders it as conversation text; `execute` never throws, failures come back as `ok:false`.

---

## 5. Client UI (Teammate C)

Single file `client.js`, `window.__ModuleLoader__.load({ id, factory(require) })`, using only `require('react')`.
The entry returns `{ inject:['slots','connection'], apply(ctx) }` and registers `sidebar.panellist` (id `code-review`) + `main` (key `code-review`).
Locale: `ctx.get('locale')` + `locale.register('code-review', dict)`; `locale/zh.json` / `locale/en.json` contain only `meta`.

**Page structure (full page, dark high-end data console)**

- HUD: brand + project switcher (dropdown) + health badges (OCR/LLM/Git) + latest activity + the "New Review" primary button.
- Tabs: `Overview` / `Reviews` / `Projects` / `Architecture` / `Flow` / (gear = settings).
- Overview:
  - 6 large metric cards (total reviews, last 7 days, in progress, total findings, files reviewed, modules covered), with period-over-period deltas / mini sparklines.
  - **GitHub-style heatmap**: 53 weeks × 7 days, month/weekday labels, tooltip (date/commits/insertions and deletions/review count/finding count),
    color scale (5 buckets from 0 to max), legend, year/metric switch (commits vs reviews vs findings); the right side shows the current streak/longest streak/busiest day.
  - Live "review queue": running/queued cards with a stage progress bar, current stage, elapsed time, scrolling activity; click to open details.
  - "Recent reviews" list: type badge, project, file count, severity breakdown, elapsed time, status; click to open details.
  - "Recent projects": cards + mini heatmap + last review time + finding count.
  - "Hot modules": module name/project/review count/finding count/risk color bar.
  - "Activity": timeline (latest 100), new events flash in.
- Reviews: all jobs list + status/type/project filters + search; inline expand of recent activity; click to open details.
- Details (in-page switch, back button): title/type/project/engine/elapsed/tokens; stage timeline (done/running/skipped);
  summary headline + projectSummary; findings grouped by severity, filterable by category/file, with search;
  per finding: file:line, severity/category badges, content, code snippet (existing → suggestion, two-column diff style),
  "Copy suggestion"; a sticky overview on the right: finding distribution, files touched, coverage, raw OCR session/session id, re-run/cancel.
- Projects: project card grid (branch/head/dirty/language/module count/LOC/heatmap/last review); selecting one switches the current project.
- Architecture: module dependency graph (SVG, node size = LOC, color = risk, cycles highlighted), metrics on the right (module count/cycles/max fan-in/unstable dependencies),
  module table (sortable); clicking a node filters the findings below.
- Flow: entry→service→data three-column/swimlane diagram (SVG edges, risky edges highlighted); click a node to see related files and findings; flow summaries listed.
- New Review modal: project, 6 type cards (recommended/description/estimated scope), scope inputs (commit/from-to/module path multi-select/background note/
  effort/engine/exclude/budget); it appears in the queue immediately after submitting.
- Empty/loading/error states are all covered; when polling fails the last good data is kept and displayed degraded, with exponential backoff.
- Settings drawer: shows OCR path/version, LLM configuration state and configuration command, project roots, state directory, polling interval, heatmap year.

**Visual**: dark (#0a0f1a base), glass cards with thin borders, primary teal #35e0c8, severity colors critical #ff5d6c / high #ff8f4d /
medium #ffd166 / low #6ea8fe; typefaces system-ui + ui-monospace; radii 12-16; restrained gradients and glows;
running uses a breathing dot + flowing progress; number count-up; heatmap cells stagger in; no neon pile-up.

**Preview self-check**: `tests/code-review/preview/` renders client.js with a mock Snapshot (simulating `__ModuleLoader__`/connection/slots/locale),
Playwright screenshots to `plugins/dsh-code-review/screenshots/code-review-*.png`, plus key assertions (no console errors, 371 heatmap cells, details open, etc.).

---

## 6. File ownership / concurrency conventions

| path | Owner |
|---|---|
| `plugins/dsh-code-review/{index.js,package.json,cordis.patch.yml,icon.svg,README.md}` | Lead |
| `plugins/dsh-code-review/host/{config,shared,store,snapshot,jobs,prompts}.js` | Lead |
| `plugins/dsh-code-review/host/{git,ocr}.js` | A |
| `plugins/dsh-code-review/host/analyze.js` | B |
| `plugins/dsh-code-review/{client.js,locale/*.json}` + `tests/code-review/preview/**` | C |
| `tests/code-review/{git-ocr,analyze}*.mjs` | A/B each |
| `docs/CODE-REVIEW-CONTRACT.md` | Lead (others read-only) |

Leave a note on the task board before changing shared files. Only write inside the files you own.
