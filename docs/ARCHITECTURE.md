# dsh-thinking-guard · 功能模块与技术方案

> 供审批复核。每个模块写明**职责、采用方案、关键取舍、已知限制**。
> 版本：v0.1.14 · 代码规模：约 19000 行 / 41 个模块

---

## 0. 一句话定位

一个 DSH 插件，做两件互不相干的事：

1. **能力目录与按需调用**：把工具/技能编成目录，按 Resident / On-demand / Disabled 三档控制 Agent 能看到什么。
2. **思考限制（Guard）**：在有证据时对重复调用做提醒或局部拒绝，**不停止任务**。

DSH 宿主负责模型、Provider、完整会话；工具结果压缩由 Save Token 插件负责。本插件不碰这两块。

---

## 1. 模块总览

| 模块 | 文件 | 职责 |
|---|---|---|
| 能力索引 | `registry.ts` | 建立工具/技能目录，提供 `ctx.capability` |
| 策略 | `policy.ts` | 三档分层判定 + On-demand 隐藏 + 状态持久化 |
| 检索 | `search.ts` | `meta_search` 工具 |
| 调用 | `invoke.ts` | `meta_invoke` 工具，转发到目标能力 |
| 位置注册 | `locations.ts` / `patch-file.ts` | MCP 服务器与技能目录的增删改 |
| Guard 核心 | `guard.ts` / `guard-core.ts` / `guard-loop-core.ts` | 重复与循环检测 |
| 调用统计 | `usage/*.ts` | 从 `session/event` 采集调用记录 |
| 服务端网关 | `server/remote.ts` / `server/usage-remote.ts` | Typert Remote，供浏览器调用 |
| 客户端 | `client/*.tsx` | 设置页四个页面 |

---

## 2. 能力目录（registry.ts）

**方案**：从 `ctx.tools` 与 `ctx.skills` 读取已注册能力，建立内存索引。

- MCP 工具按 `mcp__<server>__<raw>` 前缀解析出 server。
- 原生工具归入保留的 `built-in` 伪服务器。
- 技能来自全局层与各 preset 的 standing scope。

**取舍**：不解析工具名去猜归属，只用注册信息。无法确认的归「未知来源」而非猜测。

**限制**：索引是内存态，重启后重建。

---

## 3. 三档策略（policy.ts）

**方案**：规则列表 + glob 匹配，判定每个能力属于 `resident` / `on-demand` / `disabled`。

- **Resident**：直接出现在模型工具列表里。
- **On-demand**：从模型声明中隐藏，只能经 `meta_search` → `meta_invoke` 触达。
- **Disabled**：在 `tools/pre-execute` 执行入口**硬拒绝**，不只是隐藏。

**On-demand 的实现方式（重要，改过一版）**：

DSH 0.2.2 起，`system-prompt/assemble` 不再拥有工具声明（provider 拥有，水位之后原样贴回）。因此旧的「在 assemble 里过滤 tools」已失效。

现方案：在 `agent/created` 时对**该 agent 作用域**施加 `tools.restrict({ deny })`。它同时作用于两条链路：

- `view(scope)` → `definitions()` / `schemas()`：模型声明里看不到
- `resolve()` → `ResolvedToolSet`：直接调用会被拒为 UNKNOWN_TOOL

**两个必须保留的坑**：

1. `applying` 重入守卫不能删。`restrict()` 与 `dispose()` 都 emit `tools/change`，无守卫会让外层刚装的 mask 被 dispose，**导致 Resident 工具被永久隐藏**。
2. `meta_invoke` 转发必须按**全局视图**查表，否则「On-demand 工具反而无法被调用」。

---

## 4. 检索与调用（search.ts / invoke.ts）

**`meta_search`**：在目录里按关键词/ID 查找，返回 id、kind、简述。
**`meta_invoke`**：按 id + kind 执行。工具走官方 `ToolExecutionPipeline`（`prepare → dispatch → complete`），技能则加载完整指令。

**取舍**：转发保留 `parent` 血缘（标记为 transport sub-dispatch），使事件归属与 PTC 折叠正确。On-demand 目标按全局视图解析，但**仅限本插件判定为 on-demand 的名字**，别人施加的 restrict 仍然生效。

**限制**：单次转发不经过所选 executor 的调度器（并发分类、`maxParallelToolCalls`），与批量 `execute` 语义不完全等价。

---

