# dsh-agent-efficiency-guard

## 当前实施方案与状态

> **文档用途：** 记录当前已实现的插件方案、验证证据和明确未完成项。`plugin/src/`、`plugin/cordis.patch.yml` 与 `plugin/tests/` 是实现事实的来源；历史设计目标不能覆盖当前代码证据。
>
> **目标形态：** 一个可独立安装、维护和卸载的 DSH 插件包，整合 Agent 效率守卫与能力目录/检索/调用，不依赖原 `@daweifu/capability-menu`。
>
> **包名 / 内部名称：** `dsh-agent-efficiency-guard` / `agent-efficiency-guard`
>
> **目标宿主：** DSH。插件使用 DSH 插件公开接口，不接管宿主的模型、Provider、推理强度、完整会话或模型 Token 预算。
>
> **文档更新：** 2026-11-03

### 当前状态

- 包版本仍为 `0.1.8`；GitHub `v0.1.8` 是已发布基线，本地工作树包含未提交的后续改动，尚未发布。
- 已实现能力目录、`meta_search` / `meta_invoke`、Resident / On-demand / Disabled 策略、能力菜单和 Agent/Turn Guard。
- 当前默认 `stepLimitMode: warn-only`：`hardSteps` 只在显式 `hard-stop` 模式下硬拒绝；工具数、时长和无进展保护仍有硬停止。
- 工具准入会预占并发额度；结果返回后转换为已完成调用数。`duplicateHardBlock` 可显式启用，默认关闭。
- 本地类型检查、14 个测试文件 / 206 项、构建和 `npm pack --dry-run` 已通过。
- 生产 GUI 直接检查返回 `401 Unauthorized`；用户报告已重启并启用插件，但本地运行态、超过旧步数上限后的宿主行为尚未独立验证。
- Guard 配置页、实时预算统计、硬限制后的专用最终总结步尚未实现；`meta_invoke` 内层计数与无结果事件时的预占释放仍需运行态验证。

---

## 0. 维护规则

后续工作必须从现有仓库、源码、测试和当前 DSH 公开 API 开始，不得按本任务书历史阶段重建插件；先核对顶部“当前状态”，再区分已实现、待验证和未来建议。

执行原则：

1. **先审计，后改动。** 不要直接修改用户正在使用的 DSH profile，不要先卸载或覆盖现有插件。
2. **以实际安装的 DSH API 为准。** 从本机已安装包的类型定义、官方源码和实际 profile 验证 hook / API；不要根据旧示例猜接口。
3. **完整交付。** 至少完成可构建的 TypeScript 插件、默认配置、Cordis bundle patch、测试、中文 README、迁移和回滚说明。
4. **不做无关重构。** 不修改 DSH 核心，不修改 Token Saver、MCP Connector、其他已安装插件，不顺便重做整个桌面客户端。
5. **安全优先。** 任何权限、预算或目录状态不确定时，采用不扩大权限的行为；不得静默放行 Disabled 能力。
6. **不把未完成说成完成。** 每项验收给出实际命令、结果和未通过项；不能运行的测试需明确标注原因。

### 0.1 开工检查

至少执行并记录：

```powershell
node --version
npm --version
dsh --version
dsh --profile desktop --dump-config
```

检查以下位置（路径按实际 DSH_HOME 和 profile 调整）：

- `C:\Users\yansui\.dsh\profiles\desktop\package.json`
- `C:\Users\yansui\.dsh\cordis.patch.yml`
- `C:\Users\yansui\.dsh\profiles\desktop\cordis.patch.yml`
- `C:\Users\yansui\.dsh\capability-menu-policy.json`
- 现有插件实际安装目录、依赖版本与运行时加载状态

**注意：** 用户提供的清单只说明 22 个第三方直接依赖及其启动声明；启动声明不等于已确认运行时成功加载。必须检查 profile patch 和 DSH 实际 dump 结果，不能仅依据清单判断插件状态。

---

## 1. 项目背景与最终决策

用户当前的 DSH 插件环境包含以下关键组件：

| 现有组件                       | 当前清单版本 | 新插件中的处理方式                         |
| -------------------------- | -----: | --------------------------------- |
| `@daweifu/capability-menu` |  0.1.7 | **核心功能迁移并重实现**，新插件不依赖它            |
| `dsh-plugin-save-token`    |  2.4.1 | **继续独立保留**，不合并、不重复造轮子             |
| `dsh-mcp-connector`        | 0.2.87 | **继续独立保留**，新插件与其协作，不接管 MCP 连接生命周期 |
| `dsh-context`              | 0.78.2 | 保留，作为上下文诊断工具；新插件不重复制作完整上下文仪表盘     |
| `dsh-cost-meter`           | 1.9.46 | 保留，负责真实 Token/费用统计；新插件只记录自身执行治理指标 |
| `dsh-mnemon`               | 0.5.37 | 保留，记忆系统不属于本插件职责                   |
| `dsh-ops`                  |  0.4.4 | 保留，继续提供文件/命令工具                    |
| `@dickpy/dsh-imagegen`     | 1.11.0 | 保留，生图画布和工作流不由本插件接管                |
|                            |        |                                   |

### 1.1 为什么做成一个新插件

原 Capability Menu 的能力目录、策略投影、`meta_search` / `meta_invoke` 与 Agent 预算治理高度相关：它们共同决定 Agent **知道什么、能调用什么、何时应该停止继续探索**。继续依赖原插件意味着关键能力分散在两个包、两套配置和两处维护逻辑中。

因此采用：

> **一个插件包、一个能力策略源、一个 Agent 执行状态、两类模型控制工具、一个管理面板。**

模块内部仍分层，不能把所有逻辑堆进一个巨型文件。

