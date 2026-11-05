# H2：DSH 公开契约与接入边界

日期：2026-11-04。范围：供 N8/H4 实施使用的只读源码审计；未验证生产 profile 装载、访问权限或真实流量。子 Agent 路由为 `magpie/group/deepseek-v4.1-flash`。

## 证据与版本

- 插件 `package.json` 的 DSH devDependencies 锁定 `0.2.1-rc.3`；已安装桌面发行包 `app.asar/dsh/package.json` / `desktop-runtime.json` 显示 `0.2.1-rc.5`、Host protocol 4。发行包包含实现 JS，没有 `.d.ts`。
- 审计对照公开 npm 类型与随包 JS；主要 history/query/remote-events/config-form/slot 类型在 rc.3 与 rc.5 间一致。声明兼容不能证明当前 profile 已装载相关服务。
- 后文依赖包路径均相对各包的发布根；发行包 JS 位于 `app.asar/dsh/node_modules/@deepseek-ai/<包名>/`。行号对应本次审计发行物，后续版本应按符号复核。

## Session 历史与实时源

`@deepseek-ai/dsh-api-session-controller/lib/types/history.d.ts:22` 提供 `page(SessionPageRequest)`，`:29` 提供 `follow(SessionFollowRequest)`。`types.d.ts:467` 的分页请求含 address、throughSeq、beforeSeq、maxMessages；`:534` 的结果含 records、hasMore；`:539` 的 follow 从含 cursor 的 snapshot 开始。发行包 `lib/index.js:1475/:1510` 有对应实现，浏览器 Remote manifest 暴露 `session/page` 和 `session/follow`。

**只有历史页分页；Session 列表不分页。** `lib/types/list.d.ts:39` 的 list 返回所有可见摘要。因此需限制后续历史读取数量/预算；不能假设列表有 cursor，也不能把 message-aligned history 页等同于完整原始事件日志。

`@deepseek-ai/dsh-session-query/lib/types/index.d.ts:67/:74/:150` 提供 `listSessions`、`readSession`、`readEvent`。`readSession` 是全日志读取，不是有界分页；`readEvent` 的 before/after window 默认上限 50（`config.d.ts:4`）。全量历史回补先定义每 Session/总量预算，并明确历史页投影与原始事件各自可计数范围。

## 聚合与持久化

`@deepseek-ai/dsh-session-projection/lib/types/index.d.ts:117-150` 声明 `sessionProjections`、纯 ProjectionDefinition 与 register；`:175/:185/:194` 为 stateOf/snapshot/cachedSnapshot。可通过 `ctx.inject(['sessionProjections'], ...)` 可选接入，让聚合不随浏览器翻页丢失。

既有 `sessionStats` 仅有 turns/steps/LLM/tool timing 等指标，没有按 capability 的调用计数。N8 仍需自行投影。`src/usage/usage-core.ts` 当前只是纯 fold 核心，尚无上述适配器。

profile-local 聚合持久化仍须实现、定义 schema/version/migration；不把 usage 自定义事件写进 Host Session 日志，不扫描私有 Session 目录。完整事件仅在本机 Host 内临时解析，持久化仅保留聚合元数据，不保存原文、工具参数或结果。

## Remote 与刷新

`@deepseek-ai/dsh-api-remotes/lib/types/remote-events.d.ts:17` 的 forwarded-event 列表在发行包 `lib/index.js:24` 固定。TypeScript module augmentation 不能增加运行时转发项；插件不能凭类型扩展创建新的 forwarded event。

可选方案：已有 allowlisted event + 查询刷新/轮询；或插件自己的 stream Remote。后者需 `InvocationDescriptor.mode: 'stream'`（`dsh-typert-protocol/lib/types/types.d.ts:311`）、client stream descriptor、访问资源声明与 gateway `interactions=answer` 的隔离验证。当前 `src/host-face.ts` 只声明 direct，不能直接宣称 stream 已支持。

`settings/document-updated` 只说明设置变化；它不能替代 usage 实时事件。已有客户端也监听 connection/reset，可在重连后重新查询。

## 设置页与根配置

`plugins.bundle.config` 是 keyed client slot，键为包名（`dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:153`），必须由插件自己注册；没有从 schema 自动进入该插槽的 fallback。

真正配置存储按 profile entry id 命名。`dsh-settings` 的 describe/update/replace/mutate 是公开接口；无运行时 Config schema 的 entry 会被 describe 跳过（发行包 `lib/index.js:413-417`）。当前 `src/index.ts:32` 只导出 Config interface；schema 只在 `src/guard.ts` 子插件上。因此应在 H4 为 root 导出真实 schema，并明确包名与五个 entry id 的映射。

可沿用当前 `settings.section`，或显式注册 bundle slot。配置表单需处理 loading/ready/unavailable、writable 和 expectedRevision；缺服务时保持只读/不可用，不能绕到私有配置路径。

## N8 实施决策（2026-11-04）

以下三项已由用户确认：

