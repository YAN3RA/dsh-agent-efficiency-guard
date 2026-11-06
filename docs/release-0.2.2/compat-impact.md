# DSH 0.2.2-rc.1 API 兼容修复影响报告

插件：`dsh-thinking-guard` 0.1.9
目标宿主：`@deepseek-ai/dsh-*` `0.2.2-rc.1` + `@deepseek-ai/cordis` `4.1.0`
证据基准：`plugin/node_modules/@deepseek-ai/**` 已安装产物（类型 `.d.ts` 与实现 `lib/*.js`）。

---

## 1. 已修复

### 1.1 `ToolsService.execute` 批量契约迁移（原编译错误 A）

**破坏点。** 0.2.2 把 `ToolsService.execute` 从「单次调用」改成「整批调用」：

- `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:130` —
  `execute(input: ToolBatchInput): Promise<ToolBatchResult>`；
- `lib/types/executor.d.ts:16-45` — `ToolBatchInput` 只有
  `{ calls, signal, maxParallelToolCalls?, agent?, toolSet?, log? }`，**没有 `parent`**；
- `lib/types/executor.d.ts:52-56` — `ToolBatchResult` 是
  `{ results: { callId, result }[], additionalContexts, concluded }`，没有 `isError` / `content`。

旧代码在 `src/invoke.ts:243` 传 `{ callId, name, arguments, signal, parent, agent }`，
并在 `:251`/`:262` 直接读 `result.isError` / `result.content`，因此 tsc 报
`TS2353`（`callId` 不在 `ToolBatchInput`）、`TS2339`（`isError`/`content` 不在
`ToolBatchResult`）。

**修法。** 单次转发改走官方共享管线 `prepare → dispatch → complete`，与原生执行器同一条链路：

- 引入点：`src/invoke.ts:14` `import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'`
  （该子路径由 `dsh-tools/package.json` 的 `exports["./pipeline"]` 公开导出）。
- 管线实例：`src/invoke.ts:115-117`。
- 三步调用：`src/invoke.ts:278-289`；`prepare()` 的入参是 `ToolExecutionInput`，
  **仍然接受 `parent`**（`lib/types/contracts.d.ts:163-191`，`parent` 见 `:188`），
  所以 `parent: exec.token` 的 transport 血缘得以保留。
- `isError`/`content` 改从 `result`（即 `ToolExecutionResult`）读取：
  `src/invoke.ts:294-297`，字段定义见 `lib/types/contracts.d.ts:289-311`。
- 额外补齐：嵌套结果携带的 `additionalContexts` 与 `concludesTurn` 通过
  `exec.deferContext(...)` / `exec.concludeTurn()` 回传给外层 `meta_invoke`
  （`src/invoke.ts:292-293`），与官方 composite tool 的约定一致
  （`lib/types/contracts.d.ts:223-248`）。

**保留的语义。** `agent`、`signal`、`parent` 全部照旧传入（`src/invoke.ts:278-287`），
因此作用域、取消、`tools/result` 事件归属都不变。

### 1.2 `system-prompt/assemble` 不再拥有工具声明（原编译错误 B）

**破坏点。** 0.2.2 把工具声明改为 provider 所有：

- `node_modules/@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:27` —
  事件签名 `'system-prompt/assemble'(assembly: PromptPresentation, ...)`；
- 同文件 `:114-118` — `PromptPresentation = { sections, contexts, variables }`，**没有 `tools`**；
- 同文件 `:120-122` — 只有 `PromptAssembly` 才有 `tools`；
- 实现在 `dsh-system-prompt/lib/index.js` 的 `assemble()`：先收集 provider 的 schemas
  （`collected`）、`orderTools(...)` 排序、跑 waterfall（`:401`），最后
  `return { ...transformed, tools }`（`:402-407`）——**provider 的 tools 原样贴回**。

