# Release history / 版本历史

> 关键版本保留在 GitHub Releases；其余版本的说明归档于此（tag/release 已删除，提交仍可通过 SHA 访问）。

## Kept releases

| Tag | Date | Title |
|---|---|---|
| [v0.1.0](https://github.com/jkin8010/dsh-code-review/releases/tag/v0.1.0) | 2026-11-10 | v0.1.0 — 代码评审中心首个版本 |
| [v0.2.0](https://github.com/jkin8010/dsh-code-review/releases/tag/v0.2.0) | 2026-11-10 | v0.2.0 — 对话内直接 Review（code_review 工具） |
| [v0.3.0](https://github.com/jkin8010/dsh-code-review/releases/tag/v0.3.0) | 2026-11-10 | v0.3.0 — 项目来源自动聚合 + 任意路径添加项目 |
| [v0.4.0](https://github.com/jkin8010/dsh-code-review/releases/tag/v0.4.0) | 2026-11-10 | v0.4.0 — 评审报告一键新建修复 Session |
| [v0.5.0](https://github.com/jkin8010/dsh-code-review/releases/tag/v0.5.0) | 2026-11-10 | v0.5.0 — /code-review 斜杠命令（@项目 / --fix） |
| [v0.6.1](https://github.com/jkin8010/dsh-code-review/releases/tag/v0.6.1) | 2026-11-10 | v0.6.1 — 评审报告「已修复」标识 + 架构/数据流重构 |

## Archived releases

### v0.1.1 — v0.1.1 — 支持从 Git URL 直接安装

_Released 2026-11-10_

## 修复

- 仓库根新增 `package.json` 作为 DSH bundle 清单（`dsh.bundle` → `plugins/dsh-code-review/cordis.patch.yml`，`exports` 指向插件 index/client/locale/icon）。
- 修复 `plugin_manager` 从 GitHub URL 安装时报 **“这个包没有声明组合包，不能作为插件管理”** 的问题：之前仓库根没有 manifest，pnpm 安装出 `dsh-code-review 0.0.0`，无法识别为插件。
- 现在可直接安装：`install_bundle target: https://github.com/jkin8010/dsh-code-review`，或本地 clone 后安装仓库根目录。

## 验证

- 真实 `plugin_manager` 从 Git URL 安装成功（`@qise/dsh-code-review 0.1.1`，bundle patch 可解析，仅需重启 DSH 生效）。
- 根 manifest 的 `exports`（host/client/locale）在安装后的包内可正确解析。

安装后若返回 `restart-required`，重启 DSH 即可看到左侧栏「代码评审中心」。

### v0.1.2 — v0.1.2 — 包名迁移到 @jkin8010/dsh-code-review

_Released 2026-11-10_

## 变更

- 包 scope 从 `@qise/dsh-code-review` 迁移为 **`@jkin8010/dsh-code-review`**（根清单、bundle patch、client 模块 id、文档与配置示例统一更新）。
- 版本 0.1.2。
- 已在本机 desktop profile 完成迁移验证：依赖、`dsh.profile.bundles`、`cordis.patch.yml` 行名、安装后 manifest 与 `exports` 解析均指向新包名。

## 升级

- 从 Git URL 安装（推荐）：
  `plugin_manager → install_bundle → https://github.com/jkin8010/dsh-code-review`
- 已安装旧 `@qise/dsh-code-review` 的 profile：先移除旧包，再按上面安装；或手工把依赖/bundles/patch 行改为 `@jkin8010/dsh-code-review` 后重启 DSH。

### v0.2.1 — v0.2.1 — 提升暗色界面文字对比度

_Released 2026-11-10_

## 修复

用户反馈暗色主题下次级文字与背景对比过低（表单标签、提示、类型卡说明、placeholder、图例等看不清）。

- `--muted` #8b9bb4 → **#a7b5c9**（对面板底 #0d1420 对比度 6.5 → 8.9）
- `--faint` #5b6b83 → **#8494ac**（对比度 3.4 → 6.0，达到 WCAG AA 小字号要求）
- 表单标签 11px / #b7c4d6；hint、弹层副标题、类型卡说明、统计注释、侧栏标签统一提亮
- 输入框/搜索框 placeholder、代码行号、架构图节点副标题、进度条底色同步提亮
- 全部界面截图重新生成

升级：`install_bundle target: https://github.com/jkin8010/dsh-code-review`，然后刷新页面（客户端插件）即可看到新配色。

### v0.2.2 — v0.2.2 — 二次提升可读性 + 截图改用真实项目名

_Released 2026-11-10_

## 可读性

- 次级文字继续提亮：`--muted` → **#d3dded**、`--faint` → **#b3c2d6**（对面板底对比度 > 9:1）
- 全局小字号 **+1px**（9–12.5px 区间统一提升）：表单标签 12px/近白、提示 11.5px、表格/队列/动态同步放大
- 输入框、搜索框 placeholder、代码行号、架构图节点副标题一并提亮
- HUD 品牌与设置页「关于」新增 **插件版本 v0.2.2**，可据此确认页面是否加载了新版

## 截图

项目列表改为 [@jkin8010](https://github.com/jkin8010) 的公开仓库名称：
mopng-api、mopng-desktop、fastrtc-talking-more、image-matting、photocraft、design-agent-index、synapse-router、dsh-code-review；8 张截图全部重出。

升级：`install_bundle target: https://github.com/jkin8010/dsh-code-review`，然后**硬刷新页面**（Cmd+Shift+R）或重启 DSH；若设置页仍显示旧版本，说明页面加载的是缓存客户端。

### v0.2.3 — v0.2.3 — 项目配置自愈 + 文字近白高对比

_Released 2026-11-10_

## 修复项目列表异常（显示 desktop）

发现 desktop profile 的 `cordis.patch.yml` 中本插件配置被重写丢失，导致 `projectRoots` 为空、默认项目退化成 profile 目录。现在：

- 项目根/额外项目/默认项目默认值写入**插件自身** `cordis.patch.yml`，profile patch 再被重写也仍然正确
- 同时恢复 desktop profile 的 `qise-code-review` 配置（projectRoots、extraProjects、defaultProjectPath）

## 可读性

- 次级文字提升到近白：`--muted → #dde6f2`、`--faint → #c6d2e1`（对比度 > 12:1）
- hint / 说明 / 类型卡描述 / 统计注释统一 `font-weight: 500`，字号维持上一版放大后的规格
- HUD 与设置页版本标识更新为 **v0.2.3**，可直接确认加载的客户端版本

## 截图项目列表（按指定）

mopng-api、mopng-desktop、fastrtc-talking-more、image-matting、usee-art-canvas、synapse-registry、synapse-router、dsh-code-review

升级：`install_bundle target: https://github.com/jkin8010/dsh-code-review`，然后**重启 DSH**（配置/宿主需重新加载），页面加载后设置页应显示插件版本 v0.2.3。

### v0.2.4 — v0.2.4 — 修复评审类型卡片标题不可见

_Released 2026-11-10_

## 根因

DSH shell 的 `<button>` **不继承文字颜色**，而「评审类型」卡片标题直接放在 `<button class="cr-type-card">` 里且未显式设置 `color`，于是回退到浏览器 UA 的 `buttontext`（暗色下接近黑），在深色卡片上几乎不可见。

之前只提高对比度 token 的修复影响不到它；卡片里的 hint 行因为显式设了颜色所以一直可见——这正是“只有标题看不清”的原因。

## 修复

- `.cr-type-card` 显式 `color: var(--text)`（近白）
- 预览 harness 加入 `button { color:#101010 }` 的“敌意默认值”，并新增断言：`.cr-type-card` 计算颜色亮度必须 > 150，防止同类回归
- 版本标识更新为 v0.2.4，8 张截图重新生成

升级：`install_bundle target: https://github.com/jkin8010/dsh-code-review`，然后重启 DSH；HUD 与设置页应显示 v0.2.4。

### v0.3.1 — v0.3.1 — 添加项目支持文件夹选择 + 新建评审内添加

_Released 2026-11-10_

## 添加项目

- 添加项目弹层现在**同时支持**：
  - 手动输入绝对路径（回车即可提交）
  - **系统文件夹选择对话框**（调用 DSH native directory picker，取消则不改动输入）
- 入口：HUD 项目下拉「＋ 添加项目路径…」、项目页「添加项目」、**新建 Review 的项目下拉**

## 新建 Review

- 项目下拉最后一项「＋ 添加项目路径…」；选择后打开添加弹层，添加成功会自动回到新建流程并选中新项目
- 添加项目仍然持久化在 `~/.dsh/code-review/projects.json`

## 其他

- 预览 harness 新增断言：launch 下拉含添加入口、添加弹层含选择按钮、文件夹选择能回填路径；新增 `code-review-add-project.png`
- host-selftest 覆盖 `project.pick` RPC
- 版本 v0.3.1

升级：`install_bundle target: https://github.com/jkin8010/dsh-code-review`，然后重启 DSH。

### v0.3.2 — v0.3.2 — 内置文件夹浏览器（修复选择文件夹报错）

_Released 2026-11-10_

## 修复

在「添加项目 → 选择文件夹」时，DSH native directory picker 的 RPC 返回
`connection: invalid server-response failure`。改为插件**内置文件夹浏览器**，不依赖系统对话框，任何环境可用。

## 添加项目（v0.3.2）

- 手动输入绝对路径（回车提交）
- **浏览文件夹…**：内置目录浏览器
  - 工作区 / 主目录快捷入口
  - 列出子目录，点击进入
  - 上一级
  - 选择当前文件夹回填到输入框
- 入口不变：HUD 项目下拉「＋ 添加项目路径…」、项目页「添加项目」、新建 Review 的项目下拉
- 添加后持久化在 `~/.dsh/code-review/projects.json`

## 其他

- 新增 `project.browse` RPC（列目录/父目录/根目录），移除不可用的 `project.pick`
- harness 断言文件夹浏览器能列目录并回填路径，新增 add-project 截图
- host-selftest 覆盖 `project.browse`
- 版本 v0.3.2

升级：`install_bundle target: https://github.com/jkin8010/dsh-code-review`，然后重启 DSH。

### v0.3.3 — v0.3.3 — 修复错误回包掩盖真实原因

_Released 2026-11-10_

## 为什么文件夹浏览器仍报 `connection: invalid server-response failure`

这是**两层问题叠加**：

1. 我们的 RPC 失败回包缺少 `details` 字段，而 DSH client 要求失败时 `error.details` 必须是对象，
   缺失时就把真实错误统一替换成 `connection: invalid server-response failure`。
2. 你的页面已经加载了 v0.3.2 的新客户端（内置文件夹浏览器），但 **Host 仍是旧版本**，不认识
   `project.browse` 方法 → 返回错误 → 又被第 1 条掩盖。

## v0.3.3

- `rpcReply` 始终补全 `code/message/details`，真实错误会直接显示在弹层里
- 文件夹浏览器遇到“invalid server-response / 未知方法”会附带提示：**Host 可能仍是旧版本，请重启 DSH**
- host-selftest 断言失败信封字段完整
- 版本 v0.3.3

## 关于 input[type=file]

浏览器出于安全不提供所选文件夹的**绝对路径**（只有 webkitRelativePath），Electron 的 webUtils 也未暴露给插件客户端，
所以无法用 file input 得到可用路径。内置目录浏览器是跨环境可靠方案：列目录 / 上一级 / 选择当前文件夹，配合手动输入。

## 重要：必须重启 DSH

Host 侧方法（project.browse）只在重启后加载；仅刷新页面只会更新客户端。
重启后 HUD 应显示 V0.3.3；再点「浏览文件夹…」应能正常列目录。

升级：`install_bundle target: https://github.com/jkin8010/dsh-code-review`。

### v0.5.1 — v0.5.1 — 修复会话旧 Host 自动兜底

_Released 2026-11-10_

## 报错原因

`未知方法：fix.create` 说明页面已经加载了新版客户端（有按钮），但 **Host 插件仍是旧版本**
（安装后只刷新了页面、没有重启 DSH）。Host 不认识 v0.4.0 新增的 `fix.create` RPC。

## v0.5.1：按钮不再依赖 Host 重启

`fix.create` 失败时，客户端自动改用 **DSH 自带的 Client Remote 接口**兜底：

1. `remote.session.create({ cwd: 项目目录 })` 新建会话
2. `remote.session.prompt(...)` 发送同一份 findings 修复提示词
3. `uiWorkspace.openSession(sessionId)` 打开会话
4. 提示“插件 Host 版本较旧，重启 DSH 可启用完整模式”

因此装好 v0.5.1 后**刷新一次页面**，按钮即可用；重启 DSH 后则走 Host 完整模式
（与 `/code-review --fix` 一致）。

## 验证

- preview harness 模拟旧 Host（`fix.create` 返回“未知方法”），断言 fallback 成功并弹出提示
- host-selftest / engine / delegate / tool 全部通过
- 版本 v0.5.1

升级：`install_bundle target: https://github.com/jkin8010/dsh-code-review`，然后刷新页面。

### v0.5.2 — v0.5.2 — 版本可见 + 修复会话兜底加强

_Released 2026-11-10_

## 还是同一个报错的原因

`未知方法：fix.create` 说明**当前运行的 Host 仍是 v0.3.x 的插件代码**——页面里的按钮来自新客户端，
但 Host 端 RPC 还是旧的。仅刷新页面不会重载 Host。

## v0.5.2 改进

- Host 通过 `snapshot.config.hostVersion` 上报版本；设置页显示「客户端版本 / Host 版本」，
  不一致时提示：**完全退出并重新打开 DSH**（不是刷新页面）
- 修复会话兜底链加强：`remote.session.*` → Client `SessionManager.create/get().prompt`，
  Host 未重启时尽量仍能创建
- 兜底也不可用时，错误会带出客户端版本与重启指引，不再只有一句“未知方法”

## 现在请这样操作

1. 安装 v0.5.2（已完成）
2. **完全退出 DSH（Cmd+Q / 菜单 Quit）再重新打开** —— Host 侧代码只有在进程重启后才会更新
3. 打开后 HUD 应显示 `V0.5.2`；设置页「Host 版本」也应是 0.5.2
4. 再点「新建修复 Session」即可（也可用 `/code-review workflow --fix`）

如果重启后设置页 Host 版本仍是旧版（或显示“未上报”），说明 profile 里加载的还是旧包，
把设置页版本信息截图给我即可继续定位。

升级：`install_bundle target: https://github.com/jkin8010/dsh-code-review`。