### 1.2 不合并 Token Saver 的原因

`dsh-plugin-save-token` 已经负责工具输出的结构化压缩、无损优先编码、原文落盘和可逆展开。它处于工具结果处理链路；新插件负责 Agent 的能力暴露和执行治理。两者是互补关系，不应复制输出压缩或历史压缩代码。

新插件不得：

- 再实现一套工具结果压缩、TOON 编码或原文恢复机制；
- 默认改写历史消息或触发上下文压缩；
- 接管 `save_token_expand`；
- 为了做统计而长期保存工具参数、完整工具输出或用户消息。

### 1.3 不合并 MCP Connector 的原因

`dsh-mcp-connector` 已负责 MCP Server 连接、认证、工具发现、治理规则及按会话工具激活。新插件不应再实现一套 MCP 连接管理或 OAuth/API Key 管理。

新插件只把当前 DSH 运行时中已注册、当前 Agent 有权访问的 MCP Tools 纳入统一能力目录，并提供按需暴露策略。若 MCP Connector 对某条连接启用了“按会话启用”，其 Host 级会话限制优先；新插件不得绕过或覆盖该限制。

---

## 2. 产品目标与非目标

### 2.1 当前实现与明确缺口

1. 能力目录覆盖当前 Agent 可见范围内的 DSH 原生工具、MCP 工具和技能；实际索引范围受 DSH Provider/Session 权限约束。
2. Resident / On-demand / Disabled 三档策略参与 Prompt 投影；Disabled 必须在执行入口拒绝。
3. `meta_search` 提供能力检索与详情；`meta_invoke` 提供受当前 Agent scope 约束的工具执行/技能加载入口。
4. Guard 按 Agent / Turn 跟踪模型步骤、业务工具数、重复调用、时长和可观察的无进展状态。
5. 默认步数模式为 `warn-only`：到 `softSteps` 发一次收敛提示，达到 `hardSteps` 不会硬停。只有显式 `stepLimitMode: hard-stop` 才按 `hardSteps` 拒绝下一步。
6. 工具数与时长仍有硬保护；工具额度在准入时包含并发预占，结果返回后计入完成数。无进展保护在一次收敛 steer 后，连续达到配置次数才阻止下一步。
7. 重复工具签名默认提醒；`duplicateHardBlock: true` 时可在工具准入阶段阻断重复调用，默认关闭。
8. 当前设置 UI 管理能力目录、策略、MCP/技能来源和检索元数据；没有 Guard 专属配置页、实时预算统计或历史趋势面板。
9. Guard 不读取模型隐藏思维链，不统计模型 Token、上下文窗口或费用；模型/Provider/推理强度由 DSH 设置负责。
10. 原 Capability Menu 策略迁移、生产 Electron 热重载、当前宿主完整运行验收不能只凭本地单测宣称完成；状态见本文件顶部和 `plugin/HANDOFF.md`。

### 2.2 明确不做的功能

以下内容不得纳入本期实现：

- 动态安装、卸载、启动、停止 npm 插件；
- 在 Agent 运行中动态加载任意 Cordis 插件；
- MCP Server 的连接、认证、凭据编辑、传输进程管理；
- 重新实现 Skills 文件系统 Provider、GitHub Skill 下载器或技能编辑器；
- OMP / ACP / RPC 子 Agent 桥接；
- 自动切换模型、Provider 或 reasoning effort；
- 自动重写完整对话历史、自动摘要或自动压缩上下文；
- 复杂计划系统、DAG、任务画布、自动重试编排器；
- 以关键词自动激活 MCP 工具或自动提升权限；
- 记录完整用户消息、完整工具参数、凭据或工具输出用于统计。

**术语边界：** 插件不是一个可直接调用的 Capability。插件注册的 Tools 与 Skills 才是能力目录中的项目。新插件可以按需暴露已注册的 Tools / Skills，但不能把“按需调用”宣传成“按需加载整个插件”。

---

## 3. 总体架构

```text
                         DSH Agent / 当前 Agent Scope
                                      │
                  ┌───────────────────┴───────────────────┐
                  │                                       │
           Capability Registry                     Efficiency Guard
                  │                                       │
      ┌───────────┼──────────┐               ┌────────────┼────────────┐
      │           │          │               │            │            │
   Native       MCP       Skills          Step Budget  Tool Budget  Time Budget
   Tools       Tools      Registry             │            │            │
      │           │          │               └────────────┼────────────┘
      └───────────┴──────────┘                            │
                  │                                  Repeat Detector
           Policy Projection                               │
       Resident / On-demand / Disabled                      │
                  │                                         │
        ┌─────────┴──────────┐                         Hook Enforcement
        │                    │                              │
   meta_search          meta_invoke                pre-step / guard /
        │                    │                     ctx.tools.guard() / tools/result / turn-stopping
        └─────────┬──────────┘                              │
                  │                                         │
            Tool Execute / Skill Load  ◄─────────────────────┘
                  │
         DSH 原生执行与权限管线
                  │
        ┌─────────┴──────────┐
        │                    │
   dsh-mcp-connector   dsh-plugin-save-token
   MCP 连接/会话权限     结果压缩/原文恢复
```

### 3.1 模块划分

当前源码职责：

```text
src/
  index.ts                 # 聚合插件入口
  registry.ts              # 能力索引
  search.ts                # meta_search
  invoke.ts                # meta_invoke
  policy.ts                # 能力策略与 Prompt 投影
  policy-state.ts          # 策略状态
  guard-core.ts            # Agent/Turn 预算和循环保护
  guard.ts                 # DSH Hook 接线
  locations.ts              # MCP/Skill 来源管理
  patch-file.ts             # Cordis patch 配置读写
  host-face.ts              # Typert host contract
  client/                   # 能力菜单客户端
  server/                   # 远程接口与自更新
  tests/                    # Vitest 单元测试
```