所以旧 `projectAssemblyTools()` 里 `assembly.tools.filter(...)` 这段在 0.2.2 是死代码，
且类型上直接报 `TS2345`（`PromptPresentation` 缺 `tools`）。

**修法。** 拆成两件事，不再假装能改写别人的声明：

1. **提示词文本仍由本插件管。** `projectAssemblySections()`
   （`src/policy.ts:382`）只处理 `sections`（`tool:web_search` / `tool:web_fetch`
   的取舍与改写），这是 waterfall 真正还拥有的东西。
2. **工具声明改由 agent 作用域的 `tools.restrict()` 隐藏。** 见下节 1.3。

### 1.3 On-demand 的真实隐藏（不是提示词契约）

**结论：0.2.2 里可以做到，通过 agent 作用域的 `tools.restrict({ deny })`。**
这一条推翻了我先前「第三方插件无法隐藏 On-demand 声明」的判断，判断依据如下。

**为什么 `restrict()` 能在 agent 作用域生效。** `dsh-tools/lib/index.js` 的
`restrict()` 读的是 `this.ctx` 的 scope：

```js
restrict(filter) {
  const scope = scopeOf(this.ctx);
  if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): ...");
  ...
  return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), ...);
}
```

`register()` 结尾用的是完全相同的 `this.layers.effect(this.ctx, ...)`，而「在 agent
作用域注册工具」是官方既有能力——说明 Cordis 在 traced service 调用时会把 `this.ctx`
重绑定到调用站点。我另外用一次性探针脚本实测确认（脚本已删除，结论保留在测试中）：

- 经 `agent.ctx` 调用 `restrict({ deny: ['beta'] })` 后：
  `tools.definitions(agent)` 变成 `['alpha']`，而 `ctx.tools.definitions()`（全局）仍是
  `['alpha','beta']`；
- `ctx.tools.get('beta', agent)` → `undefined`，`ctx.tools.get('beta')` → 定义对象；
- 步骤准入 `tools.resolve({agent,...}).view(agent)` 同样只剩 `['alpha']`；
- dispose 后恢复为 `['alpha','beta']`；
- 在 bundle 级 `ctx` 上直接调用会抛
  `tools.restrict() requires a scoped context (agent.ctx)`。

**为什么它同时覆盖声明与准入两条链路**（`dsh-tools/lib/index.js`）：

- `view(scope)`：`if (layers.every((layer) => layer.admits(name)))` 才进 `visible`；
- `admits(name)`：`deny.has(name)` → `false`；
- `definitions(scope)` / `schemas(scope)` 读该 `view`，而 `systemPrompt.tools()` provider
  正是用它们（同文件构造器里 `this.selectExecutor(scope).describe(this.definitions(scope, toolSet))`）；
- `resolve(context)` 也走 `this.view(agent)`，所以步骤准入同样被排除。

**实现（`src/policy.ts`）：**

| 位置 | 作用 |
| --- | --- |
| `src/policy.ts:742` | 每 agent 的 restriction 记录（disposer + 生效的 deny 列表） |
| `src/policy.ts:752` | 本插件已施加限制的 agent 集合 |
| `src/policy.ts:765-771` | `onDemandDenyNames()`：从**全局视图**取名字，过滤 meta 工具、`run_code` 保留名，只保留分类为 `on-demand` 的项 |
| `src/policy.ts:788-817` | `applyOnDemandRestriction()`：先 dispose 旧限制再施加新的 |
| `src/policy.ts:820-822` | `reapplyOnDemandRestrictions()`：策略变更后逐 agent 重放 |
| `src/policy.ts:828-831` | `agent/created` 施加限制 |
| `src/policy.ts:833-839` | `agent/disposed` 释放 |
| `src/policy.ts:845-847` | `tools/change` 重放（覆盖「agent 创建后才注册的工具」） |
| `src/policy.ts:661` | `updateConfig()` 里重放（tier 移动即时生效） |

**约束与坑，逐条处理：**

