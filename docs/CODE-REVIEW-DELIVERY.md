# dsh-code-review 交付说明

> 插件包：`plugins/dsh-code-review`（`@jkin8010/dsh-code-review` v0.2.1）
> 依赖：`ocr`（`@alibaba-group/open-code-review`）v1.13.6、`git`、Node 22+
> 本机已安装到 desktop profile；**重启 DSH 后生效**（见文末）。

## 1. 完成了什么

一个 DSH 整页插件「代码评审中心」：左侧栏入口 + 总览/评审/项目/架构/信息流五个 Tab，
把 open-code-review 的 AI 评审、本地结构分析、评审历史与 Git 热力图汇成一个可操作、可追踪的评审工作台。

支持的评审：

| 类型 | 引擎 | 说明 |
|---|---|---|
| 当前改动 `workspace` | `ocr review` | staged + unstaged + untracked |
| 单次提交 `commit` | `ocr review --commit` | 与 parent 对比 |
| 分支对比 `range` | `ocr review --from --to` | merge-base 语义 |
| 项目架构 `architecture` | 本地模块图 + `ocr scan` | 依赖/环/分层/上帝模块/缺测试 |
| 代码模块 `module` | 本地指标 + `ocr scan --path` | 指定目录/文件 |
| 信息流 `flow` | 本地链路抽取 + `ocr scan` | 入口→服务→数据/外部依赖 |

三种引擎，按 `auto` 依次选择：

1. `ocr`：OCR 自带 LLM（`OCR_LLM_*` / `~/.opencodereview/config.json` / `ANTHROPIC_*`，也可用插件配置/token 文件）。
2. `delegate`：**委托模式**。OCR 负责文件选取与规则解析，评审由 DSH 当前会话模型完成
   （`ctx.llm.stream` + `agentDefaultModel.currentSelection()`），不需要额外 API Key。
3. `structural`：离线结构分析（架构/模块/信息流/diff 启发式），零 LLM 依赖。

模型评审失败/未配置时自动降级为 `structural` 并在评审摘要里注明，不伪造 AI 结论。

## 2. 界面

- **总览**：6 个指标卡；GitHub 风格 53 周 × 7 天热力图（提交/评审/问题三种口径，悬停看当日提交、增删、评审、问题，连续天数/最忙一天/活跃天数）；实时评审队列（阶段进度、当前阶段、耗时、最近动态）；最近评审；最近项目（mini 热力图）；热点模块；跨评审动态时间轴。
- **评审**：全部任务列表，状态/类型/项目筛选 + 搜索；行内展开最近动态；点击进入详情。
- **详情**：阶段时间线（解析→选文件/结构→AI→归并→报告）；总结、覆盖率、问题分布、涉及文件；按严重度分组的 finding，含文件:行号、类别、原码/建议码双栏对比、复制建议；重新运行/取消/删除/复制 Markdown。
- **项目**：项目卡（分支/HEAD/dirty/语言/模块/LOC/mini 热力图/最近评审）；仓库信息；模块明细表。
- **架构**：模块依赖环形图（大小=LOC、颜色=风险、红虚线=循环依赖），点位 tooltip、点击过滤；架构指标；模块表；关联问题。
- **信息流**：入口→服务→数据/外部 四列链路图，点击节点查看关联文件与 findings；链路概览；flow 列表；关联问题。
- **新建 Review**：项目、6 类评审、scope（commit/from-to/模块路径）、effort、engine、exclude、token budget、背景说明；提交后立即入队。
- **设置抽屉**：OCR 版本/路径、LLM 三态（OCR 配置 / DSH 委托 / 未配置）与配置方式、测试 LLM、项目根/额外项目、状态目录、轮询、热力图区间、快照版本。

视觉：深色 code intelligence console，主色青绿 `#35e0c8`，严重度色 critical/high/medium/low，等宽代码，克制动效。

## 3. 架构

```
plugins/dsh-code-review/
  index.js          Host 入口：RPC（/api/code-review）、生命周期、依赖装配
  client.js         Web 整页 UI（window.__ModuleLoader__ + React.createElement，无构建步骤）
  host/
    config.js       配置归一化、ocr 探测、OCR_LLM_* 注入
    shared.js       Finding 归一化、日期/统计工具
    files.js        源码遍历 / 安全读取（256KB 上限）
    store.js        评审历史：index.json + jobs/<id>.json + stats.json + activity.json，原子写
    git.js          项目发现、git 元信息、一年热力图（单次 git log --numstat）、模块树
    ocr.js          ocr CLI：probe/probeLlm/preview/runReview/llmTest、进度解析、超时/取消、artifact
    analyze.js      架构（Tarjan 环/多语言 import/分层）、模块、信息流、diff 四类离线分析
    llm-review.js   委托模式：OCR 选文件 + DSH 模型评审 + 严格 JSON 解析
    prompts.js      评审 background / rule / 标题
    jobs.js         6 阶段状态机、双引擎合并、去重、统计、取消/重试/持久化
    snapshot.js     快照：项目/热力图/统计/健康/动态（带 TTL 缓存）
  locale/           meta 文案
```