旧版将 `capability/`、`guard/` 拆成子目录的示例树已由以上实际布局取代。

### 3.2 当前配置与状态边界

- `cordis.patch.yml` 声明插件 bundle、能力策略默认值和 Guard 配置；用户配置不复制进源码。
- 能力策略覆盖由本插件状态服务持久化；Guard 按 Agent / Turn 将运行计数保存在内存，不写完整对话或工具结果。
- 注册 MCP/Skill 来源时由插件的 patch/location 接口更新对应配置；不得直接改写 DSH 私有状态或其他插件数据。
- 当前没有已验收的旧 Capability Menu 策略自动迁移。迁移前必须备份、保持来源文件不变，并单独验证回滚。

---

## 4. 能力目录与策略系统

### 4.1 Capability 数据模型

统一概念：`Capability = Tool | Skill`。

建议字段：

```ts
interface CapabilityRecord {
  id: string;                    // Tool 全名或 Skill 名称
  kind: 'tool' | 'skill';
  name: string;
  description: string;
  summary: string;               // 搜索列表用的短说明
  provider: string;              // MCP server / built-in / Skill 来源
  source?: string;               // Skill source
  path?: string;                 // 只用于本机面板展示，注意脱敏
  tags: string[];
  parameters?: JsonSchema;       // Tool schema；Skill 不需要
  policy: 'resident' | 'on-demand' | 'disabled';
  invocation: 'execute' | 'load';
  available: boolean;
  stats: {
    uses: number;
    successes: number;
    failures: number;
    totalMs: number;
    lastUsedAt?: number;
  };
}
```

具体类型必须以当前安装 DSH 的类型定义为准，不要直接照抄示例类型。

### 4.2 索引范围

必须支持：

- **DSH 原生工具：** 如 `bash`、`read`、`write`、`edit`、`read_image`、`glob`、`grep` 等；名称保持 DSH 实际注册名。
- **MCP 工具：** 使用 DSH 实际注册的完整 public name，例如 `mcp__server__tool`，不能自己重命名后再执行。
- **Skills：** 通过 DSH `ctx.skills` 及其 Provider 获取当前可用技能；支持项目、用户、预设和已挂载自定义来源（以当前版本 API 实际提供的范围为准）。

排除项：

- 新插件自己的 `meta_search`、`meta_invoke`；
- DSH 保留的 `run_code` 执行传输入口；
- 不属于当前 Agent Scope、不可模型调用或已失效的能力。

同名 Tool 和 Skill 通过 `kind` 区分，不能只用裸名称作为全局唯一键。索引应监听能力注册变化或在安全的边界刷新；不得每次模型请求都全量扫描磁盘或重新连接 MCP Server。

### 4.3 三档暴露策略

| 策略             | Agent Prompt 中表现                    | 搜索结果  | 调用规则                                       |
| -------------- | ----------------------------------- | ----- | ------------------------------------------ |
| `resident` 常驻  | Tool Schema 常驻；Skill 名称和简介可见        | 不要求搜索 | Tool 可直接调用；Skill 可通过 DSH 原有 Skill 机制加载     |
| `on-demand` 按需 | 不直接注入完整 Tool Schema；Skill 不进入常驻可用列表 | 可检索   | 通过 `meta_search` 找到，再用 `meta_invoke` 执行或加载 |
| `disabled` 禁用  | 不暴露                                 | 不可搜索  | 无论直接工具调用还是 `meta_invoke`，都必须拒绝             |

**默认策略：未命中的能力默认为 `resident`。** 这样升级插件时不会静默隐藏已有工具，用户可逐步把低频工具调整为按需。默认值可配置，但不得在升级时自动改变旧策略。

### 4.4 规则优先级

沿用已验证的明确优先级，避免通配规则无意覆盖精确规则：

1. Disabled 精确规则
2. Disabled 通配规则
3. Resident 精确规则
4. On-demand 精确规则
5. Resident 通配规则
6. On-demand 通配规则
7. 未命中：Resident

Disabled 是硬性拒绝，优先级高于 Resident；强制常驻工具（`meta_search` / `meta_invoke`）始终可用，不允许被规则禁用。

支持按 Tool ID、MCP Server、Skill 名称和必要的来源分组规则。UI 必须说明策略冲突原因，不能出现“用户选了按需但实际上仍然常驻”的静默状态。

### 4.5 Prompt 投影与实际执行边界

- Resident Tool：留在 DSH 正常工具可见集合。
- On-demand Tool：仅从模型当前可见的工具 Schema 投影中隐藏，仍允许新插件内部通过 DSH 官方执行管线按精确 ID 调用。
- Disabled Tool：从可见集合隐藏，并在实际执行入口再次拒绝。
- Skill：按 DSH 技能 API 和 Prompt 组装机制，正确控制常驻列表和按需加载。

**不得用单纯的前端隐藏实现策略。** 必须保证实际执行时同样执行策略检查。

使用 DSH 官方 `system-prompt/assemble`、Agent Scope、`ctx.tools` 和 `ctx.skills` 扩展点时，必须按实际 DSH 版本校验签名和调用顺序。对于 Disabled 规则，应同时覆盖普通工具调用、`meta_invoke` 转发以及 PTC / `run_code` 内部工具调用路径（以 DSH 官方执行管线是否覆盖为准）；不能覆盖的路径要明确列为限制，不得虚假宣称绝对拦截。

### 4.6 `meta_search`

只保留一个统一检索控制工具，支持：