1. **时机。** `agent/created` 是 serial 且被 await 的（`dsh-agent/lib/types/runtime-types.d.ts:252-258`，
   `'agent/created'(this: Scoped<Agent>, payload: { agent, source, signal? })`，`@mode serial`），
   早于首次提示词组装，所以第一次 assembly 就能看到限制。
2. **只接受全局工具名。** `restrict()` 用 `view(scope).restrictableNames` 校验，未知名字抛
   `unknown global tool`。`onDemandDenyNames()` 因此只从 `ctx.tools.definitions()`
   （全局视图）取交集，skill id 与不存在的名字不会进入。
3. **`meta_search` / `meta_invoke` 永不进入 deny 列表**（`metaToolSet.has(name)` 过滤）——
   隐藏控制面会让所有 On-demand 能力不可达。
4. **`run_code` 保留名**在 `src/policy.ts:758` 排除（`restrict()` 会直接抛错）。
5. **限制是相交的**，无法单独撤销，所以每次都是「先 dispose 再施加」，并保存 disposer
   （`src/policy.ts:794-808`）。
6. **重入。** `restrict()` 与 `dispose()` 都会 emit `tools/change`，而本插件在
   `tools/change` 上重放。`applying` 标志（`src/policy.ts:788`）把重入降为 no-op；
   若不处理，嵌套那一趟会把外层刚装上的限制 dispose 掉，留下两个相交 mask，
   永久隐藏当前策略认为是 Resident 的工具。
7. **`ctx.agents` 不可用时不崩。** 改用本插件自己的 `restrictedAgents` 集合，
   避免在只挂载 policy 的组合里因 `cannot get property "agents" without inject` 失败。

### 1.4 `meta_invoke` 转发查表（关键回归修复）

**问题。** `src/invoke.ts:233`（旧）用 `ctx.tools.get(capability.name, exec.agent)`，
即 `view(agent)`。一旦策略把 On-demand 名字从该视图里 restrict 掉，这里必然返回
`undefined` —— On-demand 工具反而无法被 `meta_invoke` 调用，整个策略自我矛盾。

**修法。** 新增 `resolveForwardDefinition()`
（`src/invoke.ts:105-113`）：先按调用方视图解析；**仅当**本插件把该名字分类为
`on-demand` 时，回退到已注册定义（全局视图）。别处施加的限制仍然生效
（非 On-demand 名字不会回退）。同一函数同时用于 resolve 模式与执行模式
（`src/invoke.ts:234`、`:116`）。

**血缘保留。** 管线实例带 `ToolExecutionSource.get` 覆盖
（`src/invoke.ts:115-117`；覆盖点定义见
`dsh-tools/lib/types/pipeline.d.ts:6-14`），但执行仍传 `agent`/`signal`/`parent`，
`tools/pre-execute`、guard、`tools/result` 归属都不变。

### 1.5 Disabled 仍在执行入口硬拒

`src/policy.ts:854-869` 的 `tools/pre-execute` 保持不变：Disabled 工具与 Disabled
skill 的加载仍在执行入口 `deny`，不依赖任何声明投影。新增测试
`tests/policy.spec.ts` 的 `never hides a Disabled tool behind the On-demand mask alone`
同时断言：Disabled 名字**不进入** On-demand deny 列表（两套机制互相独立），
且 pre-execute 仍然返回
`{ kind: 'deny', reason: 'capability "a" is disabled and cannot be executed' }`。

---

## 2. 无法修复 / 已降级

### 2.1 提示词层的「工具声明投影」永久移除（不是降级，是契约消失）

`projectAssemblyTools()` 改名并缩减为 `projectAssemblySections()`
（`src/policy.ts:382-402`）。它不再接收、也不再返回 `tools`，因为
`PromptPresentation` 里根本没有这个字段
（`dsh-system-prompt/lib/types/index.d.ts:114-118`），且 waterfall 之后
provider 的 tools 会被原样贴回（`dsh-system-prompt/lib/index.js:402-407`）。
这是宿主契约变化，不是本插件能力损失：等价能力已由 1.3 的 `tools.restrict()` 承担。