- RPC 信封与 DSH 管理路由一致：`POST /api/code-review`，`{type:'client-request',...}` → `{type:'server-response', result:{ok,value|error}}`。
- 前端 2s 轮询快照；Host 缓存项目 5min、当前项目热力图 1min、OCR 健康 1min，轮询不重复打 git/ocr。
- 评审状态持久化在 `~/.dsh/code-review/`；Host 重启时遗留 running 自动标记为中断。
- 取消：SIGTERM → 2s → SIGKILL；重试创建新 job。

## 4. 验证

| 套件 | 命令 | 结果 |
|---|---|---|
| 引擎状态机 / 四类评审 / 快照 / 持久化 | `node tests/code-review/engine-selftest.mjs` | ✅ |
| 委托模式（OCR 选文件 + DSH 模型） | `node tests/code-review/delegate-selftest.mjs` | ✅ |
| 对话内工具 `code_review`（start/status/detail/list） | `node tests/code-review/tool-selftest.mjs` | ✅ |
| Host RPC 全链路（真实 git/ocr/analyze + 假 Cordis） | `node tests/code-review/host-selftest.mjs` | ✅ |
| git/热力图/OCR 适配（真实仓库 + 真实 ocr preview） | `node tests/code-review/git-ocr.test.mjs` | ✅ 33/33 |
| 架构/模块/信息流/diff 分析 | `node tests/code-review/analyze.test.mjs` | ✅ 8/8 |
| 真实 client.js 渲染 + 截图 + DOM 断言 | `node tests/code-review/preview/shoot.mjs` | ✅ |

截图：`docs/screenshots/code-review-{overview,reviews,detail,launch,projects,architecture,flow,settings}.png`。

## 5. 对话内使用

安装/重启后，插件注册模型工具 `code_review`，可在任意项目会话中让 Agent 直接启动评审并在对话里返回 findings：

- 「用代码评审中心评审当前项目的架构」
- 「review 当前改动，只看 high 及以上」
- 「评审 host 模块」 / 「从信息流角度 review 消息链路」
- 「查看最近一次评审的详情」

`action=status/detail/list` 查询进度与历史，`wait:false` 可后台执行。完整界面仍在侧栏「代码评审中心」。

## 6. 已知限制

- OCR 的 LLM 未配置时只能结构分析或委托模式；OCR 的 `ocr review` 需要真实 API Key。
- 离线分析是启发式（正则/括号匹配，非 AST），对动态语言/复杂 DI 的调用链只连一层，可能漏报或误报；已在规则上做保守收敛。
- 信息流图的节点上限 40，超出按入口>服务>数据优先级截断。
- 非 Git 目录支持架构/模块/信息流评审；当前改动/提交/分支评审需要 Git 仓库。
- 热力图按 `今天-(days-1)` 开窗，跨时区 author date 与 `--since` 边界可能差 1 天（已过滤到窗口内）。
- `language` 只识别内置扩展名表；full inspect 受 4000 文件上限、LOC 跳过二进制与 >2MB 文件。

## 7. 安装状态与本机启用

已于本机 desktop profile 完成：

- `~/.dsh/profiles/desktop/package.json`：新增依赖
  `"@jkin8010/dsh-code-review": "link:/Users/jkin/workspace/jkin8010/dhs-feishu-plugin"`
  （仓库根 `package.json` 是 bundle 清单，exports 指向 `plugins/dsh-code-review/`）
  和 `dsh.profile.bundles` 末位 `@jkin8010/dsh-code-review`；
- `~/.dsh/profiles/desktop/node_modules/@jkin8010/dsh-code-review` 已链接；
- `~/.dsh/profiles/desktop/cordis.patch.yml` 追加插件配置（projectRoots、extraProjects、ocr 选项）。

`plugin_manager` 返回 `restart-required`（package-moved），因此需要**重启 DSH** 让 Host 行挂载，
然后刷新页面即可在左侧栏看到「代码评审中心」。

启用后建议检查：

1. 设置抽屉：OCR 版本应为 `v1.13.6`；LLM 状态为 `delegate`（本机无 OCR Key）或 `configured`。
2. 总览应出现项目卡与热力图；点「新建 Review」跑一次「代码模块」评审（选 `dsh-code-review/host`），
   观察实时队列、阶段进度与详情页 findings。
3. 如需 OCR 原生 AI 评审：`ocr config provider` 配置后，设置页「测试 LLM」应通过，引擎自动切到 `ocr`。

### 从 Git URL 安装

仓库根 `package.json` 声明了 `dsh.bundle`，因此 `plugin_manager` 可直接安装：
`install_bundle target: https://github.com/jkin8010/dsh-code-review`（或本地 clone 根目录）。
