# dsh-code-review Delivery Notes

English | [简体中文](CODE-REVIEW-DELIVERY.zh.md)

> Plugin package: `plugins/dsh-code-review` (`@jkin8010/dsh-code-review` v0.6.1)
> Dependencies: `ocr` (`@alibaba-group/open-code-review`) v1.13.6, `git`, Node 22+
> Already installed on this machine into the desktop profile; **takes effect after restarting DSH** (see the end of this document).

## 1. What was built

A full-page DSH plugin, "Code Review Center": a sidebar entry + five tabs (Overview / Reviews / Projects / Architecture / Flow)
that merges open-code-review's AI review, local structural analysis, review history and Git heatmaps into one operable, traceable review workbench.

Supported reviews:

| Type | Engine | Notes |
|---|---|---|
| Current changes `workspace` | `ocr review` | staged + unstaged + untracked |
| Single commit `commit` | `ocr review --commit` | compared against the parent |
| Branch comparison `range` | `ocr review --from --to` | merge-base semantics |
| Project architecture `architecture` | local module graph + `ocr scan` | dependencies/cycles/layering/god modules/missing tests |
| Code module `module` | local metrics + `ocr scan --path` | specified directory/files |
| Information flow `flow` | local chain extraction + `ocr scan` | entry→service→data/external dependencies |

Three engines, chosen in order under `auto`:

1. `ocr`: OCR's own LLM (`OCR_LLM_*` / `~/.opencodereview/config.json` / `ANTHROPIC_*`, or the plugin config/token file).
2. `delegate`: **delegation mode**. OCR handles file selection and rule resolution; the review is performed by the DSH current-session model
   (`ctx.llm.stream` + `agentDefaultModel.currentSelection()`), with no extra API key required.
3. `structural`: offline structural analysis (architecture/module/information-flow/diff heuristics), zero LLM dependency.

When model review fails or is not configured, it degrades to `structural` automatically and says so in the review summary; it never fabricates AI conclusions.

## 2. Interface