- 列表：按关键词、类型、Server、Tag 搜索；
- 详情：对某个精确 `id + kind` 返回完整说明与 Tool 参数 Schema；
- 分页：限制默认结果数量，支持 offset / max results；
- 结果截断：明确告诉模型结果被截断，并提示缩小查询；
- 范围：只搜索当前 Agent 可用范围内的按需能力；Disabled 不应出现在模型搜索结果中。

建议默认 `max_results=20`，上限 100。搜索列表只返回短摘要，不要一次把所有 Tool Schema 塞回 Prompt。

### 4.7 `meta_invoke`

统一执行工具和加载技能：

```ts
meta_invoke({
  id: 'mcp__server__tool',
  kind: 'tool',
  args: { /* 原始结构化参数 */ }
})

meta_invoke({
  id: 'some-skill',
  kind: 'skill'
})
```

要求：

- 必须使用精确 `id` 和 `kind`，禁止从模糊字符串猜测目标。
- Tool 使用 DSH 官方 `ctx.tools.execute()` 管线转发，保留调用 Agent、signal、parent / call lineage、callId 归因和执行结果语义。
- 不得直接 import MCP SDK 后绕过 DSH 执行管线。
- 必须在执行前再次检查 `disabled`、Agent Scope 和工具当前可用性。
- Skill 通过 DSH `ctx.skills` 加载，返回正确的 Skill 内容，不执行 Skill 中可能存在的脚本。
- 使用 `WeakMap<Agent, Set<SkillId>>` 或等价的 Agent 生命周期安全机制避免同一会话重复注入完整 Skill 内容；支持 `force: true` 明确重载。
- 对同一 Agent 内已加载 Skill 的重复请求，只返回短提醒，不再次注入全文。
- `meta_search` / `meta_invoke` 是本插件唯二默认常驻的模型控制工具；不要增加一堆低价值的模型可见管理工具。

### 4.8 MCP Connector 协作规则

这是必须严格遵守的集成约束：

1. MCP Server 连接、OAuth/API Key、stdio / HTTP 生命周期继续归 `dsh-mcp-connector` 和官方 MCP Client 管理。
2. 新插件只读取已注册 MCP Tool 的 schema 和来源；绝不保存 MCP 凭据。
3. 当 MCP Connector 对连接使用 **Always** 模式时，新插件可以正常对相应 Tool 应用 Resident / On-demand / Disabled。
4. 当 MCP Connector 使用 **Session** 模式时，连接级会话激活规则和 Host `tools.restrict()` / `tools.guard()` 是上层约束。新插件不得解除、覆盖或绕过它们。
5. 如果工具因 MCP Connector 的当前会话限制而不可用，`meta_invoke` 必须返回清楚的不可用错误，并建议先通过 `mcp_connector_session_tools` 查看状态、搜索、预览并由用户明确确认激活；不得偷偷替用户激活。
6. 不复制 MCP Connector 的会话激活 UI、OAuth、连接治理、连接诊断和工具试运行功能。
7. 不要把“按需能力目录”与“MCP Server 延迟启动”混为一谈。On-demand 只控制 Agent 暴露和调用入口，不代表 MCP Server 进程按需启动。

---

## 5. Agent Efficiency Guard

### 5.1 预算统计原则

**模型步骤（Step）和工具调用（Tool Call）必须分开计数。** 一个模型步骤可以并行产生多个 Tool Calls；不能把一个并行工具批次误算成多个模型步骤。

建议按每个实时 Agent、每个 Turn 单独维护状态。可使用 `WeakMap<Agent, TurnState>` 或 DSH 提供的等效生命周期机制；不能使用全局单一计数器，否则多个会话会互相污染。

每个 Turn 至少记录：

```ts
interface TurnState {
  readonly turn: number
  readonly startedAt: number
  readonly repeatedSignatures: Map<string, RepeatRecord>
  readonly pendingToolSignatures: Map<string, number>
  modelSteps: number
  businessToolCalls: number
  pendingToolCalls: number
  softWarningSent: boolean
  finalizationHintSent: boolean
  convergenceSteers: number
  noProgressCycles: number
  duplicateWarningSent: boolean
  progressSinceStop: boolean
  hardStopped: boolean
  lastActivityAt: number
  lastProgressFingerprint?: string
}
```

实际字段按 DSH 运行时事件调整。Turn 结束、取消、Agent dispose、插件卸载时必须清理计时器和监听器。

### 5.2 预算类型

必须提供四类守卫：

| 守卫 | 计数对象 | 作用 |
|---|---|---|
| Step Budget | 已准入模型步骤 | 防止 Agent 长时间重复思考或无止境探索 |
| Tool Budget | 实际业务工具执行次数 | 防止持续搜索、反复读取、反复执行动作 |
| Time Budget | 单轮持续时间 | 防止单任务长时间无进展 |
| Repeat Detector | 同一 Tool + 同一规范化参数签名 | 识别重复调用、提醒 Agent 停止重复工作 |

不要把 `agentOptions.maxTokens` 当作步骤预算；它是单次模型请求的输出 Token 上限。不要把 `maxParallelToolCalls` 当作整轮工具调用上限；它只限制单批并发。

### 5.3 内置预设

为减少配置负担，提供三个预设：

| 预设 | 软步骤提醒 | 硬步骤（仅 `hard-stop`） | 软工具提醒 | 硬工具限制 | 软时长 | 硬时长 |
|---|---:|---:|---:|---:|---:|---:|
| `quick` 快速 | 3 | 5 | 6 | 8 | 2 分钟 | 4 分钟 |
| `normal` 标准（默认） | 5 | 8 | 9 | 12 | 5 分钟 | 8 分钟 |
| `deep` 深度 | 10 | 14 | 18 | 25 | 12 分钟 | 20 分钟 |

