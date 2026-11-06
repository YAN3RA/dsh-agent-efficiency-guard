# dsh-agent-efficiency-guard vNext 整体改造实施任务书

> **用途：** 交给独立开发 Agent 执行的改造说明。本文以用户提供的《dsh-agent-efficiency-guard 当前实施方案与状态》为当前项目基线，并补充本轮确定的产品需求与 DSH 官方 GitHub 资料核对结果。
>
> **目标：** 保留现有能力目录、`meta_search` / `meta_invoke` 与策略管理，重做效率守卫，新增跨会话调用统计子页面，形成一个轻量、节省 Token、可解释、不会因正常任务太长而提前中止的 DSH 插件。
>
> **插件包：** `dsh-agent-efficiency-guard`  
> **内部名称：** `agent-efficiency-guard`  
> **文档版本：** vNext 改造任务书  
> **编写日期：** 2026-11-03

---

## 0. 给开发 Agent 的总要求

### 0.1 先审计，不要推倒重做

当前会话工作目录本身不是 Git 仓库；插件独立 Git 仓库位于 `plugin/`。N5 实时检查：`plugin` 的 `main` 比 `origin/main` 超前 1 个提交；已有未提交修改涉及 `AGENTS.md`、`HANDOFF.md`、`README.md`、`cordis.patch.yml`、`docs/host-pi-desktop-integration.md`、`package.json`、`src/client/index.ts`、`src/guard-core.ts`、`src/guard.ts`、`tests/guard-core.spec.ts`。这些均为既有改动，禁止覆盖或清理；开发前先读目标文件并基于当前内容修改。


开工时必须先检查：

1. 当前仓库分支、未提交改动、源码、测试和 `plugin/HANDOFF.md`。
2. 实际安装的 DSH 版本、公开 API 类型定义、目标 profile 的插件加载情况。
3. 当前插件的配置 schema、`cordis.patch.yml`、客户端页面注册方式、状态存储方式。
4. DSH 官方 `repeat-tool-reminder` 是否已在目标 profile 启用，避免与本插件重复提醒。N4 已跳过，当前状态未知；在有明确 profile 证据前不得声称两者不会重复，也不得把生产启用状态作为已验收项。
5. 当前能力目录中 Tool / MCP Tool / Skill 的真实来源元数据是否足以做统计归类。

当前版本证据：`plugin/package.json` 的开发依赖锁在 DSH `0.2.1-rc.3`；`plugin/HANDOFF.md` 记录本机 DSH CLI `0.2.1-rc.5`。N5 只读核对了两版 NPM 发布类型：Session Persistence 的只读分页 `SessionHandle.read(offset,length)`、Session Controller 的 `page/follow`，以及 UI Manager 的 `plugins.bundle.config` 在 rc.3/rc.5 类型中均存在。未读取受路径保护的本机安装类型、未检查 profile 实际组合，也未进行 Host 运行态验证（N4 已跳过）；不得将发布类型存在等同生产已加载。保持现有 peer 范围不变，统计服务必须运行时探测，缺失时退化实时采集并显示覆盖缺口。


### 0.2 当前项目基线（来自用户提供的实施现状）

截至用户文档记录：

- 包版本仍为 `0.1.8`；GitHub `v0.1.8` 是已发布基线，本地工作树存在未提交改动，不能把远端 tag 当成本地最新实现。
- 已实现能力目录、`meta_search` / `meta_invoke`、Resident / On-demand / Disabled、能力菜单和 Agent / Turn Guard。
- 默认 `stepLimitMode: warn-only`；但工具数与时长仍然可能硬停止，`hardSteps` 仍可通过 `hard-stop` 启用。
- 已有重复调用检测、无进展保护、工具并发额度预占。
- Guard 专属配置页、实时统计页、历史趋势未完成。
- `meta_invoke` 内层目标计数、取消/异常后 pending 释放、生产 GUI 热重载及完整运行态验证尚未完成。
- 本地曾记录类型检查、206 项测试、构建和 `npm pack --dry-run` 通过；这不等于生产 DSH profile 已完整验收。

这些是改造起点，不是本轮验收结果。开发 Agent 必须重新执行检查并记录最新证据。

### 0.3 本轮产品决策

**必须坚持以下方向：**

- 正常任务不因模型步骤多、工具调用多、执行时间长而被插件停止。
- 插件主要识别重复、循环、无进展，发现问题时先提醒，只有明确重复的无效动作才局部阻止。
- 新增调用统计子页面，按当前公开 API 可观察范围统计当前会话、当前 Workspace 可确认映射、全部可访问 Session 的 MCP、部分 Skill 入口、owner 可验证的 Plugin Tool；其余来源显示 Unknown 与覆盖缺口。
- 提供最近 7 天、15 天、30 天统计。只有完整连续统计覆盖且能力 30 天内持续可用/启用可证明时，才对可选能力显示“建议禁用”；来源未知、采集有缺口或可用状态不明时显示数据不足。
- “建议禁用”只是建议，不允许未经用户确认就自动禁用、卸载插件或断开 MCP。
- 继续只交付一个独立插件包，不再拆分 Guard 与 Capability Menu。

---

## 1. 产品定位和职责边界

### 1.1 最终产品定位

把产品从单纯的“预算限制工具”调整为：

**Agent 效率管理 = 智能防循环 + 调用统计 + 能力按需管理。**

它要解决三个问题：

1. Agent 有没有陷入重复调用或无进展循环？
2. 哪些 MCP、Skills、插件工具真正被使用，哪些长期闲置？
3. 能否通过减少常驻工具、整理低频能力，减少无意义的上下文和模型调用？

### 1.2 继续由其他插件负责的事情

| 组件 | 继续负责 | 本插件不得重复实现 |
|---|---|---|
| `dsh-plugin-save-token` | 工具输出压缩、原文保存与恢复 | TOON、输出压缩、历史消息压缩 |
| `dsh-mcp-connector` | MCP 连接、认证、Server 生命周期、Session 模式激活 | MCP OAuth、凭据、连接进程、擅自激活工具 |
| `dsh-context` | 上下文诊断 | 完整上下文窗口仪表盘 |
| `dsh-cost-meter` | 真实 Token 和费用统计 | 假造 Token 数或费用估算 |
| `dsh-mnemon` | 记忆存储与召回 | 另一套记忆系统 |
| DSH 核心 | Agent Loop、模型 Provider、权限和审批 | 修改 DSH 核心或绕过原执行管线 |

### 1.3 “插件调用”的统计口径

DSH 插件包本身不是一个可直接调用的 Capability；插件注册的 Tools 与 Skills 才是能力目录中的项目。因此统计页面必须把“插件调用”解释为：

**由某个 DSH 插件包提供的工具被实际调用的次数。**

不能把插件启动次数、插件安装次数或插件启用次数混称为“插件调用”。

统计分类采用互斥分类，避免同一次调用在多个分类中重复累计：

1. `MCP`：由 MCP Server 提供的 Tool，按 Server、Tool 分组。
2. `Skill`：实际加载/调用的 Skill，按 Skill 名称和来源分组。
3. `Plugin Tool`：非 MCP、由其他 DSH 插件包注册的 Tool，按插件包和工具名分组。
4. `Native / Other`：DSH 原生工具或无法可靠归类的工具，可作为辅助分类展示，不纳入 MCP / Skill / Plugin 三类重复统计。

分类优先级：**MCP > Skill > Plugin Tool > Native / Unknown**。MCP Connector 即使由一个插件包提供，也仍归到 MCP 分类，不重复计入 Plugin Tool。

---

## 2. P0：重做 Agent Efficiency Guard

### 2.1 彻底取消普通任务的硬预算停止

