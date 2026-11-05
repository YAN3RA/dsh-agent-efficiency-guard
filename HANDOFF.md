# HANDOFF

更新：2026-11-05。仓库：`YAN3RA/dsh-agent-efficiency-guard`；分支：`main`。

## 当前范围

本包面向 DSH，使用 DSH 插件公开接口。插件负责 DSH 能力目录、按需检索/调用和 Agent/Turn 执行保护；DSH 宿主负责模型、Provider、推理强度和完整会话；Save Token 负责工具结果压缩与原文恢复。

## 当前实现

- 包版本：`0.1.8`；GitHub `v0.1.8` 已发布。本地改动未提交、未发布。
- **2026-11-05 本轮修复（待 Host 重载生效）：** `capabilityPolicy.classifyAll` 在生产 Host 报 `gateway/definition-unavailable: … its strict definition was withdrawn and SRC fallback is forbidden`。根因是同一 package `dsh-agent-efficiency-guard` 被 `register()` 两次（`capabilityPolicyHostFace` 与 `usageHostFace` 各一次），Typert 按 package 键控，第二次注册撤销了第一次的 strict definition，端点保持 `hasSeen()` 却无法解析。修复：新增 `mergeHostFaces()` 把两个 face 合成单一 contribution，`src/index.ts` 只调用一次 `registerCapabilityPolicyHostFace(registry, [usageHostFace()])`。回归用例见 `tests/host-face.spec.ts`（merged host face 5 项）与 `tests/client-plugin-section.spec.tsx`。
- **2026-11-05 设置页合并：** 原来 `capability`(12) 与 `usage`(13) 两个 `settings.section` 合成一个（仍 id `capability`、order 12），由新的 `src/client/PluginSection.tsx` 提供功能分类标签（能力目录 / 调用统计），两个视图都保持挂载（`hidden` 切换）以保留各自 Remote 订阅。`src/client/index.ts` 不再注册第二个 section。
- 能力菜单支持 Native/MCP Tools 与 Skills 目录、`meta_search` / `meta_invoke`、Resident / On-demand / Disabled 策略、筛选/详情、MCP/Skill 来源管理、检索元数据和诊断。
- N6 去掉预算硬停止与按软阈值收尾/steer；Step/Tool/Duration 计数仅作统计。旧 `stepLimitMode: hard-stop` 归一为 `warn-only`，`duplicateHardBlock: true` 归一为 `false`，保留弃用日志。
- N7 源码已接入 callId dispatch 序号缓冲、polling/exclusion 配置、动态 `metaTools()`、真实 user inbox reset、独立 Guard message source 和拒绝结果回灌排除；dispatch/pending history 上限 64，溢出时 loop detection fail-open。白名单独立复审对当前源码快照结论为 `pass`，不代表生产运行态或可发布产物通过。
- N8 已接入公开 `session/event` 实时采集（有界微批）、独立只读 `usage` Remote 与设置页统计面板；原始报告经有界白名单投影，UI 按窗口/工作区/能力类型聚合，并对 unavailable/unknown coverage 保持显式状态。受限历史 backfill 已接入 runtime：先订阅实时事件，再并行读有界历史页；队列在历史状态合并前保持有界等待，之后再折叠实时事件；队列达上限时取消/作废回补结果并优先处理实时事件。已修复取消后复用旧 Promise、`open()` 漏传 signal、合法短页误判、fork 子会话继承前缀被重复统计、预算跳过 Session 未标 coverage、Host aggregate DTO 到 500 行后静默裁切，以及 teardown 注册失败的监听器泄漏；排序承诺限定为微批内，跨 tick 重排由 collector coverage 标记。历史原因计数与实时 collector 诊断分离。collector 和 cursor 仍只在内存，不能宣称跨重启恢复或 profile-local 落盘。
- Workspace 只在 registry 明确映射时标记 `current-mapping`，缺失/歧义为 `unknown`；`profileContext` 的 `ProfileContext` 类型在上游 `@deepseek-ai/dsh-app-boot` rc.3 起存在并含 `name`/`dir`，但本插件未声明该依赖，当前 `name` 仍是 best-effort 标签，Host 运行态注入与 launcher 覆盖尚未独立验证。未知 profile 禁用回补。没有从 cwd 推断 workspace。
- 默认回补预算为 8 Sessions / 每 Session 2,000 events / 总计 10,000 events / 每页 100 / 5 秒；cursor 仅保存 profile hash 与 Session id、offset、revision，当前只是调用方持有的内存对象，尚未持久化。
- 已发现上游公开 durable KV 候选 `ctx.storageDomain`；storage 与 storage-domain 仅在 lockfile 中作为 `dsh-workspace` peer 依赖出现，插件 `package.json` 未声明也未安装它们。当前 DSH 默认 base bundle 将 JSON backend root 配为 `dshHomePath('storages')`，是 `$DSH_HOME` 级共享目录，不是 profile-local；插件无法从公开 API 读取 backend/root，且默认域 API 不接受 profile/path。因此继续暂停落盘，维持 memory-only，不能声称跨 profile 隔离或跨重启恢复。隔离 Host 的进程内挂载状态尚未直接探测。

## 本轮验证