### 2.2 `ToolRegistrationOptions.when` 不适用（未使用，非降级）

`when` 是**注册方**在 `register(definition, options)` 时提供的步骤级准入条件
（`dsh-tools/lib/types/contracts.d.ts:109-119`，实现见 `dsh-tools/lib/index.js`
`register()` → `layer.tools.insert(name, { definition, when: options.when })`）。
本插件不是这些工具的注册方，无法为别人的注册附加条件，因此没有采用这条路径——
改用 1.3 的 `restrict()`，效果等价且不需要注册权。

### 2.3 技能目录过滤仍是消息重写（沿用，未升级）

On-demand/Disabled 技能从 `<available_skills>` 中移除仍靠
`agent/pre-step` 重写 `source.kind === 'skill-catalog'` 的 user 消息
（`src/policy.ts:874-901`）。0.2.2 未提供技能目录的 provider 级过滤点，
这一实现未变；它不是本次破坏点，也未在本次验证范围内实测生产目录形态。

---

## 3. 对生产运行态的影响

1. **`lib/` 已被更新。** `pnpm build` 已执行成功（见第 4 节），`lib/**` 是新产物。
   `~/.dsh/profiles/desktop/package.json` 对本仓库是 `link:`，所以**未提交的
   `lib/` 已经进入生产运行态**；但正在运行的 Host 仍加载旧模块，
   **必须重启 Host 才会生效**。
2. **On-demand 现在真的会隐藏声明。** 生产上任何被分类为 On-demand 的工具，
   在该 agent 的工具声明里会消失（此前 0.2.1 由 `assembly.tools` 过滤实现，
   0.2.2 迁移期间该行为一度失效）。模型改为经
   `meta_search` → `meta_invoke` 抵达，提示词里
   `capability-menu-catalog`（`src/policy.ts:917-921`）会明确告知这条路径。
3. **`tools.restrict()` 的副作用面。** 限制是 agent 作用域的，全局视图
   （管理 UI、`classifyAll`、其他未受限 agent）不受影响；每个受限 agent 会多一条
   restriction 层，`tools/change` 触发时会重放一次（有 unchanged 短路与重入保护）。
4. **`meta_invoke` 的单次转发多走一条管线。** 由 `ctx.tools.execute(batch)` 改为
   `ToolExecutionPipeline.prepare/dispatch/complete`。行为等价（同一条
   pre-execute → guard → execute → post-execute → result 链），但**不再经过
   所选 executor 的调度器**（并发/并行分类、`maxParallelToolCalls`）。对单次转发
   无影响；`run_code`（PTC）模式下的内层派发由 PTC 执行器自己负责，本改动不触碰。
5. **未触碰生产 profile。** 没有执行 `git commit` / `git push`，没有改
   `~/.dsh/profiles/desktop`，没有 npm publish。

---

## 4. 验证（真实输出）

命令均使用宿主 runtime 自带 node/pnpm：

```powershell
$node="$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm="$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
```

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Node 侧类型 | `tsc -p tsconfig.json --noEmit` | `NODE_TSC_EXIT=0`（无输出） |
| Client 侧类型 | `tsc -p tsconfig.client.json --noEmit` | `CLIENT_TSC_EXIT=0`（无输出） |
| 测试 | `vitest run` | `Test Files 31 passed (31)` / `Tests 542 passed (542)` |
| 构建 | `pnpm run build` | `✔ Build complete in 5305ms`，`BUILD_EXIT=0` |
| 打包 | `npm pack --dry-run` | `total files: 111`，`package size: 319.9 kB`，`PACK_EXIT=0` |

`npm pack --dry-run` 使用的是系统 npm CLI（`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`），
由宿主 node 执行：宿主 runtime 的 `dependencies\node` 只带 `node.exe`，不含 npm。