当前最影响体验的问题是：工具调用达到阈值或任务时长达到阈值后，Guard 会把后续步骤/工具拒绝。复杂任务可能因此没有完成。

新版本将计数与限制分离：

| 项目            | 新行为         | 是否允许因此停止任务    |
| ------------- | ----------- | ------------- |
| 模型 Step       | 统计总数、用于诊断   | 否             |
| Tool Call     | 统计总数、用于诊断   | 否             |
| Turn Duration | 统计实际耗时、用于诊断 | 否             |
| 相同调用重复        | 参与循环判断      | 仅可阻止确认无效的同一调用 |
| 交替调用循环        | 参与循环判断      | 仅可阻止确认无效的循环动作 |
| 无进展           | 参与循环判断      | 先提醒，确认后局部干预   |

明确要求：

- `hardToolCalls` 不再作为普通任务的硬停止条件。
- `hardDurationMs` 不再作为普通任务的硬停止条件。
- `hardSteps` 不再允许通过 `hard-stop` 对普通任务执行硬停止。
- `stepLimitMode` 迁移为兼容字段；旧配置即使写着 `hard-stop`，新版本也必须以非阻断方式运行，并在日志/设置页提示该字段已弃用。
- 不要用“允许一次最终总结”掩盖前面仍然存在的工具数/时长硬停止；应直接移除这两类总闸门。
- 统计数据仍保留，但 UI 不显示“剩余次数”“额度已用尽”等会误导用户的进度条。

如 DSH 本身或其他独立插件另有超时/模型限制，不能声称本插件取消了它们；设置页需区分“本插件不限制”和“宿主/其他插件可能有自己的限制”。

### 2.2 第一层：完全相同的工具调用检测

借鉴 DSH 官方 `@deepseek-ai/dsh-repeat-tool-reminder` 的思路，不要重复安装或复制一份独立提醒器。

官方实现的可借鉴点：

- 用 `(tool name, canonical arguments)` 作为调用指纹。
- 对 JSON 参数做深度键排序，忽略对象属性顺序。
- 每个 Agent 独立追踪。
- 不跟踪的工具不增加也不清空重复链。
- 用户真正发起的新指令后重置重复链。
- 在工具调用后附加提醒上下文，不替换原始工具结果。
- 默认建议式提醒，不因一次合理重复就拦截。

建议默认策略：

| 次数 | 行为 |
|---|---|
| 第 3 次连续相同调用 | 简短提醒：先分析上一次结果，不要盲目重复 |
| 第 5 次 | 明确提醒：改变工具、参数或解决方法 |
| 第 8 次 | 若仍是同一动作且结果无变化，进入局部循环保护 |

这里是同一工具 + 同一规范化参数的连续重复次数，不是本轮总工具调用次数。

### 2.3 第二层：交替调用循环检测

增加对 A → B → A → B、A → B → C → A → B → C 等重复序列的识别。

示例：

```text
read(file-A)
edit(file-A)
read(file-A)
edit(file-A)
read(file-A)
edit(file-A)
```

即使每次工具调用的参数略有差异，也可能在行为序列上形成重复循环。

第一版使用确定性规则，不要引入额外 LLM 调用：

- 保留最近 12～20 次已完成业务调用的轻量记录。
- 每条记录只保留工具 ID、规范化参数 Hash、结果指纹、结果状态、时间和必要的父子调用 ID。
- 检查最近窗口是否出现至少两轮相同序列；优先识别精确序列，近似匹配只作为低置信提示。
- 排除 `meta_search`、`meta_invoke` 外层控制调用、统计内部工具和明确排除的低价值记录工具。
- 并行工具必须按真实 dispatch / callId 关联，不能仅按事件到达顺序误判成循环。

交替序列检测第一阶段只提醒，不要仅凭序列相似就硬拦截。必须结合结果无变化或重复错误等证据升级。

### 2.4 第三层：结果无变化与无进展检测

增加轻量级结果指纹：

- 工具返回成功/失败状态。
- 规范化后结果的短 Hash。
- 是否发生可观察的文件变更/状态变化（仅在公开事件或工具元数据提供时使用）。
- 连续相同错误代码/错误摘要的计数。

判断原则：

- 不能简单把“读取到相同内容”当作无进展，因为只读检查本来就可能合理重复。
- 不要保存完整工具输出，只保存哈希、状态和必要的短错误分类。
- “序列重复 + 结果无变化/相同错误”比单纯“调用次数多”更有说服力。
- 对轮询、状态查询、等待任务完成等工具提供 exclude / 低敏感策略，避免误伤合法轮询。

### 2.5 循环处置的升级规则

| 情况 | Guard 行为 |
|---|---|
| 正常任务，调用多但结果持续变化 | 不干预 |
| 相同工具/参数达到第一次阈值 | 注入一次短提醒 |
| 重复仍持续 | 注入具体提醒，要求检查结果并换方法 |
| 交替序列重复，但结果不确定 | 提醒，不阻断 |
| 多轮序列重复且结果/错误明显不变 | 可阻止已确认无效的相同调用或循环动作 |
| 被阻止后 Agent 换工具/换参数 | 允许继续 |
| Agent 已无法继续且没有有效路径 | 允许基于已有结果输出最终说明 |

硬拦截的范围必须最小化：

- 默认只拦截已经确认无进展的相同签名调用，不停止整个 Turn。
- 不拦截所有其他工具。
- 不修改或中断已经派发的并行工具。
- 不绕过 DSH 权限、MCP Session 激活和审批规则。
- 阻止后返回可理解的原因，要求 Agent 改方法或总结。
- 不允许 Guard 伪造“任务已完成”。

建议新配置项：

```yaml
guard:
  enabled: true
  budgetMode: observe-only
  repeatDetection:
    enabled: true
    thresholds: [3, 5, 8]
    actionAtHighest: block-same-call-if-no-progress
  sequenceDetection:
    enabled: true
    windowSize: 16
    minRepeatedCycles: 2
    action: warn-only
  noProgressDetection:
    enabled: true
    sameResultThreshold: 3
    sameErrorThreshold: 3
  exclusions:
    tools: []
```

以上是目标配置形态，字段名和默认值需与当前 schema、DSH 类型及测试保持一致，不要机械复制示例。

### 2.6 Token 节省原则

- 不调用额外模型来判断是否循环。
- 未达到异常阈值时，不向 Prompt 注入任何提醒。
- 每次触发提醒只追加短消息，避免反复注入大段指导。
- 详细提醒的参数预览必须截断，默认不超过 300～500 字符；参数原文不落盘。
- 只保存工具名、参数 Hash、结果 Hash、状态和少量时间信息。
- `meta_search` 默认只返回短摘要，只有模型需要时才取详情 Schema。
- 继续 Resident / On-demand / Disabled，减少低频工具常驻 Schema。
- 不额外触发自动总结、自动压缩、模型路由或推理强度切换。

**能力按需策略不能过度激进。** 常用工具直接可用，低频工具才按需检索；如果所有工具都隐藏，反而会增加搜索和 `meta_invoke` 步骤，可能更费 Token。

---

## 3. P0：新增「调用统计」子页面

### 3.1 页面位置

本插件当前浏览器入口仍注册 `settings.section`（`id: capability`），`package.json` 尚未注入 `dsh-client-ui-plugin-manager`。官方 `plugins.bundle.config` keyed slot 在 rc.3 与 rc.5 的发布类型中均存在，适合作为本插件包详情页的新增配置入口；它与 Settings → 内置插件的 `settings.plugins.tab` 不是同一扩展点。