默认 `stepLimitMode` 为 `warn-only`：超过软步骤只提醒，超过 `hardSteps` 仍允许继续。只有显式设置 `stepLimitMode: hard-stop` 才会按表中硬步骤阈值拒绝下一模型步骤。工具和时长硬限制不受此设置影响。

这些是当前内置默认值，不是对所有模型/任务的最优保证；目前没有按模型 ID 自动分档，也没有依据 Token 用量动态调节。`softSteps < hardSteps` 仍由 schema 校验，主要用于可选硬停止模式。

建议普通任务使用 `normal`；需要多轮检索或复杂排错时使用 `deep`。不要用 `quick` 限制复杂任务。

### 5.4 软预算行为

达到任意软阈值时：

1. 只发出一次明确提醒，不要每个步骤重复注入提示。
2. 通过当前 DSH 版本支持的 Agent 注入 / steer / turn-stopping 机制，让 Agent 知道剩余预算有限。
3. 提醒内容应要求：停止非必要探索、复用已经得到的结果、完成当前目标、对未验证事项明确标注，最后给出简洁总结。
4. 不要把软预算等同硬拒绝；除非配置明确要求，软阈值不应直接拒绝正在进行的工具调用。
5. 对模型已经生成的并行工具批次，不要中途篡改工具参数或只执行部分批次。

提示文本建议：

> 本轮执行预算即将用尽。请停止扩展搜索范围，优先使用已有证据完成用户当前目标；必要的最后一次验证之后请直接总结。未完成或未经验证的部分必须明确说明，不要伪造完成状态。

### 5.5 当前硬限制行为与缺口

当前实现的硬限制如下：

- 默认 `stepLimitMode: warn-only`，`hardSteps` 不会拒绝下一模型步骤；显式设为 `hard-stop` 才会启用硬步数限制。
- 达到硬工具数或硬时长后，Guard 标记当前 Turn 为 `hardStopped`，拒绝后续步骤/工具；已经派发的工具不会被中断或改写。
- 无进展保护在一次收敛 steer 后，根据连续无进展周期决定是否拒绝下一步骤。
- Guard 不伪造最终总结，也没有“硬限后放行一次仅用于总结”的专用收尾状态；因此工具数/时长硬停止仍可能让任务没有自然的最终答复，这是当前设计缺口。
- 没有独立的 Guard 状态 UI 通知；拒绝原因通过工具错误和日志暴露。不得声称已提供完整预算面板或用户可见统计。

**后续建议：** 为工具/时长硬限制设计一次 finalization-only 收尾步骤：拒绝新增业务工具，但允许模型读取既有结果并输出未完成说明。实现前需验证 DSH 公共 Hook 能可靠区分该状态，且不能绕过 Disabled 或审批规则。

### 5.6 重复调用检测

对当前 Agent 当前 Turn 中的工具调用创建稳定签名：

```text
signature = hash(toolName + canonicalJson(normalizedArguments))
```

规则：

- 默认在重复阈值达到 2 时提醒 Agent；相同参数按规范化 JSON 计算 SHA-256 签名，不持久化原始参数。
- 默认 `duplicateHardBlock: false`，重复读取、轮询和状态检查仍可继续。
- 当前已支持显式 `duplicateHardBlock: true`：在工具执行准入阶段拦截达到阈值的重复签名，不把单次重复直接升级成整个 Turn 的硬停止。
- 是否启用硬拦截应按工具风险配置；对合法轮询、用户确认或状态可能变化的读取操作保持关闭。
- `meta_search` / `meta_invoke` 外层是控制面调用，不计入业务工具额度。内层目标工具的具体计数路径列为待验证，不预设重复或漏计。

### 5.7 工具调用计数口径

当前计数口径：

- 普通工具在 `ctx.tools.guard()` 准入时预占额度，检查 `businessToolCalls + pendingToolCalls`，以防并发调用同时越过上限。
- 对应 `tools/result` 到达后释放匹配签名的预占，并计入已完成工具数；错误结果也作为一次已执行调用观察。
- `meta_search` / `meta_invoke` 外层控制面调用不计入业务工具额度。
- `meta_invoke` 内层目标是否再次经过 Guard 的公开执行链、取消或异常时是否总能收到 `tools/result`，尚未做运行态验证；不能在没有证据时宣称内层目标恰好计一次或预占必然释放。
- 当前没有独立 Skill 预算；技能加载路径是否计入工具数取决于 DSH 实际执行事件，尚无独立验收结论。
- 并行执行的普通工具由 pending 预占覆盖；内部重试、sub-agent 和宿主侧重试的精确计数仍需按公开 DSH 事件验证。

### 5.8 DSH Hook 映射

优先使用 DSH 已公开、当前版本确实存在的扩展点：

| Hook / API | 当前用途 | 当前边界 |
|---|---|---|
| `agent/pre-step` | 初始化/切换 Turn、检查时长/无进展/可选硬步数，并在放行后计步 | 默认 `warn-only`，不能把 `hardSteps` 描述成默认拒绝 |
| `agent/turn-stopping` | 根据进展与收敛状态执行一次 steer，并检查无进展周期 | 不读取隐藏思维链；不保证产生最终回答 |
| `ctx.tools.guard()` | 检查硬工具数/时长/重复硬拦截，并预占并发额度 | 普通工具执行入口；meta 控制面工具在 Guard 中跳过 |
| `tools/result` | 释放匹配 pending 预占、记录调用签名/结果指纹、软提醒 | 依赖 DSH 对错误/取消结果的事件行为，取消无结果路径未验收 |
| `agent/disposed` | 清理 Agent 的 WeakMap 状态 | 具体生命周期仍以 DSH 当前公开 API 为准 |

