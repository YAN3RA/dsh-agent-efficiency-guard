# HANDOFF

更新：2026-11-06 01:55。仓库：`YAN3RA/dsh-agent-efficiency-guard`；分支：`main`。
本轮基于 **DSH v0.2.2-rc.1** 做兼容适配，并重做了设置页 UI 预览稿。

## 当前状态（一句话）

源码已完成 0.2.2-rc.1 兼容修复，`typecheck`（Node + Client）+ 542 项测试 + `build` + `pack` 四项全过；**未提交、未发布**。UI 预览稿 v2 已重做并通过 47 项浏览器断言，**尚未接线到 `src/`**。

## 一、DSH v0.2.2-rc.1 兼容（本轮完成）

### 1.1 已确认的宿主版本

| 项 | 值 |
| --- | --- |
| `dsh` CLI | `0.2.2-rc.1` |
| 安装路径 | `C:\Users\yansui\AppData\Local\Programs\DeepSeek Harness`（目录名是空格，**不是**连字符） |
| 运行时 node / pnpm | `24.21.0` / `11.28.5`（在 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/`） |
| Cordis | `4.1.0` |

**注意路径陷阱：** `LOCALAPPDATA\Programs` 下该目录名是 `DeepSeek Harness`（空格）。用 `DeepSeek-Harness` 会 ENOENT，但 `Get-ChildItem` 列目录时 PowerShell 会把它显示成连字符形式，容易误判。用 `[System.IO.Directory]::GetDirectories()` 或 `-LiteralPath` 核对真实字符。

### 1.2 依赖升级

`package.json` 的 devDependencies 从 `0.2.1-rc.3` 全部升到 `0.2.2-rc.1`，`@deepseek-ai/cordis` 升 `4.1.0`；peerDependencies 增加 `|| ^0.2.2-rc.1`；`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 同步改版本。

### 1.3 两个真实破坏点（升级后编译即失败，非推测）

**A. `ToolsService.execute` 改为批量契约。**
`ToolBatchInput` 为 `{ calls, signal, maxParallelToolCalls?, agent?, toolSet?, log? }`，**没有 `parent` 字段**；返回 `ToolBatchResult = { results, additionalContexts, concluded }`。
本插件单次转发改用官方 `ToolExecutionPipeline`（`@deepseek-ai/dsh-tools/pipeline`）的 `prepare → dispatch → complete` 三步，`ToolExecutionInput` 仍接受 `parent`，transport sub-dispatch 血缘得以保留。

**B. `system-prompt/assemble` 不再拥有工具声明。**
事件参数变为 `PromptPresentation = { sections, contexts, variables }`；`SystemPrompt.assemble()` 在跑完 waterfall 后用 `{ ...transformed, tools }` 把 **provider 拥有的** tools 原样贴回。所以旧代码里过滤 `assembly.tools` 已是死代码。
`projectAssemblyTools` → `projectAssemblySections`，只保留 sections 投影（`tool:web_search` / `tool:web_fetch` 指引）。

### 1.4 On-demand 隐藏改走 `tools.restrict()`（关键，别退回提示词降级）

第一版修复曾判断「0.2.2 下第三方插件无法隐藏他人工具」，**该结论是错的**。核实后的正确机制：

- `restrict(filter)` 读 `scopeOf(this.ctx)`，与 `register()` 用**同一机制**；Cordis 在 traced service 调用时把 `this.ctx` 重绑定到调用点。
- 因此经 `agent.ctx.tools.restrict({ deny })` 施加的限制，绑定到该 agent 的作用域。
- 该限制同时作用于两条链路：`view(scope)` 的 `admits()` 过滤 → `definitions()`/`schemas()`（**模型声明**）；以及 `resolve()` 构建的 `ResolvedToolSet`（**执行准入**）。
- 在 bundle 级 `ctx` 上调用会抛 `requires a scoped context (agent.ctx)`——所以必须在 `agent/created` 里做。

实现要点（`src/policy.ts`）：

| 位置 | 作用 |
| --- | --- |
| `policy.ts:742` | `onDemandRestrictions`：每 agent 的 disposer + deny 快照 |
| `policy.ts:765` | `onDemandDenyNames()`：从**全局视图**取交集，过滤 meta 工具与保留名 `run_code` |
| `policy.ts:788` | `applying` 重入守卫 |
| `policy.ts:820` | `reapplyOnDemandRestrictions()` |
| `policy.ts:828/833/845` | `agent/created` / `agent/disposed` / `tools/change` 接线 |

**两个必须保留的坑（改这块前先读）：**