调用统计按独立子页面实现，注册到本插件的 `plugins.bundle.config` 页面中；现有能力管理 `settings.section` 暂时保留，除非后续单独确定迁移与兼容方案。实现需增加对应 Client inject / slot 注册和窄屏验收，不新增第二个插件包。

**配置存储契约（N5 决策）：** 不通过 `ctx.configForms` 或 `plugins.bundle.config` 表单直接改写 Cordis patch。Guard 的 `cordis.patch.yml` 配置是安装/部署基线；UI 对 Guard 的用户覆盖值写入本插件在当前 profile 下的独立、版本化 JSON 状态文件，复用 `policy-state.ts` 的锁定、校验和原子写模式，并通过本插件 Host Remote 读写。运行时优先级固定为 **UI 覆盖值 > Cordis patch 基线 > schema 默认值**。表单显示有效值与覆盖状态；恢复默认只删除对应的 UI 覆盖，回落到 patch 基线。设置保存原子提交后对新 Turn 生效；已开始的 Turn 使用其开始时的配置快照，不在执行中途改策略。Remote 应返回已持久化的有效快照/版本；失败时保留草稿并显示错误，不乐观宣称生效。统计设置与聚合索引使用独立的本插件 profile-local 存储，不混入 Guard config 或 Cordis patch。