- `pnpm typecheck`：Node 与 Client 两套 TypeScript 配置均通过。
- `pnpm test`：30 个测试文件、531 项全部通过；Usage runtime 29 项、backfill 24 项、Host usage Remote 25 项，覆盖 fork prefix、budget coverage、aggregate/coverage/error-count caps、`__proto__` 对象键及 Map 精确/超限边界与取消单飞，并断言客户端只 mount 一份合并 Remote contribution。
- `pnpm build`：通过，生成客户端 bundle 与声明文件。
- `npm pack --dry-run`：通过，包版本 `0.1.8`、111 个文件；未生成需保留的归档。
- 隔离验收：在独立 `$DSH_HOME` 的 `guard-smoke` 安装重新构建的 `0.1.8` tarball（111 个文件，SHA-1 `0eacbdde9e2067b2dd7131dc67c7f569fb82f856`）。真实 Host 插件页显示该插件启用且 5/5 组件运行；设置 → 调用统计正常渲染，`usage/getSnapshot` 返回 HTTP 200，点击刷新后再次返回 HTTP 200；页面显示覆盖未知提示，未出现 Remote 未挂载错误，浏览器未记录页面异常。原因是 capability 与 usage Remote 各自以同一 package 注册，Typert Store 拒绝重复包；现合并 descriptors 并只 mount 一次。隔离 Host 未登录且未配置 API Key，因此未测试真实模型/会话调用或历史回补；本结果不是生产兼容性或发布验收。隔离 Host 与浏览器会话已停止，临时 profile 保留未清理。
- N7 的独立复审结论仅适用于当时源码快照，不代表 Host 运行态或发布验收。

## 本轮验证（2026-11-05 02:09）

- `pnpm typecheck`：Node + Client 两套均通过。
- `pnpm test`：31 个测试文件、542 项全部通过（新增 5 项 merged host face、6 项 combined settings page）。
- `pnpm build`：通过。
- `npm pack`：111 个文件，包版本 `0.1.8`，tarball SHA-1 `f0f4250cae53f6e98b55cefa0bdaea400d207362`。
- 已安装到本机生产 profile `desktop`（`file:` 依赖指向该 tarball）。安装产物校验：全部 `lib/**/*.js` 通过 `node --check`；`lib/index.js` 只调用一次 `registerCapabilityPolicyHostFace(registry, [usageHostFace()])`；独立加载 `lib/host-face.js` 后 `mergeHostFaces` 产出 26 个 invocation、package 为 `dsh-agent-efficiency-guard`；`lib/client.js` 中 `settings.section` 注册只剩 1 处（id `capability`）。
- **未完成：** 运行中的 Host（PID 31936，启动于 00:45:45）仍加载 02:09 之前的旧包，需要用户在 GUI 重启 Host（或重开应用）后才会使用新代码。本会话跑在该 Host 内，无法自行重启。

## 未完成 / 未验证

- N7 自动化测试通过且当前源码复审为 `pass`；仍有非阻断实现边界需在后续迭代评估，不能据此标记生产运行态通过。
- N7 代码与测试覆盖：read/job polling warn-only 或排除、动态 `capabilityPolicy.metaTools()` 与 `run_code` 排除、真实 `source.kind === 'user'` 的 inbox reset 且 Guard 自己 source 不 reset、按 callId dispatch 顺序处理并行结果、超过 64 条队列 fail-open、拒绝结果不回灌循环历史、结果 Hash 覆盖规范化 value/content。拒绝用例断言 Guard 拦截及工具体未执行，但没有直接断言 `businessToolCalls`；该计数当前会统计已派发的非 control-plane 工具（包括 polling）。N8 Usage 统计 collector 实际观察到的 Session 工具调用，不等同于 Guard 的 `businessToolCalls`。产品验收定义见仓库根目录 [vNext 改造任务书](../dsh-agent-efficiency-guard-vNext改造.md#L138-L196) 与 `:729-744`。
- N7 的独立复审只适用于当时源码快照。当前已完成全量 typecheck、测试、build、pack dry-run 和隔离 Host/GUI 验收，但这不能证明生产运行态通过。
- N8 当前源码快照已由独立审查判定 `pass`；审查方独立运行 usage-remote 24、usage-backfill 24、usage-host-face 11 项，共 59 项通过。该结论限于源码与定向测试，不代表 GUI、profile-local persistence 或生产运行态验收。
- N2 BrowserSkill CLI 安装与路径配置已完成：本机 CLI 为 `C:\Users\yansui\.local\bin\bsk.exe`，desktop profile 的 `browserskill` 条目显式设置 `bskPath`。隔离 DSH web 未授权请求返回 `401 Unauthorized`；隔离包 GUI/RPC 验收已完成（见上）。本轮经授权只读检查 production `desktop` profile：bundle 与 dependencies 已安装 `dsh-agent-efficiency-guard@0.1.8`（实际 tarball SHA-1 `0eacbdde9e2067b2dd7131dc67c7f569fb82f856`）；pnpm 完成安装并报告 `Packages: +1 -4`，有 1 条 deprecated subdependency 与 peer-dependency warning。profile 同时包含 Context、Cost Meter、Save Token、MCP Connector、Mnemos 等目标共存包。Host 进程仍在运行；直接访问当前 Web GUI 基础地址返回 authentication required。启动链接 token 不会读取、复制或索取；`dsh desktop --help` 明确提示该 profile 仅由 Electron 应用管理，无法用 CLI 启动/重启。尚未确认运行中的 Host 是否已加载插件，未完成 production GUI/共存验收。


## 工作区与安全边界

- 当前分支 `main` 比 `origin/main` 超前 1 个提交；工作区保留此前未提交的文档、N6/N7 与 N8 改动，均未暂存/提交。本轮本地验证为 30 个测试文件、531 项通过，两套 TypeScript 检查、build、pack dry-run 与 `git diff --check` 通过；isolated Host 与浏览器会话已停止。本轮按用户明确授权将 `0.1.8` tarball 安装进 production `desktop` profile；尚未确认运行中的 Host 已加载该包。CLI 明确拒绝启动受 Electron 管理的 profile，Web GUI 当前需认证，因此未重启 Host，插件 GUI/生产共存验收待有安全可用的已认证 GUI 入口后完成。
