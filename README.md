# dsh-code-review

> 基于 [alibaba/open-code-review](https://github.com/alibaba/open-code-review) 的 DeepSeek Harness 代码评审插件。
> 四类评审（当前改动 / 项目架构 / 代码模块 / 信息流业务工作流）、实时进度与动态、
> GitHub 风格提交热力图、评审详情与项目/模块统计，一屏完成。

![评审中心总览](docs/screenshots/code-review-overview.png)

## 特性

- **四类评审**
  - **当前改动**：staged + unstaged + untracked（`ocr review`）
  - **单次提交 / 分支对比**：`ocr review --commit`、`--from/--to`
  - **项目架构**：多语言 import 依赖图、Tarjan 循环依赖、分层/上帝模块/缺测试（本地分析 + `ocr scan`）
  - **代码模块**：指定目录/文件的整文件评审（`ocr scan --path`）
  - **信息流业务工作流**：入口 → 服务 → 数据/外部依赖，检查校验、鉴权、事务、幂等、超时、吞异常
- **三引擎自动选择**
  1. `ocr`：OCR 自带 LLM（`OCR_LLM_*` / `~/.opencodereview/config.json`）
  2. `delegate`：OCR 负责选文件与规则解析，评审由 DSH 当前会话模型完成（无需额外 API Key）
  3. `structural`：离线结构分析，零 LLM 依赖；模型不可用时自动降级并注明
- **实时可追踪**：每个评审六阶段状态机、阶段进度、动态流、取消/重试，Host 重启自动标记中断
- **GitHub 风格热力图**：53 周 × 7 天，提交/评审/问题三种口径，悬停看当日提交、增删、评审、问题，连续天数/最忙一天
- **详情与统计**：按严重度分组的 findings、文件:行号、原码/建议码双栏对比、复制建议；
  最近评审项目、热点模块、严重度/类别分布、覆盖率
- **项目页 / 架构依赖图 / 信息流泳道图 / 新建评审弹层 / 设置抽屉**

![评审详情](docs/screenshots/code-review-detail.png)
![项目架构图谱](docs/screenshots/code-review-architecture.png)
![信息流业务链路](docs/screenshots/code-review-flow.png)

> 截图为预览 harness 渲染；项目列表取自 [@jkin8010](https://github.com/jkin8010) 的公开仓库名称，评审数据为演示数据。

## 安装

需要 DeepSeek Harness（含 Web UI）、`ocr` CLI ≥ 1.13、`git`、Node 22+。

### 一键安装（把下面这行 Prompt 发给 DSH）

```text
请安装 DSH 插件 https://github.com/jkin8010/dsh-code-review ：用 plugin_manager 的 install_bundle 直接安装这个 Git 仓库，安装完成后检查插件是否启用、ocr --version 与 LLM 引擎状态，并告诉我是否需要重启 DSH。
```

> 仓库根 `package.json` 就是 DSH bundle 声明，因此可以**直接从 Git URL 安装**（插件代码在 `plugins/dsh-code-review/`）。
> `plugin_manager` 返回 `restart-required` 时重启 DSH 即可生效；返回已应用则刷新页面。

### 手动安装

```bash
# 1) 安装 open-code-review CLI（可选；不装则走离线结构分析）
npm i -g @alibaba-group/open-code-review

# 2) 在 DSH 中安装（Web 侧栏 Plugins 或 agent tool）；以下两种 target 等价：
#    - Git URL:      https://github.com/jkin8010/dsh-code-review
#    - 本地 clone 根: /绝对路径/dsh-code-review
plugin_manager → action: install_bundle, target: https://github.com/jkin8010/dsh-code-review
```

> 本插件是 profile bundle；HMR 开启时可热加载，否则重启 DSH 后生效。
> 插件本身零第三方依赖，无需额外 `pnpm install`。

### 配置 OCR 的 LLM（可选）

`ocr` 默认需要 LLM 才能做 AI 评审；不配置时插件自动使用 `delegate`（DSH 当前模型）或 `structural`（离线分析）。

```bash
ocr config provider    # 选择 provider 并填入 API Key
ocr config model
ocr llm test           # 验证连通性
```

或通过插件配置 / 环境变量提供（token 只存在于 Host 进程，不回传前端）：

```yaml
- id: qise-code-review
  name: '@jkin8010/dsh-code-review'
  config:
    projectRoots: [/Users/you/workspace]       # 自动发现其下有 .git 的直接子目录
    extraProjects: [/Users/you/current/repo]    # 额外项目（可非 Git）
    engine: auto                                # auto | ocr | structural
    ocr:
      llmUrl: ''
      llmTokenFile: ~/.config/ocr/token
      model: ''
      effort: medium                            # low | medium | high
      concurrency: 8
      timeoutMin: 15
```

完整配置项见 [plugins/dsh-code-review/README.md](plugins/dsh-code-review/README.md)。

## 使用

### 在项目对话里直接 Review（推荐）

插件注册了模型工具 **`code_review`**（安装/重启后生效）。在任意项目会话里直接说一句即可：

- 「用代码评审中心评审当前项目的架构」
- 「review 当前改动，只看 high 及以上」
- 「评审 `plugins/dsh-code-review/host` 这个模块」
- 「从信息流角度 review 当前项目的消息链路」
- 「查看最近一次评审的详情」

复制下面这句即可一次展开完整 review：

```text
用代码评审中心评审当前项目：先看项目架构，再评审 plugins/dsh-code-review/host 模块，最后从信息流角度 review 消息链路；high 以下可以略过。
```

Agent 会调用 `code_review` → `start`（默认等待评审完成）→ 在对话里返回问题摘要与 findings；完整分组、代码建议和覆盖率仍在侧栏「代码评审中心」查看。

工具参数（Agent 自动填写，也可直接要求）：

| 参数 | 说明 |
|---|---|
| `action` | `start` / `status` / `detail` / `list` |
| `project_path` | 省略 = 当前会话工作目录（当前项目） |
| `type` | `workspace` / `commit` / `range` / `architecture` / `module` / `flow`；省略时有 `paths` 走模块评审，否则走项目架构 |
| `scope` | `paths`（模块）/ `commit` / `from`+`to` |
| `options` | `effort`、`background`、`exclude`、`max_tokens_budget` |
| `wait` | 默认 `true`，等待完成；`false` 立即返回任务 id |
| `job_id` / `severity` / `limit` | 查询详情时使用 |

> 不想要等待时可说「后台跑，跑完告诉我」，Agent 会用 `wait:false`，之后再用 `status`/`detail` 取结果。

### 在页面里使用

1. 左侧栏打开「代码评审中心」，在顶部选择项目（`projectRoots` 自动发现 + `extraProjects`）。
2. 点「新建 Review」，选择类型：
   - 当前改动 / 单次提交 / 分支对比：填 commit 或 from/to
   - 项目架构 / 代码模块 / 信息流：模块评审填目录路径，信息流可留空自动发现
3. 提交后在总览「实时评审队列」查看阶段进度与动态，点击进入详情查看 findings。
4. 总览热力图与「最近项目 / 热点模块」跟踪评审节奏；项目页可切换当前项目。

## 仓库结构

```
package.json                    # DSH bundle 根清单：dsh.bundle → plugins/dsh-code-review/cordis.patch.yml
plugins/dsh-code-review/        # 插件实现（Host/Client/安装包）
  index.js                     # Host：/api/code-review RPC、生命周期、依赖装配
  client.js                    # Web 整页 UI（React.createElement，无构建步骤）
  host/                        # git / ocr / 分析器 / 任务状态机 / 快照 / 持久化 / 委托评审
  locale/                      # 侧栏与设置文案
  cordis.patch.yml             # bundle 默认配置
tests/code-review/             # 自检（真实 git/ocr + 假 Cordis/LLM）与截图 harness
docs/CODE-REVIEW-CONTRACT.md   # 插件与前后端的字段/接口契约
docs/CODE-REVIEW-DELIVERY.md   # 交付、验收记录与已知限制
docs/screenshots/              # 界面截图
```

## 验证

```bash
node tests/code-review/engine-selftest.mjs     # 四类评审 + 快照 + 持久化
node tests/code-review/delegate-selftest.mjs   # OCR 选文件 + DSH 模型评审
node tests/code-review/host-selftest.mjs       # 真实 git/ocr/analyze + RPC 全链路
node tests/code-review/git-ocr.test.mjs        # 真实仓库 + 真实 ocr --preview（33 项）
node tests/code-review/analyze.test.mjs        # 架构/模块/信息流/diff（8 项）
node tests/code-review/preview/shoot.mjs       # 真实 client.js 渲染 + 截图 + DOM 断言
```

## 设计要点

- Host 持有全部 I/O：`git` / `ocr` 子进程 / 持久化；前端只轮询一个认证 RPC 快照（2s），
  Host 侧缓存项目、热力图与 OCR 健康，轮询不重复打上游。
- 评审状态机六阶段：`resolve → plan → structure → ai → merge → report`；
  AI 阶段失败或无配置时降级为离线结构分析，不伪造结论。
- 评审历史原子写入 `~/.dsh/code-review/`（索引 + 明细 + 按天统计 + 动态），重启自动恢复。
- 取消：`SIGTERM → 2s → SIGKILL`；重试创建新任务；失败分类可操作。

## 已知限制

- 离线分析为启发式（非 AST），动态语言调用链只连一层；信息流图节点上限 40。
- 当前改动/提交/分支评审需要 Git 仓库；非 Git 目录仍可做架构/模块/信息流评审。
- 热力图按本地时区 `今天-(days-1)` 开窗，跨时区边界可能差 1 天。
- `language` 只识别内置扩展名表；full inspect 受 4000 文件上限，LOC 跳过二进制与 >2MB 文件。

## License

[Apache-2.0](LICENSE)。`ocr` 引擎来自 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)（Apache-2.0）。