1. **重入守卫不能删。** `restrict()` 和 `dispose()` 都会 emit `tools/change`，会重入施加逻辑。没有 `applying` 守卫时，嵌套那趟会把外层刚装的 mask dispose 掉并留下相交 mask，结果是 **Resident 工具被永久隐藏**。
2. **`meta_invoke` 转发必须按全局视图查表。** `tools.get(name, agent)` 走 `view(agent)`，被自己施加的限制挡掉后会返回 `undefined`，导致「On-demand 工具反而无法 meta_invoke」的致命回归。`src/invoke.ts:105` 的 `resolveForwardDefinition()` 先查调用方视图，**仅当本插件分类为 on-demand** 时回退全局定义；别人的 restrict 仍然生效。

### 1.5 本轮验证（2026-11-06 01:47 亲自复跑，非转述）

- `tsc -p tsconfig.json --noEmit` → EXIT=0
- `tsc -p tsconfig.client.json --noEmit` → EXIT=0
- `vitest run` → **31 个测试文件 / 542 项全部通过**
- `pnpm build` → ✔ Build complete in 4224ms
- `npm pack --dry-run` → 111 files，`lib/` 已更新

详细证据与未验证项见 `docs/release-0.2.2/compat-impact.md`（四节 + 行号已逐条核对）。

### 1.6 本轮**未**做的事

- **未 commit / 未 push。** 工作区有 5 个修改文件 + 1 个新增 stub + 1 份新报告。
- **未重启 Host**，所以 `lib/` 的新代码尚未在运行态生效。profile 是 `link:`，重启后直接生效。
- 未在真实 Host 验证：`resume`/preset 作用域下 `agent/created` 时序、PTC(`run_code`) 组合、并发多个 `meta_invoke`、与第三方插件 restrict 叠加、0.2.1-rc.3 回退路径。

## 二、设置页 UI 预览 v2（本轮完成，未接线）

按 `docs/design/preview/dsh-agent-efficiency-guard-UI优化方案.md` 重做 `docs/design/preview/index.html`：单页四标签（总览 / 防循环 / 调用统计 / 能力目录），整页可交互。

- 所有 KPI、分类汇总、排行、合计行由**同一份数据源**实时计算，不再是手写常量；排行底部有「口径一致校验」行。
- 预览工具条可切「数据状态」（正常 / 暂无调用 / 覆盖不足 / 读取失败），四种状态分别展示。
- 47 项浏览器断言全通过，含：数字自洽、默认 7 天周期、无统计范围选择器、排行数字窄屏不隐藏、KPI 与建议数量差异有解释、折叠报数、深色主题 token 生效。
- 说明文档：`docs/design/preview/README-preview-v2.md`。

**`build.py` / `build_html.py` 是 v1 遗留生成器**，会覆盖手写的 `index.html`。已加 `--force` 保护，不带参数运行会拒绝并提示。

## 三、下一轮可执行项

1. **重启 Host 做生产验证** — 打开 设置 → 插件，确认四类行为：能力目录能列出 On-demand 工具、`meta_invoke` 能转发 On-demand 工具、Disabled 仍硬拒、Guard 提醒正常。成本 5 分钟。这是本轮唯一未闭环的验收项，建议先做。
2. **确认 UI 预览稿** — 打开 `docs/design/preview/index.html` 审阅，确认后再决定是否接线到 `plugin/src/client/`。成本 10 分钟。
3. **提交与发布 v0.1.10** — commit → `npm version 0.1.10` → 四项验证 → `npm pack` → 传 Release 附件 → 建 tag 与 Release。成本 15 分钟。依赖第 1 项。
4. **改回安装来源** — 发布后把 profile 依赖从 `link:` 换回 Release 附件 URL。成本 3 分钟。依赖第 3 项。
5. **清理临时残留** — `.tmp-ui/`（asar 版本提取脚本、release notes）、`%TEMP%\css-prune-backup`、`%TEMP%\tgz-trash-latest`、`docs/design/preview/.cdp-profile*`。成本 1 分钟，破坏性操作，删除前确认。

## 四、安装来源选择（沿用上轮结论）

| 方案 | 结果 |
| --- | --- |
| `git+https://…#vX.Y.Z` | **不适用**：仓库不含 `lib/`，会触发 pnpm `prepare` 本地构建并被拦截。 |
| Release 附件 URL | **推荐用于发布**：`.../releases/download/v<版本>/dsh-agent-efficiency-guard-<版本>.tgz`，纯下载、无需 allowlist。 |
| `link:` 指向仓库 | **仅本机开发**：改动即时生效；代价是未提交改动直接进生产运行态。 |

## 五、工作区与安全边界

- 默认不触碰 `~/.dsh/profiles/desktop`；本轮未改 profile。
- 不提交 `node_modules/`、`lib/`、临时 `.tgz`、测试缓存、本机 profile、Session、凭据或原始日志。
- 推送前先 `git ls-remote origin refs/heads/main` 比对远端 SHA——**超时不等于失败**，本轮上次会话已实测过。优先用 `git -c http.proxy=http://127.0.0.1:7890 push`。