## 5. 思考限制 / Guard（guard.ts 等）

**方案**：纯函数检测器 + 有界状态，按 Agent/Turn 隔离。

三个独立开关（`agent/created` 之外实时读取，拨动即生效）：

| 开关 | 关闭后的行为 |
|---|---|
| `duplicateDetection` | 不再对重复调用提醒 |
| `alternatingCycleDetection` | 不再报告 A→B→A→B 循环 |
| `noProgressProtection` | 仍提醒，但不再局部拒绝 |

**检测依据**：只保留工具签名的 SHA-256 与结果/错误指纹，**不保存原始参数或结果内容**。阈值固定 3/5/8。

**硬边界**：Step 数、工具调用次数、任务时长**只统计，不停止任务**。拒绝仅针对「已证实重复的具体操作」，每个 Turn 对同一签名最多拒一次，总上限 16。

**持久化**：开关写入 `~/.dsh/capability-menu-policy.json`（version 3 的 `guard` 段）。**不写 patch 文件**——dsh 监视 patch 并在写入后重载插件。

---

## 6. 调用统计（usage/）

**方案**：订阅 DSH 公开的 `session/event` 事件流，实时聚合；启动时对历史 Session 做有界回补。

- 分类依据是**可信上下文**（MCP 映射、插件 owner、原生工具 id），不靠工具名前缀猜。
- 归属不明时如实标为「未知来源」，不猜测。

**当前限制（重要）**：

- 统计是 **memory 模式**，不落盘、不跨重启恢复。
- 覆盖状态采用「**最差状态胜出**」：一个会话读不出来整页就是 `unknown`；无任何 coverage 数据也是 `unknown`（「没有报告」≠「没有缺失」）。
- 因此当前显示「覆盖未知：…0 不代表未使用」是**正确的诚实表述**，不应改成更好看的文案。

---

## 7. 设置页（client/）

四个页面，顺序固定：**总览 → 思考限制 → 能力目录 → 调用统计**。

| 页面 | 数据来源 |
|---|---|
| 总览 | `getGuard()` + usage 快照 + `classifyAll()` 分层统计 |
| 思考限制 | `getGuard()` / `updateGuard()`，三段说明 + 开关 |
| 能力目录 | `classifyAll()`，按来源分组、搜索、折叠 |
| 调用统计 | usage Remote 快照 |

**组件策略**：基础控件用官方 `@deepseek-ai/dsh-client-ui-primitives`（SegmentedTabs / Button / Tag / Pill / Input / Modal / Toast）；官方无 Card、表格、Alert、进度条，这些自建。

**刻意保留自建**：`mc-dot` 三态字形（常驻实心 / 按需半填充 / 禁用斜线）。它编码的是策略层级形状，与 `StateDot` 的生命周期语义不是一套。

---

## 8. 宿主集成（host-face.ts / server/*）

**方案**：通过 Typert 注册 host face，把服务端方法暴露为 `/api/<namespace>/<method>`。

**关键**：同一 package 的多个 face **必须合并成一次 `register()`**。分两次注册会让第二次撤销第一次的 strict definition，表现为 `gateway/definition-unavailable`。这是实际踩过的生产故障。

---

## 9. 安装与发布

**安装**：`dsh plugin add <带哈希的 Release 附件 URL>`。

**为什么必须用 `dsh plugin add`**：它会在 pnpm 之后多做一步 bundle 协调，把带 `dsh.bundle.patch` 的新依赖自动写进 `dsh.profile.bundles`。**裸 `pnpm install` 不会**，结果是包装上了但不挂载。

**为什么附件名带哈希**：pnpm 按 URL + integrity 缓存，同名覆盖附件后不会重新下载。

**各来源实测**：Release 附件 ✅ / 本地 tgz ✅ / git 形式 ❌（`lib/` 未入库，pnpm 拦截 prepare 构建）/ 裸包名 ❌（未发布 npm）。

---

## 10. 已知限制汇总

1. 调用统计不落盘，重启清零；覆盖状态在多数情况下会是 `unknown`。
2. `meta_invoke` 单次转发不经过 executor 调度器。
3. Guard 开关的「每个 Turn 对同一签名拒一次」是近似语义，不是严格的全局限流。
4. 未在 macOS / Linux 验证。
5. `dsh plugin` CLI 的**退出码恒为 0**，脚本化必须解析输出文本判断成败。