- **Overview**: 6 metric cards; GitHub-style 53 weeks × 7 days heatmap (three metrics: commits/reviews/findings; hover for the day's commits, insertions and deletions, reviews, findings, streak/busiest day/active days); live review queue (stage progress, current stage, elapsed time, recent activity); recent reviews; recent projects (mini heatmap); hot modules; cross-review activity timeline.
- **Reviews**: all tasks list, status/type/project filters + search; inline expand of recent activity; click through to details.
- **Details**: stage timeline (resolve→file selection/structure→AI→merge→report); summary, coverage, finding distribution, files touched; findings grouped by severity, with file:line, category, original/suggested code side by side, copy suggestion; re-run/cancel/delete/copy Markdown.
- **Fixed markers**: each finding can be "Mark fixed / Undo", with All / Unfixed / Fixed filters; the header and the list show the fixed count, cards are highlighted in green, and the Markdown export carries the fixed state; when a new review of the same project/type/scope no longer reports old problems, the old report is automatically marked fixed.
- **One-click fix session**: the details page calls the Host `sessionController` to create a new session in the project Workspace and send the findings fix prompt, with `--fix` support; when the Host is older, the client falls back to Remote.
- **Projects**: project cards (branch/HEAD/dirty/language/modules/LOC/mini heatmap/last review); repository info; module detail table.
- **Architecture**: module dependency ring graph (size = LOC, color = risk, red dashed = circular dependency), node tooltips, click to filter; architecture metrics; module table; related findings.
- **Flow**: entry→service→data/external four-column chain diagram; click a node to see related files and findings; chain overview; flow list; related findings.
- **New Review**: project (the dropdown includes "＋ Add project path…"), 6 review types, scope (commit/from-to/module paths), effort, engine, exclude, token budget, background note; queued immediately after submitting.
- **Any project**: a project can be added from the project dropdown, the projects page or New Review; built-in folder browser (list directory/up one level/select the current folder) + manual absolute path entry; project sources are automatically merged from the projectRoots scan, the DSH workspace and already-reviewed projects.
- **Settings drawer**: OCR version/path, LLM tri-state (OCR configured / DSH delegate / unconfigured) and how to configure it, test LLM, project roots/extra projects, state directory, polling, heatmap range, snapshot version.

Visual: dark code intelligence console, primary teal `#35e0c8`, severity colors critical/high/medium/low, monospaced code, restrained motion.

## 3. Architecture

```
plugins/dsh-code-review/
  index.js          composition root: config, service references, store/jobs/snapshot wiring, tool/command/RPC registration
  client.js         Web full-page UI (window.__ModuleLoader__ + React.createElement, no build step)
  host/
    rpc.js          /api/code-review method dispatch, wire validation, failure envelope, route mounting
    engine-plan.js  engine selection (ocr / delegate / structural)
    service-refs.js per-apply references for sessionController / workspaceRegistry
    lifecycle.js    startup, timers, teardown (waits for init, then stops services and flushes)
    fix.js          fix session creation and prompt (shared by fix.create and --fix)
    commands.js     /code-review slash command parsing and execution
    tool.js         in-conversation code_review tool
    config.js       Config normalization, ocr probing, OCR_LLM_* injection
    shared.js       Finding normalization, date/statistics helpers
    files.js        Source traversal / safe reads (256KB cap)
    store.js        Review history: index.json + jobs/<id>.json + stats.json + activity.json, atomic writes
    git.js          Project discovery, git metadata, one-year heatmap (a single git log --numstat), module tree
    ocr.js          ocr CLI: probe/probeLlm/preview/runReview/llmTest, progress parsing, timeout/cancel, artifacts
    analyze.js      Four offline analyses: architecture (Tarjan cycles/multi-language imports/layering), module, information flow, diff
    llm-review.js   Delegation mode: OCR file selection + DSH model review + strict JSON parsing
    prompts.js      Review background / rule / title
    jobs.js         6-stage state machine, dual-engine merge, dedupe, statistics, cancel/retry/persistence
    snapshot.js     Snapshot: project/heatmap/statistics/health/activity (with TTL cache)
  locale/           meta strings
```

- The RPC envelope matches DSH's admin routes: `POST /api/code-review`, `{type:'client-request',...}` → `{type:'server-response', result:{ok,value|error}}`; the failure envelope always carries `code/message/details`.
- The slash command `/code-review` (workflow/architecture/module/changes/commit/range/fix/list/status) and the model tool `code_review` reuse the same jobs/snapshot/fix services.
- The frontend polls the snapshot every 2s; the Host caches projects for 5min, the current project's heatmap for 1min, and OCR health for 1min, so polling does not re-hit git/ocr.
- Review state is persisted under `~/.dsh/code-review/`; on Host restart, leftover running jobs are automatically marked as interrupted.
- Cancellation: SIGTERM → 2s → SIGKILL; retry creates a new job.

## 4. Verification

| Suite | Command | Result |
|---|---|---|
| Engine state machine / four review types / snapshot / persistence | `node tests/code-review/engine-selftest.mjs` | ✅ |
| Delegation mode (OCR file selection + DSH model) | `node tests/code-review/delegate-selftest.mjs` | ✅ |
| In-conversation tool `code_review` (start/status/detail/list) | `node tests/code-review/tool-selftest.mjs` | ✅ |
| One-click fix session (fix.create + sessionController mock) | `node tests/code-review/host-selftest.mjs` | ✅ |
| Slash command `/code-review` (@project add / review types / --fix / list / status) | `node tests/code-review/host-selftest.mjs` | ✅ |
| Fixed markers: manual marking + automatic reconcile | `node tests/code-review/host-selftest.mjs` | ✅ |
| Fixed-state UI (badge + filter) | `node tests/code-review/preview/shoot.mjs` | ✅ |
| Full Host RPC chain (real git/ocr/analyze + fake Cordis) | `node tests/code-review/host-selftest.mjs` | ✅ |
| git/heatmap/OCR adapter (real repo + real ocr preview) | `node tests/code-review/git-ocr.test.mjs` | ✅ 33/33 |
| Architecture/module/information-flow/diff analysis | `node tests/code-review/analyze.test.mjs` | ✅ 8/8 |
| Real client.js render + screenshots + DOM assertions | `node tests/code-review/preview/shoot.mjs` | ✅ |

Screenshots: `docs/screenshots/code-review-{overview,reviews,detail,fixed,launch,projects,architecture,flow,settings,add-project}.png` (including fixed markers).

## 5. In-conversation usage

After installing/restarting, the plugin registers the model tool `code_review`, so in any project conversation you can have the agent start a review directly and return findings in the conversation:

- "Use the Code Review Center to review the current project's architecture"
- "review the current changes, only high and above"
- "review the host module" / "review the message chain from an information-flow perspective"
- "show the details of the latest review"

`action=status/detail/list` queries progress and history, and `wait:false` runs in the background. The full UI is still available from the "Code Review Center" sidebar entry.

## 6. Known limitations

- When OCR's LLM is not configured, only structural analysis or delegation mode is available; OCR's `ocr review` needs a real API key.
- Offline analysis is heuristic (regex/bracket matching, not AST); for dynamic languages or complex DI it only links one level of the call chain, so it may miss or over-report; the rules have been tuned conservatively.
- The information-flow graph is capped at 40 nodes; beyond that it is truncated by priority entry>service>data.
- Non-Git directories support architecture/module/information-flow reviews; current-changes/commit/branch reviews require a Git repository.
- The heatmap window is `today-(days-1)`; across time zones the author date and the `--since` boundary may differ by 1 day (already filtered to the window).
- `language` only recognizes the built-in extension table; full inspect is capped at 4000 files, and LOC skips binary files and files >2MB.

## 7. Installation state and local enablement

Completed on this machine for the desktop profile:

- `~/.dsh/profiles/desktop/package.json`: new dependency
  `"@jkin8010/dsh-code-review": "link:/Users/jkin/workspace/jkin8010/dhs-feishu-plugin"`
  (the repository root `package.json` is the bundle manifest, exports point to `plugins/dsh-code-review/`)
  and `@jkin8010/dsh-code-review` as the last entry of `dsh.profile.bundles`;
- `~/.dsh/profiles/desktop/node_modules/@jkin8010/dsh-code-review` is linked;
- `~/.dsh/profiles/desktop/cordis.patch.yml` has the plugin config appended (projectRoots, extraProjects, ocr options).

`plugin_manager` returned `restart-required` (package-moved), so you need to **restart DSH** for the Host row to mount,
then refresh the page and the "Code Review Center" appears in the sidebar.

After enabling, it is worth checking:

1. Settings drawer: the OCR version should be `v1.13.6`; LLM state should be `delegate` (no OCR key on this machine) or `configured`.
2. Overview should show project cards and the heatmap; click "New Review" and run a "code module" review (pick `dsh-code-review/host`),
   then watch the live queue, stage progress and the findings on the details page.
3. If you want OCR's native AI review: configure it with `ocr config provider`, then "Test LLM" on the settings page should pass and the engine switches to `ocr` automatically.

### Installing from a Git URL

The repository root `package.json` declares `dsh.bundle`, so `plugin_manager` can install it directly:
`install_bundle target: https://github.com/jkin8010/dsh-code-review` (or the root of a local clone).