### 测试改动说明（不是为了让测试变绿而删断言）

0.2.2 让 `ToolsService` 在**未挂载 executor** 时同时拒绝 prompt 组装与执行
（`dsh-tools/lib/index.js`：`selectExecutor()` 抛
`ToolExecutorUnavailableError`，构造器里的 `systemPrompt.tools()` provider 与
`execute()` 都调用它）。这是宿主的正确行为，测试组合缺了 executor。
新增 `tests/stubs/test-executor.ts`，按官方 `ToolExecutor` 契约
（`lib/types/executor.d.ts:58-80`）用 `ToolExecutionPipeline` +
`executeToolBatch` 实现一个最小原生执行器，并导出 `runOneToolCall()`
把「单次调用」包装成 `ToolCallBlock` 批（`arguments` 为 JSON 字符串，
见 `dsh-llm/lib/types/types.d.ts:92-99`）。这样测试仍在跑真实的
pre-execute/guard/post-execute/result 链，而不是 mock 内部。

被改写的断言（行为确实变了，改为断言新的真实行为）：

- `tests/policy.spec.ts`：`projects assembly.tools to Resident + meta tools only`
  → `hides On-demand tools from the agent declaration and admission, keeping meta tools`。
  现在必须在 **agent 作用域**组装（`assemble({ scope: agent })`），因为限制是
  per-agent 的；并额外断言 `tools.resolve()` 的步骤准入集合同样不含该名字。
- `tests/policy.spec.ts`：`excludes disabled tools from the projection even when also resident`
  → `never hides a Disabled tool behind the On-demand mask alone`。Disabled 不走
  restrict（它是 pre-execute 硬拒），断言改为「声明里仍在 + 执行入口仍 deny」。
- `tests/policy.spec.ts`：`projects web guidance with the four tool tier combinations`
  现在在 agent 作用域组装（四种 tier 组合的期望值不变）。
- `tests/meta-invoke.spec.ts`：`executes an On-demand native tool while it stays out of the exposure surface`
  → `hides an On-demand tool from the agent declaration yet still forwards it`，
  断言「agent 视图里没有 / 全局视图里有 / `meta_invoke` 仍能转发」——这正是 1.4
  修复的那个致命回归。

---

## 5. 未验证

1. **真实 Host 运行态未验证。** 没有重启 Host，也没有在 `~/.dsh/profiles/desktop`
   里跑真实会话；`agent/created` 与首次 assembly 的时序只在测试里模拟
   （直接 `ctx.emit('agent/created', ...)`）。
2. **`agent/created` 之外的真实 agent 生命周期未覆盖。** 例如 `resume` 出来的
   agent、preset 作用域下创建的 agent，`restrict()` 施加时机是否同样早于首次
   assembly，未经真实会话验证。
3. **PTC（`run_code`）执行器组合未验证。** 本插件的转发走共享管线而非所选
   executor 的批调度；在 PTC 模式下 `meta_invoke` 的内层派发行为未实测。
4. **并发/并行语义未验证。** `executeToolBatch` 的并行分类在本插件路径上不再参与
   （单次转发），未测「多个 `meta_invoke` 同时执行」的场景。
5. **Web GUI（客户端）未验证。** 客户端代码未改，但管理面板里「On-demand」这一档
   的可见性语义在生产 UI 上未实测。
6. **`tools.restrict()` 与第三方插件的限制叠加未验证。** 本插件只回退自己分类为
   On-demand 的名字，其他插件的 `deny` 仍应生效——这一点由代码结构保证，但没有
   跨插件的集成测试。
7. **0.2.1-rc.3 回退路径未验证。** `peerDependencies` 同时允许
   `^0.2.1-rc.3`，但本次只针对 0.2.2-rc.1 编译与测试；`ToolExecutionPipeline`
   子路径与 `system-prompt/assemble` 新签名在 0.2.1 下不成立。