不得使用已弃用的 `agent/request` 新增功能。不得修改 DSH 核心 Agent Loop。

### 5.9 预算与工具拒绝的用户反馈

拒绝结果必须可理解、可恢复，例如：

- `Capability disabled by policy: <id>`
- `Tool budget reached for this turn. Use existing results and summarize.`
- `Step budget reached. The current task may be incomplete.`（仅显式 `stepLimitMode: hard-stop` 时适用）
- `Tool is not available in this Agent scope; check MCP Connector session activation.`

不要返回模糊的 `UNKNOWN_TOOL`，掩盖本插件自己的拒绝原因。

---

## 6. 当前客户端 UI 与后续设计

### 6.1 当前已实现

- 能力页提供 Tools / Skills 分类、名称/分组/正则筛选、状态计数和折叠分组。
- 可查看 Tool 详情；Skills 按全局、项目、预设分类，支持目录/文件预览。
- Resident / On-demand / Disabled 可在能力行上切换；支持策略与按需检索目录查看、检索描述编辑和能力诊断。
- 提供 MCP/技能来源登记与编辑入口、技能管理以及版本更新流程。
- 当前没有 Guard 专属预算配置页、当前 Turn 实时统计、历史趋势或按模型 profile 设置。不要把旧设计稿中的这些目标写成已交付能力。

### 6.2 后续界面优化建议（未实现）

- 能力菜单顶部采用紧凑筛选栏；桌面端可评估来源/服务器侧栏加高密度能力列表，详情放抽屉；移动端保持单列折叠布局。
- 策略控件明确显示常驻/按需/禁用，并显示生效规则来源、优先级和通配规则覆盖。
- Guard 独立设置页先展示当前 profile、`stepLimitMode`、软提醒/硬限制阈值和停止原因；任何统计都标成 Step / Tool / Time，不伪装成 Token 或费用。
- 批量规则编辑、预算历史图表、使用次数和成功率统计均需单独设计、实现和验收，目前不在已有能力中。

### 6.3 安全和职责约束

- 不展示完整 MCP 凭据、Header、OAuth Grant 或敏感参数。
- Tool Schema 详情可读但默认折叠；大列表需避免无界渲染。
- UI 不承担唯一权限检查，实际工具执行仍由服务端策略/Guard 决定。
- 不复制 MCP 连接凭据管理、技能下载器、Token 费用仪表盘或上下文可视化大盘；分别由 DSH/MCP Connector、技能管理能力或宿主负责。

---

## 7. 当前配置规范

能力策略与插件 bundle 以 `plugin/cordis.patch.yml` 为准；Guard 配置位于 root entry 的 `config.guard`。以下仅示意当前 Guard 语义，不替代实际 patch：

```yaml
guard:
  enabled: true
  profile: normal
  stepLimitMode: warn-only
  duplicateDetection: true
  duplicateWarnAfter: 2
  duplicateHardBlock: false
  profiles:
    quick:
      softSteps: 3
      hardSteps: 5
      softToolCalls: 6
      hardToolCalls: 8
      softDurationMs: 120000
      hardDurationMs: 240000
    normal:
      softSteps: 5
      hardSteps: 8
      softToolCalls: 9
      hardToolCalls: 12
      softDurationMs: 300000
      hardDurationMs: 480000
    deep:
      softSteps: 10
      hardSteps: 14
      softToolCalls: 18
      hardToolCalls: 25
      softDurationMs: 720000
      hardDurationMs: 1200000
  hostIntegration:
    maxConvergenceSteersPerTurn: 1
    maxNoProgressCycles: 2
    loopBreakMode: stop-next-step
```

`hardSteps` 始终保留在 profile 中用于阈值验证和可选硬停止；默认 `stepLimitMode: warn-only` 不会执行该硬上限。当前不支持把模型 ID 映射到不同 profile，也没有 Token/费用预算字段。

### 7.1 校验与配置边界

- `stepLimitMode` 仅接受 `warn-only` 或 `hard-stop`。
- `softSteps < hardSteps`、`softToolCalls < hardToolCalls`、`softDurationMs < hardDurationMs`；所有阈值必须是正安全整数。
- `duplicateHardBlock` 默认关闭；设置为 true 才启用重复签名硬拦截。
- `hostIntegration` 是历史配置组名；当前实际消费的是收敛 steer 次数、无进展周期和 loopBreakMode。provider、Token Saver / Prompt Cache 偏好和 enabled 标记没有运行逻辑，不应视为可用集成开关。
- 本插件没有经验收的旧 Capability Menu 自动迁移；不要在配置中宣称迁移已启用。
- 用户显式禁用 Guard 时必须如实显示状态；当前客户端没有专用 Guard 状态面板，此项仍是 UI 待办。
- DSH 系统保留工具不得被策略配置误禁用；以当前策略实现和测试为准。

---

## 8. 兼容性、性能与可靠性要求

### 8.1 版本兼容

- 开发第一步必须识别本机实际 DSH 版本。
- `peerDependencies` 只声明已验证兼容的 DSH 版本范围；不要盲目写宽泛 `*`。
- 如果需要兼容多个 DSH 版本，把差异封装成 adapter，并做版本契约测试。
- 没有测试的版本不标注“支持”。

### 8.2 Windows 与路径

- 以 Windows 11 + Node.js 实际用户目录为主要验证环境。
- 所有本地路径使用 `node:path` / `fileURLToPath` 等跨平台 API，不硬编码斜杠或用户名。
- 状态文件写入使用安全原子流程；处理文件被占用、权限不足、突然退出等情况。
- 不用 POSIX shell 假设实现核心逻辑。