当前 peer 范围仍声明可支持早于 rc.3 的 DSH，但 N5 只核实 rc.3/rc.5 slot。类型证据：[slot contract rc.3](https://unpkg.com/@deepseek-ai/dsh-client-ui-plugin-manager@0.2.1-rc.3/lib/types/client/slot-contract.d.ts)、[rc.5](https://unpkg.com/@deepseek-ai/dsh-client-ui-plugin-manager@0.2.1-rc.5/lib/types/client/slot-contract.d.ts)。实现不得静态等待一个低版本可能没有的 `plugins.bundle.config` slot；必须运行时检测，缺 slot 时保留现有 `settings.section` 能力页并提供可进入的统计页 fallback，或在发布前明确提高最低 peer 版本并用目标类型/Host 验证。不得在未验证时静默移除旧入口。



DSH 官方可参考：

- `packages/client/ui-plugin-manager/README.zh.md`：插件配置页面的注册与生命周期。
- `packages/client/ui-settings/README.md`：`ctx.configForms`、表单快照、原子保存与 revision 冲突处理。
- `packages/client/ui-settings-plugins/README.zh.md`：插件设置子页面/标签贡献机制。

### 3.2 页面要统计什么

用户需要看到三个层级：

1. **当前会话**：当前对话里可可靠归类的 MCP、可观察 Skill、来源已确认的插件工具调用数；其余列为 Native / Unknown，并显示覆盖口径。
2. **当前工作区**：当前 Workspace Registry 中归属该 Workspace 的所有可访问 Session 汇总，并可展开具体会话。若只能取得当前成员映射，不得声称还原调用发生当时的 Workspace。
3. **全部会话**：当前 DSH profile 可访问的所有 Workspace / Session 合计，并能按当前可确认的工作区映射与会话下钻；未分组 Session 单独标示。

建议顶部使用范围切换：

`当前会话` / `当前工作区` / `全部会话`

选择「全部会话」时，明确标注“包含当前 profile 可访问的所有工作区会话”，不要暗示包含其他 profile 或当前 Host 根本无法访问的本地会话。

### 3.3 统计时间范围

提供三个明显的快捷筛选：

`7 天` / `15 天` / `30 天`

统一定义为滚动窗口：从当前查询时间向前回溯 7 × 24、15 × 24、30 × 24 小时。图表按 DSH Host 本地时区的自然日分桶；内部统一存 UTC 时间戳，展示时转换成本地时间。

切换时间范围时：

- 总调用次数、成功/失败次数、独立能力数、活跃 MCP Server 数同步更新。
- 每日调用趋势同步更新。
- MCP / Skills / 插件工具列表同步更新。
- 闲置建议使用所选窗口，但“建议禁用”只在 30 天窗口满足完整观察条件时出现。

### 3.4 页面信息布局

建议从上到下分为五个区域。

**A. 顶部范围和时间筛选**

- 范围：当前会话 / 当前工作区 / 全部会话。
- 时间：7 天 / 15 天 / 30 天。
- 可选工作区、会话筛选器。
- 刷新按钮和数据覆盖提示。

**B. 总览数字卡片**

建议显示：

- 总调用次数（明确标注“工具/技能调用次数”，不代表 Token 数）。
- MCP 调用次数 / 活跃 Server 数。
- Skill 调用次数 / 可观察入口覆盖数（不代表所有 `ctx.skills.get()` 路径）。
- 来源已确认的插件工具调用次数 / 插件数；未知 owner 的工具单列，不猜包名。
- 30 天 0 调用候选数量（只有完整可用性与采集覆盖满足条件才可进入建议集）。

数字只作统计，不要做“剩余额度”或“预算已用百分比”。

**C. 调用趋势**

- 一张按日统计的调用趋势图。
- 可切换总调用、MCP、Skills、插件工具。
- 无数据时显示空状态，不画虚假趋势。
- 并行调用按实际调用次数计数；不要把并行时间相加后误称为实际墙钟时间。

**D. 能力调用排行**

采用分类标签：`全部` / `MCP` / `Skills` / `插件工具` / `原生与其他`。

每行至少展示：

| 字段 | 说明 |
|---|---|
| 名称 | Server / Skill / 插件包 / Tool 名称 |
| 类型 | MCP、Skill、Plugin Tool、Native / Unknown |
| 调用次数 | 当前筛选窗口内的调用总数 |
| 成功 / 失败 | 已获得结果的状态分类 |
| 最近调用 | 最近一次实际调用时间 |
| 当前状态 | 常驻、按需、禁用、已卸载/不可用、未知 |
| 建议 | 正常、低频、建议改按需、建议禁用、数据不足 |

允许按调用次数、最近调用时间、名称排序，并支持名称/Server/插件来源搜索。

**E. 闲置能力建议**

单独显示 30 天 0 调用候选，列出“为什么建议”和“建议怎么处理”。不要把建议混成自动操作。

### 3.5 各分类的展示方式

**MCP：**

- 按 MCP Server 汇总调用量。
- 展开 Server 后显示各 Tool 的调用次数。
- 显示 Server 最近一次被调用时间、当前是否可用（若 DSH 公开 API 能确认）。
- 若一个 Server 下所有可统计工具 30 天都 0 调用，显示“该 MCP Server 近 30 天没有观察到调用，可考虑检查是否仍需要”。
- 本插件不得直接断开 MCP、改凭据、切换 Always/Session 或代替 MCP Connector 激活工具。

**Skills：**

- 仅汇总公开事件可观察的 Skill load/invoke 入口（如经 rc.3/rc.5 隔离验证的宿主 `skill` 工具与显式 `/name` 调用）；不把技能目录列表或 Prompt 中出现的名称算作使用。
- 显示来源（全局、项目、预设等）仅限统计事件或对应 Session 目录能可靠提供的信息；缺失时标明来源未知。
- 明确标注覆盖：直接 `ctx.skills.get()` 等没有通用全局 load event 的路径不保证被统计，不能称为全量 Skill 调用。
- 显示当前策略：常驻 / 按需 / 禁用（来自当前可读策略，不反推历史策略）。
- 对覆盖期与可用状态均连续完整的常驻 Skill，优先建议改为按需；覆盖不完整或加载来源未知时只提示数据不足。

**插件工具：**

- 仅当公开运行时注册元数据能可靠提供 owner/package 时，才按插件包汇总 Tool 与调用次数。
- 当前核验的 rc.3/rc.5 `ToolDefinition` / `ToolExecution` 类型未提供通用 owner/package 字段；因此第三方/动态注册 Tool 默认归 `Native / Unknown`，不得按工具名前缀、包名猜测或把所有非 MCP 工具统称为某个插件。
- 若后续 DSH 为特定工具提供可验证来源映射，可使用版本化白名单/manifest 映射并注明适用版本；映射缺失或插件已卸载时退回 Unknown。
- Unknown 行不得出现在插件包排行或包级禁用建议中；MCP Server 下零调用建议仅对 Server/Tool 身份与启用覆盖可确认的项显示。

### 3.6 “30 天 0 调用，建议禁用”的规则

这是用户明确提出的功能，但必须避免误报。

**必须同时满足以下条件才显示“建议禁用”：**

1. 当前筛选为 30 天。
2. 已有连续至少 30 天的可靠统计覆盖；不能把插件刚安装 3 天误判成 30 天没使用。
3. 该能力在整个观察窗口内可用且处于启用状态，或能明确知道它在什么时候启用。
4. 统计数据没有明显缺失，历史回补已完成或覆盖情况足以判断；能力 owner/source 可可靠识别。Unknown 来源或未覆盖 Skill 路径不算 0 调用。
5. 它不是 DSH 核心必需能力、审批/安全工具、MCP 连接管理底层依赖、能力管理控制工具、用户保护名单中的对象。
6. 没有调用记录，而不是调用记录无法读取、来源无法识别或数据尚未采集。

各类型建议动作：

| 类型 | 30 天 0 调用后的建议 |
|---|---|
| MCP Tool | 建议禁用该工具（若策略层允许单工具禁用）；不自动断开 Server |
| MCP Server 下所有工具 | 建议检查/考虑停用该 Server；跳转或提示由 MCP Connector 手动管理 |
| 常驻 Skill | 优先建议改为按需；如果明确不再需要，再建议禁用 |
| 按需 Skill | 建议禁用或移除出当前可用目录，需用户确认 |
| 已确认 owner 的单个插件 Tool | 只有来源与完整覆盖均可证明时才建议禁用该能力 |
| 整个插件包 | 只有该包所有可归属能力均为 0 调用、来源完整且非保护包时，才建议检查是否可禁用整个包；Unknown 不参与包级判断 |

界面动作：

- `查看详情`
- `调整为按需`（仅适用于 Skill/支持按需的能力）
- `加入禁用候选` / `前往能力管理`
- 用户在原有策略控件里明确确认后才应用。

**绝对禁止：** 打开统计页后自动批量禁用、自动卸载 npm 包、自动断开 MCP Server、自动删除 Skill 文件。

### 3.7 统计口径与数据模型

统计必须以“实际调用”为基础，而不是模型 Prompt 中出现过某个工具 Schema 就算调用。

建议最小记录结构：

```ts
interface UsageAggregateKey {
  profileId: string
  date: string                 // Host 本地自然日或稳定的 UTC 日期桶
  workspaceId?: string         // 仅能确定归属时填写
  workspaceAttribution: 'event-time' | 'current-mapping' | 'unknown'
  sessionId: string
  capabilityId: string        // 精确 Tool ID 或 Skill ID
  capabilityKind: 'mcp' | 'skill' | 'plugin-tool' | 'native' | 'unknown'
  providerId?: string         // 仅可验证的 MCP Server / plugin owner；不得由名称猜测
}

interface UsageAggregate {
  calls: number
  succeeded: number
  failed: number
  denied: number
  cancelled: number
  unresolved: number
  lastUsedAt?: number
  firstObservedAt: number
}
```

可按现有持久化实现调整字段，但必须保留工作区、会话、日期、能力 ID、能力类型、来源和结果状态这些维度。

**调用次数口径：**

- Tool：每个 Session 内以唯一 `tool/call` 的 `callId` 作为一次调用，聚合/去重主键为 `(sessionId, callId)` 或事件 `(sessionId, seq)`，不能把 `tool/call` 与 `tool/result` 各算一次；不得假设 `callId` 跨 Session 唯一。
- `tool/result` 只补充调用结果状态，不再新增调用次数。
- 被拒绝的尝试如已进入 DSH 的可观察执行/会话事件，应计入“尝试/拒绝”，不要误算成功。
- 工具调用没有结果时先记为 unresolved；会话恢复或回补时再尝试匹配结果。
- 并行工具分别计数，每个不同 callId 是一次调用。
- `meta_search` / `meta_invoke` 外层是能力控制面，不进入普通业务排行；`meta_invoke` 目标只在可观察的真实内层 dispatch 上计一次，不按外层参数推断成功调用。历史日志若没有持久化的内层事件，计入 unresolved/coverage gap，不得声称历史完整。
- DSH 的 PTC / Code Mode / 子调用路径必须按公开 parent/root/call 标识验证调用归属，区分模型发起根调用与内部真实业务 dispatch。隔离实测通过前不得承诺全量内层计数；不能关联的结果标记 unresolved，不重复计算外层传输。
- Skill：只统计真正发生的 Skill load / invoke。Skill 名字出现在常驻列表或 Prompt 中不算调用。
- 仅在某个公开 hook/API 能提供真实 Skill 加载事实时才纳入；若当前 DSH 版本没有覆盖所有 Skill 装载路径，UI 必须说明统计口径和覆盖缺口，不能伪称完整。

### 3.8 数据来源与归类要求

DSH 官方会话事件日志是首选可追溯来源：

- DSH Session `tool/call`：公开事件包含 `seq/time/turn/step/callId/name/arguments`；配对 `tool/result` 必须限定在同一 Session。
- Session Header / Workspace Registry：可提供 Session 元数据与当前 Workspace 成员关系；rc.3/rc.5 Session Header 不含 `workspaceId`，Workspace Registry 不提供历史成员变更事件。
- 当前工具注册表 / 能力目录：MCP Server 可通过注册表可靠归属；任意 Tool owner/package 不保证公开，只有可验证元数据可用时才归类，否则 Unknown。
- DSH Skills：`skills/change` 是目录变化通知，不是 Skill load 事件；仅纳入有公开事件证据的 Skill 入口并说明未覆盖路径。

当前核验的 rc.3/rc.5 `ToolDefinition` / `ToolExecution` 类型没有通用插件包 owner 字段；`tools/change` 也不携带 owner 信息。因此：

1. MCP Tool 只在与当前注册 MCP Server 清单唯一匹配时归到 MCP；多个候选或没有可靠 Server 映射时标记 Unknown，不按字符串前缀猜包名。
2. 普通 Plugin Tool 只有在 DSH 公开注册元数据明确给出 owner，或项目随版本维护、逐项可审计的第一方白名单映射时才按包归类。当前 API 未提供通用 owner 字段，默认应归 Unknown。
3. 历史回补不得用当前能力目录中同名工具替代历史 owner 事实；只有持久化来源快照能证明时才归类。插件卸载且历史无来源快照时标记 Unknown。
4. 不可使用私有 API、扫描 profile/pnpm 安装目录、读取其他插件凭据或扫描敏感配置推断来源。
### 3.9 历史数据回补与统计覆盖

统计页需要尽可能统计已存在的会话，而不是只有插件安装后才开始显示。

实现要求：

- 首次启动时，尝试通过 DSH 公开 Session / Workspace / 持久化查询 API 回补最近 30 天可访问会话的 `tool/call`、`tool/result` 和可观察的 Skill load 记录。只处理当前 profile 与当前调用者有权访问的 Session。
- **读取接口与隐私边界（N2 已确认）：** 当前公开历史接口会返回完整 Session event payload；允许在 DSH Host 本机进程内分页读取并短暂解析，以便提取统计字段。实现必须以目标 DSH 的公开类型/API 为准。已核对 `@deepseek-ai/dsh-session-persistence` rc.3/rc.5 均声明 `list/open(id, 'read')` 与 `SessionHandle.read(offset, length)`，`@deepseek-ai/dsh-api-session-controller` rc.3/rc.5 均声明 `page/follow`；这些是发布类型兼容证据，不代表服务在实际 profile 一定已装载。当前开发依赖锁定 rc.3，typecheck 仅验证 rc.3；实现须对公开服务作能力检测，缺失时安全退化到实时采集并标记历史不可回补。N4 运行态验收仍未执行，不得报告 rc.5 实际 Host 通过。不得扫描 `~/.dsh/sessions` 私有目录、依赖 JSONL/Zstd 文件布局或调用 DSH 私有字段。类型参考：[Persistence rc.3](https://unpkg.com/@deepseek-ai/dsh-session-persistence@0.2.1-rc.3/lib/types/index.d.ts)、[Handle rc.3](https://unpkg.com/@deepseek-ai/dsh-session-persistence@0.2.1-rc.3/lib/types/handle.d.ts)、[Session Controller rc.3](https://unpkg.com/@deepseek-ai/dsh-api-session-controller@0.2.1-rc.3/lib/types/index.d.ts)、[Persistence rc.5](https://unpkg.com/@deepseek-ai/dsh-session-persistence@0.2.1-rc.5/lib/types/index.d.ts)、[Handle rc.5](https://unpkg.com/@deepseek-ai/dsh-session-persistence@0.2.1-rc.5/lib/types/handle.d.ts)、[Session Controller rc.5](https://unpkg.com/@deepseek-ai/dsh-api-session-controller@0.2.1-rc.5/lib/types/index.d.ts)。
- 当前包的 peerDependencies/devDependencies 尚未声明 `@deepseek-ai/dsh-session-persistence`、`@deepseek-ai/dsh-workspace` 或 `@deepseek-ai/dsh-client-ui-plugin-manager`。若实现直接依赖这些类型/API，应在同一阶段补齐与目标 DSH 基线一致的 peer/dev 声明和客户端 inject；Session Persistence 与 Workspace 作为可选能力，不可放进无条件 `static inject` 造成服务缺失时插件 fiber 永久等待。Host 运行时必须探测 `ctx.sessionPersistence` / `ctx.workspaceRegistry`：缺 Session Persistence 时降级实时采集，缺 Workspace Registry 时按未分组/当前可确认映射统计并显示覆盖缺口；禁止把“服务不可用”当作空历史。
- 统计逻辑只访问统计所需字段：`tool/call` 的 `seq/time/callId/name`，`tool/result` 的 `seq/time/message.toolCallId/message.isError` 及必要的错误代码；Skill 只解析明确可观察入口所需的技能名。Schema 税若启用，可读取 `request/header` 中工具 Schema 元数据。不得遍历、解释或保存 `user/message` 正文、工具完整输出、assistant stream / reasoning；普通工具调用参数不得读取或解析，Skill 参数也只准读取技能名字段。调用配对键为 `sessionId + callId`，不得假设 `callId` 跨 Session 唯一。
- 完整 payload 在公开 API 返回时可能已短暂进入 Host 内存；本决策允许该瞬时读取，但要求处理完立即释放事件页引用。禁止把完整事件、消息正文、工具参数/输出、Skill 正文或凭据写入统计索引、缓存、诊断样本、日志或 Remote 返回；不上传、不发起外网请求。不得建立保存完整解压日志文本的 LRU 缓存。
- 回补与增量采集均按小页、低优先级、可取消执行；同一时刻只保留有限数量的 Session/page，处理完立即释放，不在打开统计页时同步扫描全部历史。以公开轻量快照（如可用的 `sizeBytes`）先做单 Session 体积预检，并为单 Session 与单页设置明确的体积 / 事件数上限；具体默认值须经目标 Host 基准测试后写入实现与验收报告。超限 Session/page 必须跳过或停止继续读取、释放当前页，并记录 `oversize` / `page-limit` 覆盖缺口；不得把未读部分当作 0 调用。若 API 未提供大小信息，仍须限制页大小并在收到页面后检查；要如实记录单个超大事件可能已由 API 短暂物化这一剩余风险。
- 维护每个 Session 的回补游标/最后事件序号，以 `sessionId + eventSeq` 幂等去重；`tool/result` 只更新对应 `(sessionId, callId)` 的结果状态，不增加新调用次数。取消、重连、进程重启后重复回补不得重复累计；游标不得越过尚未处理或因超限而跳过的区间。
- 会话归档不等于删除统计；只要历史日志仍可访问，就保留窗口内的统计。
- 维护可持久化的统计覆盖摘要：覆盖起止时间、每个 Session 的已扫描序号范围、完成状态（`complete / partial / unknown`）、跳过 Session 数及原因。公开 API 不可用或历史不可回补时，采用“从插件开始采集之日”的实时统计，并显示“历史数据不可回补”；不允许假装有完整 30 天数据。
- “30 天 0 调用建议禁用”还要求能力在完整观察期内持续可用且启用。调用历史本身不能证明能力当时可用；从能力可用状态的可靠变更来源不可得时，覆盖期从本插件首次确认该能力可用且启用时开始。连续覆盖未满 30 天、采集有缺口或状态未知时，显示“数据不足，暂不判断是否闲置”，不得显示“建议禁用”。

### 3.10 数据保存和隐私

这是一个调用次数统计，不是调用内容审计。N2 已允许本机短暂解析公开 API 返回的完整事件；这不授权将正文用于内容分析、长期缓存、日志记录、Remote 返回或外部传输。

禁止保存：

- 用户完整消息/提示词。
- 工具完整参数、文件正文、命令正文。
- 工具完整输出/返回内容。
- MCP 密钥、Headers、OAuth Grant、连接凭据。
- Skill 文件全文。

允许保存的最小字段：

- 时间、profile、workspaceId、sessionId。
- Tool / Skill 的稳定 ID、类型和可靠来源。
- 调用状态与次数。
- 参数/结果的短 Hash（仅循环检测需要；统计索引不必保留参数 Hash）。

建议保留 45 天的日聚合记录（覆盖 30 天窗口和边界余量），之后自动清理。用户可在设置里重置统计数据；清除统计不能影响 Session 原始日志、能力配置和 MCP 连接。

数据默认只保存在当前 DSH profile 本地，不发送外网，不上传遥测。

### 3.11 跨工作区与跨会话的正确性

- `当前会话`：只汇总当前 Session ID。
- `当前工作区`：依据 DSH 正式 Workspace ID 汇总该 Workspace 下所有可访问 Session。
- `全部会话`：当前 profile 下所有可访问工作区及未分组 Session。
- 不同 profile 的数据必须隔离。
- 如果 DSH 的项目本地 `.sessions` 或未注册目录会话不在 Workspace Registry 中，按公开 API 实际可见范围处理，并在覆盖说明中标记，不得声称已包含所有磁盘会话。
- 统计记录若在实时调用时能取得正式 Workspace ID，应存调用发生时的 ID 并标记 `event-time`。rc.3/rc.5 Session Header 不含 `workspaceId`，Workspace Registry 只给当前 `sessionIds` 账本而不提供历史成员变更事件；历史回补不能从当前成员关系推断调用发生时的 Workspace。无法恢复时可按当前确认映射展示，但必须标记 `current-mapping`；没有可靠映射则 `workspaceId` 缺失并标记 `unknown`，不得宣称历史归属准确。
- 删除 Session 时按 DSH 删除政策处理关联聚合；归档 Session 默认仍计入。

---

## 4. UI 整体重构

### 4.1 页面结构

建议统一成四个清楚的主页面：

1. **总览**：Guard 是否启用、当前策略、近期异常、统计采集状态。
2. **智能防循环**：相同调用、交替循环、无进展阈值与例外工具。
3. **调用统计**：当前会话 / 当前工作区 / 全部会话，7 / 15 / 30 天，排行、趋势、闲置建议。
4. **能力管理**：Tools / MCP Tools / Skills，Resident / On-demand / Disabled，来源、搜索和详情。

如果现有页面已有部分导航，优先在原结构内调整，不要重复创建一个功能相同的新页面。

### 4.2 视觉和交互要求

- 延续 DSH 设置页面的紧凑、清晰、信息密度适中的设计。
- 使用统一卡片、分组标题、短说明、状态标签、图表和表格。
- 不要堆叠大量说明文字；复杂解释放进帮助提示或折叠详情。
- 重要开关旁边必须用大白话解释“打开后会发生什么”。
- 区分“统计值”“建议”“实际配置”，避免把建议状态伪装成已经禁用。
- 配置页表单使用草稿、保存/取消和校验反馈；Guard 设置通过本插件 Host Remote 管理的版本化 profile-local 状态保存，不直接调用通用 `ctx.configForms` 写 Cordis patch。需要 DSH ConfigForm 的其他部署配置仍按其 owner 的配置服务单独处理。
- 所有页面文案做中文本地化；如果包已有多语言结构，保持其他语言键值完整。
- 大列表分页或虚拟化，不要一次渲染全部 MCP Tool / Skill。
- 统计首次加载时显示骨架屏；回补期间显示进度与已覆盖范围，不要阻塞整个设置页面。
- 图表没有数据时显示明确空状态；不能用示意数字冒充真实数据。

### 4.3 总览页面示意内容

- Guard：运行中 / 已关闭。
- 当前策略：智能防循环（不限制正常任务总步数、工具次数和时长）。
- 最近 7 天工具调用数、异常循环提醒次数、实际阻断次数。
- 统计数据覆盖起止日期。
- 最近一次循环异常：工具、发生时间、处置方式；不展示完整参数或输出。

### 4.4 智能防循环设置页

用普通用户能看懂的名称：

| 页面文字 | 内部概念 |
|---|---|
| 相同调用重复检测 | exact duplicate detection |
| 来回切换式循环 | alternating sequence detection |
| 结果一直没变化 | no-progress fingerprint |
| 提醒次数 | thresholds |
| 例外工具 | exclude patterns |
| 确认无效后阻止重复动作 | local same-call blocking |

默认展开常用选项，高级选项折叠。不要把 `hardSteps`、硬工具数和硬时长重新放回主界面。

### 4.5 调用统计页面交互

- 点击 MCP Server 行可展开其 Tool 列表。
- 点击插件包行可展开其提供的 Tool 列表。
- 点击 Skill 行可看来源、当前策略、最近加载时间。
- 点击工作区可查看该工作区所有会话统计。
- 点击会话可进入该会话的调用分布明细。
- 30 天 0 调用行要说明“统计覆盖满 30 天 / 当前一直可用 / 调用次数为 0”，并给出建议动作。
- 对数据不完整的对象显示“未知来源”“统计未覆盖”“数据不足”，不得将它算作 0 调用。

---

## 5. 架构改造建议

在现有架构基础上增量添加模块，避免大规模搬迁文件。

建议目标结构：

```text
plugin/src/
  index.ts
  registry.ts
  search.ts
  invoke.ts
  policy.ts
  policy-state.ts
  guard-core.ts
  guard.ts
  locations.ts
  patch-file.ts
  host-face.ts
  usage/
    usage-types.ts
    usage-classifier.ts
    usage-collector.ts
    usage-index.ts
    usage-backfill.ts
    usage-query.ts
    usage-recommendations.ts
  client/
    ...现有能力菜单客户端
    pages/
      overview/
      guard/
      usage/
      capabilities/
  server/
    ...现有接口
    usage-remote.ts
  tests/
    ...
```

实际目录可按现有代码组织调整，但职责要清楚。

### 5.1 Usage Collector

负责监听实际调用事件、识别唯一调用、关联结果、识别 Session / Workspace、调用分类。不得读取完整对话内容。

### 5.2 Usage Classifier

复用当前 Capability Registry；对 MCP、Skill、Plugin Tool、Native、Unknown 做互斥归类。来源不可靠就标记 Unknown。

### 5.3 Usage Index

负责本地持久化日聚合、事件游标、幂等去重、过期清理、统计重建。优先使用项目既有可靠存储和原子写入模式；不要为了简单统计引入过重数据库依赖。

### 5.4 Usage Backfill

只负责首次/增量历史回补。必须分页、可取消、低优先级运行，不在每次打开设置页时全量扫描会话。

### 5.5 Usage Query

按 profile、workspace、session、日期范围、能力类型、provider 汇总数据。服务端预聚合，浏览器不读取全量历史日志。

### 5.6 Usage Recommendations

根据 30 天覆盖期、可用状态、调用次数、能力类型、保护名单给出建议。此模块只返回建议，不直接修改策略或插件状态。

### 5.7 与 Guard 状态共用的原则

Guard 的最近调用指纹和统计索引可以共享一次调用事件，但职责隔离：

- Guard 只保留短期循环判断需要的内存状态。
- Usage Index 只保留长期计数所需的最小匿名化元数据。
- 不要把完整参数/输出为了统计而写入磁盘。

---

## 6. 配置结构建议

字段名称以现有 schema 迁移策略为准。目标语义如下：

```yaml
guard:
  enabled: true
  budgetMode: observe-only
  repeatDetection:
    enabled: true
    thresholds: [3, 5, 8]
    blockConfirmedNoProgress: true
  sequenceDetection:
    enabled: true
    windowSize: 16
    minRepeatedCycles: 2
    action: warn-only
  noProgressDetection:
    enabled: true
    sameResultThreshold: 3
    sameErrorThreshold: 3
  exclusions:
    tools: []
  # 以下旧字段仅兼容读取，不得再产生硬停止行为
  stepLimitMode: warn-only

usageStats:
  enabled: true
  windows: [7, 15, 30]
  retentionDays: 45
  backfillDays: 30
  showNativeTools: true
  recommendations:
    suggestDisableAfterDays: 30
    requireFullCoverage: true
    protectedCapabilities: []
    protectedPluginPackages: []
```

不允许在配置里放入虚假的 Token 上限、推理强度自动切换、模型路由策略或 MCP 凭据。

---

## 7. 性能和稳定性要求

1. Agent 每一步的 Guard 检查必须是内存级轻量操作，不得每步扫描所有会话或磁盘。
2. 统计索引按事件增量更新；页面只查聚合结果。
3. 首次历史回补必须限速、分页、可中断，按 Session/page 设置明确的体积或事件数上限；超限时释放当前页、跳过并记录 partial/oversize 覆盖状态，不能影响模型调用优先级。不得缓存完整 Session 文本。
4. 不因打开统计页才初始化昂贵的后台任务。
5. 多 Agent、多 Session、多 Workspace 同时运行时，统计和 Guard 状态不得串线。
6. 工具取消、超时、异常、没有 `tools/result` 等路径不能造成永久 pending 计数；提供定期 reconcile 或可靠超时清理。
7. `meta_invoke` 外层和内层目标必须准确计数一次。
8. 插件卸载时清理监听器、订阅、计时器；保留还是清理统计数据要由卸载流程明确说明。
9. 统计存储损坏时可重建；重建过程不得删除原始 Session 日志或能力策略。
10. Windows 11 路径、文件锁、原子写入、中文路径都要验证。

---

## 8. 必须执行的测试与验收

### 8.1 Guard 测试

- 任务运行超过 8 分钟，不得因为时间阈值被插件停止。
- 单轮 30、50、100 次不同且有进展的工具调用，不得因为数量阈值被插件停止。
- 模型 Step 超过原 `hardSteps`，不得因为旧配置而硬停止。
- 即使旧配置为 `stepLimitMode: hard-stop`，新版本也不得启用硬步数停止；必须显示兼容提示。
- 相同工具/参数第 3、5、8 次提醒符合配置。
- JSON 对象属性顺序不同仍识别为相同参数。
- 多 Agent 之间不串计数。
- 新的真实用户指令重置重复链；工具生成的合成提醒不能误当用户新指令重置。
- A → B → A → B 等交替循环可以检测，但不因一次相似序列误拦截。
- 相同结果、相同错误和合法轮询分别测试，避免误判。
- 进入局部阻断后，更换工具或参数可以继续；不会停止整个 Turn。
- 被阻止后 Agent 仍可输出最终总结。
- 并行调用不被事件顺序误判。

### 8.2 调用统计测试

- 每个唯一 `tool/call` 只增加一次调用次数。
- 对应 `tool/result` 只更新结果状态，不再重复增加调用次数。
- 并行 4 个 Tool Call 计为 4 次。
- `meta_search` / `meta_invoke` 外层不计入业务排行；`meta_invoke` 目标只在可观察 dispatch 时计数。若历史事件无内层记录则标 unresolved/coverage gap，不从 wrapper 参数猜测。
- PTC / Code Mode 内层与外层 transport 必须用已验证的 call/parent 标识去重；无法关联时显示覆盖缺口，不重复或推断累计。
- MCP Tool 归类为 MCP，不重复记入 MCP Connector 插件工具调用。
- Plugin Tool 仅在 owner 来源可靠时按包归类；无来源按 Unknown 展示，不能进入插件包排行或包级建议。
- Skill 只统计公开事件可观察的 load/invoke（如已验证的 skill 工具与显式 `/name` 入口），不统计 Prompt 中的 Skill 列表；其他直接 `ctx.skills.get()` 等无全局事件的路径标记为未覆盖，不得宣称全量统计。
- 成功、失败、拒绝、取消、无结果分别能正确区分。
- 当前会话、当前工作区、全部会话范围计算正确。
- 7/15/30 天时间窗口边界正确，跨日统计按 Host 本地时区显示。
- 多 profile 数据不混用。
- 已归档 Session 仍能按实际数据策略统计。
- 历史回补通过公开 API 分页；重复页按 `sessionId + eventSeq` 幂等，结果按 `(sessionId, callId)` 配对，同一 `callId` 在不同 Session 中不串线。
- 回补中断后可从最后已提交游标恢复；游标不得越过未处理或因上限跳过的页，重跑不得重复累计。
- 超过单 Session / page 上限时跳过该 Session 或停止该页后续读取，报告 `partial/oversize` 与原因；不得把未读部分显示为 0 调用；其他 Session 继续处理。
- 使用含唯一哨兵正文、参数和工具输出的事件页验证：聚合索引、缓存、日志与 Remote 返回均不包含原文；扫描过程不发起网络上传。
- 历史读取对 `user/message` 正文、`assistant/message` stream/reasoning 和非 Skill 调用参数不做统计解析；Skill 只处理已支持入口所需的技能名，其他 load 路径显示覆盖不足。
- 插件安装未满 30 天时不得显示“30 天 0 调用建议禁用”。
- 数据缺失或来源未知不得被当作 0 调用。
- 统计清理只清理插件自己的统计索引，不影响 Session 日志。

### 8.3 UI 测试

- 侧栏「插件」管理页中打开本插件的包配置页（`plugins.bundle.config`），能进入独立调用统计子页面；原能力管理 `settings.section` 未被意外移除或重复注册。
- 四个主页面导航和现有能力管理功能不冲突。
- 7 / 15 / 30 天切换能刷新 KPI、图表、排行和建议。
- 当前会话 / 当前工作区 / 全部会话切换正确。
- MCP、已观察 Skills、已确认 owner 的 Plugin Tool 分类互斥且数量与后端一致；未知来源归入 Unknown，Skill 覆盖缺口明确可见。
- 能展开 Server、插件包和会话明细。
- 30 天无调用建议显示原因、覆盖期、可执行的人工操作。
- 没有数据、统计未覆盖、加载失败、回补中、超限跳过和覆盖不完整均有明确状态及原因。
- Guard 用户覆盖值优先于 Cordis patch 基线；新保存设置从下一 Turn 生效，当前 Turn 保持开始时快照，恢复默认移除覆盖并回落基线。
- Guard 状态文件版本、缺失/损坏、原子写、并发更新冲突、旧 schema 迁移和恢复默认均有测试；保存失败保留草稿且不得报告生效。
- `plugins.bundle.config` 页面在已支持 Host 可直接进入；缺少该 slot 的受支持 Host 保留现有 `settings.section` 并提供统计页 fallback，或该 Host 已明确排除在最低 peer 范围外。
- 大列表不会造成明显 UI 卡顿。
- 中文文案完整，窄窗口可用。

### 8.4 共存测试

必须与以下插件组合验证：

1. `dsh-plugin-save-token`：压缩、恢复正常，本插件不篡改工具结果。
2. `dsh-mcp-connector` Always：MCP 统计能正确归类。
3. `dsh-mcp-connector` Session：本插件无法绕过 Session 激活权限。
4. `dsh-context` / `dsh-cost-meter`：无重复统计、无命名冲突。
5. `dsh-mnemon`：已确认来源工具按可用元数据归类，其余标 Unknown；不泄漏记忆内容。
6. 多 Agent、多 Session 同时运行：计数和状态隔离正确。

### 8.5 性能验收

使用不同规模的历史会话和能力数量测试：

- 100、1,000、10,000 个 Session 的查询/回补行为（若本机资源允许）。
- 20、50、100、500 个 Capability 的能力目录过滤和统计排行。
- 页面打开只读取聚合数据，不触发全量日志扫描。
- 增量采集不明显拖慢工具调用。
- 统计索引体积受 45 天保留策略约束。
- 记录回补速度、峰值内存、实际页数/字节数、超限跳过数与原因、覆盖范围、索引大小和页面查询耗时；验证回补同一时刻最多保留一个 Session/page 引用，超大 Session/page 会降级且不误报为 0 调用，并记录单个超大事件由公开 API 短暂物化的剩余风险。

### 8.6 发布验收

必须提交实际证据：

- `typecheck` 通过。
- `test` 通过，新增测试覆盖本文件核心场景。
- `build` 通过。
- `npm pack --dry-run` 通过。
- DSH 实际 profile 安装并加载成功。
- Windows 11 GUI 设置页面实际显示和可操作。
- 真实多会话数据统计正确。
- 历史回补、增量更新、重启恢复和统计清理通过。
- 旧配置兼容与回滚可用。
- 提供完整测试结果、DSH 版本、Node 版本、插件版本和未通过项。

---

## 9. 配置兼容、迁移和回滚

### 9.1 旧配置迁移

- 读取旧的 `quick / normal / deep` profile 时保留配置，不要直接删除数据。
- 旧 `hardSteps`、`hardToolCalls`、`hardDurationMs` 可以保留作为历史配置展示或迁移备份，但新执行逻辑不得把它们当成硬停止条件。
- 旧 `stepLimitMode: hard-stop` 在新版本中强制转换为 `warn-only` / `observe-only` 语义，并给出一次性迁移提示。
- `duplicateHardBlock` 不再单独作为粗暴的“重复即阻断”开关；迁移成“确认无进展后仅阻止相同调用”的更安全语义。旧值必须记录并给出说明。
- 旧策略 Resident / On-demand / Disabled 不得自动改变。
- 旧 Capability Menu 策略迁移现状仍按项目实际证据处理，不得宣称自动迁移已完成。

### 9.2 回滚

- 发布前备份目标 profile 的 package、Cordis patch、配置状态和策略状态。
- 统计索引独立存放；回滚旧版本时旧版本可以忽略新统计数据，不影响旧能力目录。
- 不自动卸载旧插件、不自动切换生产 profile、不删除原始数据。
- 新版本出现异常时，能够关闭新 Guard 或统计采集，而不是必须卸载整个插件。

---

## 10. 建议的开发顺序

### P0-A：修复“正常任务提前停止”

1. 移除 Tool Count / Duration 的硬停止。
2. 移除 `hardSteps` 的 hard-stop 执行路径，兼容旧配置。
3. 保留 Step / Tool / Time 统计。
4. 完成正常长任务测试。

### P0-B：循环检测

1. 审计并复用官方 repeat-tool-reminder 的成熟思路；生产 profile 状态目前未知，Guard 重复提醒必须可独立关闭，并在双插件并存测试中确认不会重复注入同一提醒。
2. 完善相同调用签名和提醒层级。
3. 新增交替调用序列检测。
4. 新增结果/错误无变化判断。
5. 实现只阻止已确认无效的同一操作，不停止整轮任务。

### P1-A：调用统计后端

1. 接入可选的公开 `SessionPersistence` 只读分页 API；为 rc.3/rc.5 对齐 peer/dev 类型声明。无服务时安全降级实时采集，不得静态注入造成 Host 启动等待，也不得把缺服务当作零历史。
2. Workspace Registry 按可用性探测并提供当前成员映射；历史不能证明 event-time Workspace 时，明确标记 `current-mapping` / `unknown`。
3. 冻结互斥分类：MCP 只按唯一可靠 Server 映射，Skill 只计可观察入口，Plugin Tool 只有 owner 可靠时按包归类，其余 Unknown；不按工具名猜包。
4. 实现实时记录、受限历史分页回补、`sessionId+eventSeq` 幂等、`sessionId+callId` 结果配对、coverage/oversize 状态与 30/45 天保留；超限和无可用性历史不得形成禁用建议。
5. 实现当前会话 / 当前 Workspace 可确认映射 / 当前 profile 全部可访问 Session 查询。
6. 在目标 Host 上实测 meta_invoke、PTC/内部调用与并行事件归属；没被持久化的内层调用标覆盖缺口，不推断补算。

### P1-B：调用统计页面

1. 在 `plugins.bundle.config` 注册独立调用统计页；保留当前能力管理 `settings.section`，不新增插件包。
2. Guard 与统计设置使用版本化 profile-local 状态及本插件 Host Remote；不直接让 `ctx.configForms` 写 Cordis patch。提供生效值、覆盖状态、保存/取消/校验/恢复默认。
3. 加入 7 / 15 / 30 天切换、趋势图、分类统计、排行和展开详情。
4. 展示 Skill 入口覆盖、Unknown owner、Workspace 归属口径、历史 coverage / skipped / oversize；不完整数据不显示为零。
5. 加入满足连续 30 天可用性与完整数据覆盖后才出现的人工禁用建议；保护名单和跳转能力管理，禁止自动操作。

### P1-C：现有 UI 重构

1. 总览页面。
2. 智能防循环设置页（复用 P1-B 确定的 Guard 设置状态/Remote 契约）。
3. 能力管理页视觉与交互优化。
4. 完成中文文案、空状态、错误状态、窄窗口布局和配置冲突恢复。

### P2：可靠性与发布

1. 多会话、多 profile、并发、取消和重启恢复测试。
2. 与现有插件共存验证。
3. Windows 11 生产 GUI 验收。
4. 中文 README、迁移、回滚和发布说明。

---

## 11. GitHub 官方参考资料

以下是本次方案核对过的 DSH 官方仓库资料，重点是借鉴现成机制，不是要求把官方实验插件整个复制进本插件。

### 循环检测

- [DSH 官方 repeat-tool-reminder 中文说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/guard/repeat-tool-reminder/README.zh.md)
- [repeat-tool-reminder 源码](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/guard/repeat-tool-reminder/src/index.ts)

借鉴点：规范化参数指纹、按 Agent 分离、阈值提醒、提醒附加上下文、默认不阻断。

### 工具事件与调用口径

- [DSH Tools 子系统中文文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.zh.md)
- [DSH Session 子系统中文文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.zh.md)
- [DSH 工具目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.zh.md)

借鉴点：工具执行管线、`tool/call` / `tool/result` 事件、调用 ID 配对、工具目录和插件包归属线索。

### 会话统计

- [DSH session-stats 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-stats/README.md)
- [DSH experimental client-ui-stats 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/client-ui-stats/README.md)

借鉴点：从完整持久化事件日志折叠统计、避免只统计当前已加载消息窗口、工具调用结果配对、按 Session 统计。现有官方统计页不等于本需求的跨工作区能力使用分析页，需新增聚合索引。

### 插件设置页面

- [DSH 插件管理页面扩展机制](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.zh.md)
- [DSH Settings 配置服务](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings/README.md)
- [DSH Settings Plugins 子页面机制](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings-plugins/README.zh.md)
- [DSH Agent Loop 设置页示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings-agent-loop/README.zh.md)

借鉴点：复用插件配置 slot、标准配置表单、暂存/保存/重置、配置 revision 冲突处理和本地化。

### 工作区与会话

- [DSH Workspace 子系统中文文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/workspace.zh.md)
- [DSH Session 子系统中文文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.zh.md)

借鉴点：用 DSH 正式 Workspace / Session ID 归属统计，不以工作目录字符串或当前页面状态代替正式会话归属。

---

## 12. 最终完成定义

只有下面条件全部有实际证据，才能宣布 vNext 完成：

1. 正常任务不再因 Step、Tool 数量或执行时长达到旧阈值而被插件停止。
2. 相同调用、交替循环和无进展检测可以提醒，且不会频繁误伤正常任务。
3. 确认循环时只阻止必要的重复动作，不会把整个任务直接杀掉。
4. 插件设置中存在独立的调用统计子页面。
5. 能按当前会话、当前 Workspace 可确认映射、全部可访问会话查看 MCP、可观察 Skill、owner 已确认的 Plugin Tool 及 Unknown 的调用次数；覆盖缺口可见。
6. 7 / 15 / 30 天统计口径正确，历史覆盖范围明确。
7. 满足完整观察条件的 30 天 0 调用能力会出现“建议禁用”，但不会自动修改任何配置。
8. `meta_invoke`、MCP、PTC / 内部调用、并行调用的去重与归属有隔离测试证据；公开事件未持久化或未能关联的路径须显示 coverage gap，剩余限制显式标注，不以推断补齐。
9. 不保存完整消息、工具参数、工具输出或任何 MCP 凭据。
10. 与 Token Saver、MCP Connector、Context、Cost Meter、Mnemon 共存正常。
11. Windows 11 实际 DSH profile 和 GUI 验收完成。
12. 交付源码、测试、构建结果、中文 README、配置迁移与回滚说明。

**最终产品原则：不以执行次数和时长限制 Agent，而是用尽量少的额外 Token 识别无意义循环；通过真实调用数据找出长期不用的能力，让用户自己决定哪些能力应该保留、按需或禁用。**