1. 实时源采用 `@deepseek-ai/dsh-session` 的 `session/event`；历史回补采用可选的 `ctx.sessionPersistence`。`session-query`、`session-projection`、`api-session-controller` 不作首期硬依赖。
2. 无可信 owner 的 Plugin Tool 保留 `unknown`；只统计有可观察事件证据的 Skill 入口，并通过 coverage 标明缺口，不猜测归属。
3. 统计 API 使用独立 `usage` Remote namespace，不混入 `capabilityPolicy`。

### 数据源和覆盖语义

- rc.5 `dsh-session` 类型把 `session/event` 定义为 post-commit、fire-and-forget append feed；它适合实时增量，但只覆盖监听器注册后的事件。异步监听失败需自行记录，不能依靠 emit 调用方感知。
- rc.5 `dsh-session-persistence` 类型公开 `ctx.sessionPersistence`，包括 `list/stat/open(id, 'read')` 与 `SessionHandle.read(offset, length, { signal })`。`list` 返回所有可见快照且无顺序保证，不分页；实现必须自行限制 Session 数、单 Session 事件数/总读取量，并使用可取消的小页读取。服务缺失、读取失败、取消或超限均记录为 `unknown/partial` 与明确 reason，不得伪报零调用。
- `ctx.workspaceRegistry` 作为可选服务提供当前 workspace/session 账本，但没有历史成员变更证据。实时事件只有在调用时能取得正式 Workspace ID 才标 `event-time`；历史按当前账本映射只能标 `current-mapping`，无法映射则 `unknown`。
- 事件 projector 只提取任务书允许的 ID、seq/time、状态码和工具名；不持久化或返回 arguments、消息正文、工具输出、Skill 正文或凭据。调用去重用 `(sessionId, seq)`，结果配对用 `(sessionId, callId)`。
- 来源分类必须依赖可信映射：MCP 只能在唯一 Server 映射时归类；Plugin Tool 无公开 owner 时归 `unknown`；Skill 只记录明确可观察入口；绝不按名称前缀猜 owner。首期 coverage 必须反映历史缺失、owner 不明与未覆盖 Skill 路径。

### 包依赖、持久化与 Remote

- `dsh-session` 已是 peer/dev dependency；`dsh-session-persistence` 与 `dsh-workspace` 是可选服务，不使用无条件 static inject，以免服务缺失阻塞插件启动。当前开发基线是 rc.3，rc.5 发布类型可用于契约比较，不能替代目标 Host 运行态验收。
- 已核实的公开 durable 插件数据候选为 `ctx.storage.domain` / `ctx.storageDomain`（`@deepseek-ai/dsh-storage` 与 `@deepseek-ai/dsh-storage-domain`，当前安装声明为 0.2.1-rc.3）。其 KV 写入由所路由的 backend durability 承担；domain 名在该 backend 内唯一，backend/root 与 routes 由宿主组合配置。该 API 不接受 profile 或路径参数，因此它证明“有公开持久化候选”，不证明“profile-local”。
- 当前依赖树没有给 `profileContext` 提供已验证的类型契约；现有 `ctx.get('profileContext')?.name` 只能当 best-effort 标签。即使以后以 profile hash 在共享 backend 内做键分区，也不能据此声称目录/介质级隔离。Host 是否挂载 `storageDomain`、使用哪个 backend、backend root 是否按 profile 隔离，以及 profile 身份来源，均未在隔离 Host 中核验；因此当前继续暂停落盘，不自行拼接 `~/.dsh`、profile 或 Session 路径。
- 若单独授权实现 adapter，需评估 storage/domain optional peer 与版本兼容性（domain 包 peer 固定 0.2.1-rc.3，并依赖运行时 `zod`）；缺服务或遇到 `form-not-mounted`、`backend-not-found`、`already-open`、`version-mismatch`、`invalid-record` 等情况必须 fail closed 到 memory-only 并标明 coverage/reason，禁止伪报完整或跨重启恢复。
- 新增独立 `usage` namespace；客户端用查询/短轮询获取快照，不增加未经 Host allowlist 支持的 forwarded event，也不假设 `InvocationDescriptor.mode='stream'` 已就绪。
- root plugin 需导出真实 Config runtime schema，并明示包名与 settings entry ID 映射；表单处理 loading/ready/unavailable、writable 与 expectedRevision。

### 验收边界

类型参考：[Session rc.5](https://unpkg.com/@deepseek-ai/dsh-session@0.2.1-rc.5/lib/types/index.d.ts)、[Persistence rc.5](https://unpkg.com/@deepseek-ai/dsh-session-persistence@0.2.1-rc.5/lib/types/index.d.ts)、[Handle rc.5](https://unpkg.com/@deepseek-ai/dsh-session-persistence@0.2.1-rc.5/lib/types/handle.d.ts)、[Workspace rc.5](https://unpkg.com/@deepseek-ai/dsh-workspace@0.2.1-rc.5/lib/types/index.d.ts)。这些公开类型只证明 API 声明，不证明当前 profile 已装载对应服务。隔离 DSH_HOME 装载、授权、读取规模、spill 影响与 GUI 验收仍须单独完成；build/pack 和生产 profile 操作不在本次授权范围。