### 8.3 性能

- Agent 每步的策略判断应是内存查表级别；避免每轮全量重扫磁盘。
- `meta_search` 采用已构建索引，关键词搜索不能扫描完整原始文件内容。
- 不在每次模型请求中重复构建完整 Tool Schema 列表。
- 统计采用有上限的内存环形记录；持久化只保存必要计数和策略，不保存原始对话与敏感参数。
- 不能因为打开设置页才初始化昂贵后台任务；插件启动时仅做必要注册。
- 无能力目录变化时，不重复触发大量 `system-prompt/assemble` 重建。

### 8.4 缓存与 Prompt Cache

- 不对完整历史做重写或压缩。
- 不在每个步骤随机改变系统提示词顺序或注入不断变化的大型统计块。
- 软预算提示每轮最多一次，内容尽可能短。
- `meta_search` 列表只输出摘要；需要时才请求详情 Schema。
- 不要为了“节省 Token”增加频繁的模型路由判断或自动总结调用。

---

## 9. 测试计划与验收标准

开发 Agent 必须提供自动化测试，不能只展示成功界面。

### 9.1 能力目录测试

- 原生 Tool、MCP Tool、Skill 均能发现和分类。
- 当前 Agent 不可见的工具不会被泄漏到其搜索结果。
- 同名 Tool / Skill 通过 kind 区分。
- `meta_search` / `meta_invoke` 始终可用且不会进入自身目录。
- `run_code` 不进入普通目录，也不会被误设为按需或禁用。
- Tool 注册变化后索引更新；删除的 Tool 不会继续出现在可调用列表。
- Skill 在不同 Provider / preset 下的来源正确，不能把另一个 Agent 的私有 Skill 泄漏出来。

### 9.2 策略和执行测试

- Resident Tool 可以按原 DSH 方式直接调用。
- On-demand Tool 不进入常规模型工具 Schema，但可通过 `meta_search` 精确发现和 `meta_invoke` 执行。
- Disabled Tool 在直接调用、`meta_invoke` 和适用的 PTC 内部调用路径均会被拒绝。
- Disabled Skill 无法搜索或加载。
- 精确规则、通配规则和 Disabled 优先级符合本文规则矩阵。
- Agent Scope / preset Scope 不会相互串数据。
- `meta_invoke` 保留 parent、signal、Agent、callId 归因，并经过原始 DSH 执行管线。
- Skill 重复加载不会重复注入全文；`force` 能重新加载。
- 被 MCP Connector 的 Session 模式隐藏的工具不能被新插件绕过。

### 9.3 Guard 测试

- 单个模型 Step 并行触发 4 个 Tools：Step 计数为 1，Tool 计数按实际业务执行数计算。
- 达到软步骤预算，只发送一次收敛提示。
- 达到软工具预算，只发送一次收敛提示。
- 默认 `warn-only` 下超过 `hardSteps` 后仍允许下一模型步骤；显式 `hard-stop` 下达到硬步数时下一模型步骤被拒绝。
- 达到硬工具预算，后续业务工具调用被拒绝。
- 超时后不留下持续运行的定时器；工具/Agent 取消后状态清理。
- 完全相同 Tool + 参数重复时提醒；默认不硬拒绝。
- 不同 Agent 的计数、重复指纹和计时器互不影响。
- 新 Turn 重新计数；旧 Turn 的重复状态不泄漏到新 Turn。
- `meta_invoke` 包装层 + 内部目标只计一个业务调用。
- 预算触发只报告实际行为，不虚构任务已完成。

### 9.4 插件共存测试

必须至少验证以下组合：

1. 新插件 + `dsh-plugin-save-token`：Token Saver 压缩、展开、去重和结果呈现保持正常；新插件不篡改其内容。
2. 新插件 + `dsh-mcp-connector` Always：可检索和调用连接中的工具，权限由 DSH / MCP Connector 继续控制。
3. 新插件 + `dsh-mcp-connector` Session：未激活工具不能通过 `meta_invoke` 绕过；激活必须经过 MCP Connector 用户确认流程。
4. 新插件 + `dsh-context` / `dsh-cost-meter`：没有重复注册冲突或统计污染。
5. 多 Agent 同时运行：预算与能力隔离正确。

### 9.5 Token 与效率验收

用固定工具集合做对照测试（至少 20、50、100 个能力条目）：

- 全部 Resident 时的工具 Schema 数量和估算 Token；
- 按需策略下首轮 Schema 数量和估算 Token；
- 搜索列表平均长度；
- Detail Schema 与 `meta_invoke` 的额外模型步骤数；
- Guard 引入的执行开销。

报告必须分别写明“上下文减少量”和“多次按需调用增加的步骤/Token”，不能只展示压缩比例。真实节省受模型、工具数量和任务命中率影响，不承诺固定百分比。

### 9.6 发布验收

- `typecheck` 通过；
- `build` 通过；
- `test` 通过；
- `npm pack --dry-run` 或等价打包验证通过；
- DSH profile 安装后实际加载成功；
- Windows 11 实际运行通过；
- 中文 README 的安装、配置、卸载、迁移、回滚步骤可执行；
- 提供已验证 DSH 版本、Node 版本和完整测试结果。

---

## 10. 迁移边界（当前状态）

- 当前代码没有经过验收的旧 Capability Menu 策略自动迁移器；不得在配置或交付说明中宣称已自动导入。
- 本地构建不会自动卸载旧插件、删除旧策略或切换生产 profile。用户需要自行备份并明确授权任何生产切换。
- 如未来实施迁移，必须先生成预览、保留来源文件、支持重复执行且不重复写规则，并提供可验证回滚；迁移期间不得同时注册两个同名 `meta_search` / `meta_invoke`。
- MCP Server 连接、认证凭据和 Skill 下载/目录管理不属于本插件的迁移职责。

## 11. 当前交付状态与后续工作

### 已实现

- 独立 DSH 插件包，包含能力目录、检索/调用、三档策略和能力菜单。
- Agent/Turn Guard，包含 Step 提醒、工具数/时长硬保护、重复调用检测和无进展循环保护。
- 默认步数行为已改为 `warn-only`；并发工具额度在准入时预占；重复硬拦截为 opt-in。
- 本地类型检查、14 个测试文件 / 206 项、构建和 `npm pack --dry-run` 均有通过记录。

### 未完成或未验证

- 活动宿主是否加载当前未提交构建、超过旧 `hardSteps` 后的真实 DSH 行为尚未独立确认。
- 工具取消/异常且没有 `tools/result` 的 pending 额度释放，以及 `meta_invoke` 内层目标的计数路径仍待验证。
- 硬工具数/时长触发后缺少一次“禁止新业务工具、允许最终总结”的收尾步骤。
- Guard 配置页、实时 Turn 统计和能力菜单布局优化尚未实现。
- 按模型 ID 自动选择 profile 未实现；只有 DSH 公开 API 稳定提供模型标识后才评估。模型内部 Token/推理强度不由本插件统计或调度。
- 原 Capability Menu 状态迁移与完整生产 Electron 热重载/权限验收尚未完成。

---

## 12. 当前交付与完成定义

### 当前本地交付

- 源码、Cordis patch、能力目录、策略、`meta_search` / `meta_invoke` 和 Guard 已在 `plugin/`。
- 当前本地 Guard 默认 `warn-only`，并发额度预占与 opt-in 重复硬拦截已有单测。
- 当前记录的本地检查：类型检查通过；14 个测试文件 / 206 项通过；构建通过；`npm pack --dry-run` 通过。
- 包版本仍为 `0.1.8`；本地后续改动未提交、未发布。GitHub `v0.1.8` 不包含这些后续本地修改。
- 活动 DSH 对本次构建的加载、超过 `hardSteps` 后继续、取消释放 pending 和内层 `meta_invoke` 计数尚未独立验收。

### 完成 Capability Menu 替代的额外条件

只有以下条件也有当前版本的证据，才可宣称完整替代旧 Capability Menu：

1. 目标 DSH profile 中常用 Native / MCP Tools / Skills 索引和三档策略运行正确；
2. Disabled 在实际执行入口有效，且没有绕过 DSH / MCP Connector 当前权限；
3. MCP Connector、Save Token 共存及 Agent/Turn 隔离具备对应版本的验收记录；
4. 原策略迁移已验证，或明确标注不迁移、需用户手动配置；
5. 目标 Windows DSH profile 冷启动、卸载/回滚通过；
6. 所有未实现和未验证边界仍在交付说明中可见。

当前本地单测和打包检查通过，不等于以上生产运行验收全部通过。

---

## 13. 开发参考资料

以下资料用于核对官方 API 和现有插件行为。实现时应优先阅读实际安装版本的类型定义；公开 `main` 分支可能比用户本机版本更新。

### DSH 官方扩展接口

- [DSH Agent API（中文）](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/README.zh.md) — Agent、Scope、`agent/pre-step`、`agent/turn-stopping`、Agent 生命周期。
- [DSH Tools 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md) — `ctx.tools`、`ctx.tools.execute()`、`ctx.tools.restrict()`、`ctx.tools.guard()`、`tools/pre-execute`、`tools/execute`、`tools/result`。
- [DSH Extension Cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.zh.md) — Cordis 插件和扩展点实践。

### 现有插件行为

- [原 Capability Menu 仓库](https://github.com/PKUfudawei/dsh-capability-menu) — 仅作为功能行为参考，不作为新插件运行时依赖。
- [Token Saver 仓库](https://github.com/vibe-any/dsh-plugin-save-token) — 了解输出压缩、原文恢复和 Hook 共存边界。
- [MCP Connector 仓库](https://github.com/duhu2000/dsh-mcp-connector) — 连接管理、会话工具激活与 Host 权限边界。
- [MCP Connector：按会话启用工具](https://github.com/duhu2000/dsh-mcp-connector/blob/main/docs/SESSION-TOOL-INJECTION.md) — 了解如何避免重复实现和权限绕过。

### 当前本机插件清单

以用户提供的 `dsh-plugin.md` 为本机直接依赖依据。该文件记载：`@daweifu/capability-menu@0.1.7`、`dsh-plugin-save-token@2.4.1`、`dsh-mcp-connector@0.2.87` 等 22 个第三方直接依赖；其中“已列入启动 bundle”并不等于已验证运行时加载成功。开发 Agent 必须在实际 profile 再次核实。

---

## 14. 最终产品原则

这是一个**轻量级 Agent 效率和能力治理插件**，不是一个新的 Agent 框架。

- 保留 DSH 原生执行管线，不绕过核心权限和审批。
- 常用能力直接可见，低频能力再按需搜索，危险或不需要的能力明确禁用。
- 让 Agent 在预算耗尽前主动收敛，而不是无限探索。
- 重复调用默认提醒，不以激进拦截换取表面效率。
- Token Saver 负责压缩输出，MCP Connector 负责连接和会话权限，本插件负责能力目录和执行预算。
- 默认配置少、界面清楚、日志可解释、迁移可回滚。

**最终只交付一个可独立安装的 `dsh-agent-efficiency-guard` 插件包。不要再拆成一个 Guard 插件和一个 Capability Menu 插件。**

