# H1：N6 审查与修复

日期：2026-11-04。独立审查与复审均指定白名单路由 `magpie/group/deepseek-v4.1-flash`。本轮未提交、未发布，未修改生产 profile 或进行 GUI/Host 装载验证。

## 首轮结论：needs_revision

独立审查确认移除 Step/Tool/Duration 总预算停止、旧配置归一及弃用日志的核心逻辑符合 N6 目标，但指出：

- README/package 描述仍宣称硬停止、收敛提示和无进展循环阻止；AGENTS 也误称阈值已有诊断/软提醒。
- 新 pending 工具计数没有策略消费者，在控制面与取消无结果时会漂移；对应的预执行签名产生额外 SHA-256 开销。
- 工具准入始终 allow，注册的 tools.guard 与 deny 分支不可达，profile() 无调用方。
- 缺少 Host hook 适配层测试。

首轮 typecheck 通过；全量 227 项中 policy 文件一项超时，单独运行该文件 33/33 通过，不能据此把首轮全量记为全通过。

## 本轮修复

- 更正 README、package 描述和 AGENTS 实现边界。
- 移除 pending 状态、admitTool 空接口、tools.guard 空注册、不可达 deny 类型与分支、未使用的 profile()。
- 保留 modelSteps、businessToolCalls、startedAt/lastActivityAt，以及每 Agent/Turn 的重复签名和一次提醒。
- 新增 `tests/guard.spec.ts`，覆盖旧配置 schema/apply、弃用日志、pre-step 持续放行、无收敛/turn-stopping hook、一次重复提醒、控制面排除、Agent/Turn 隔离和清理。
- 测试暴露部分配置中的 undefined 覆盖 enabled/duplicateDetection 默认值；已在 validateGuardConfig 中添加 nullish 默认，并通过默认 apply 路径回归覆盖。
- 独立复审定位的 host-integration/runtime-audit 陈旧行为声明已更正；历史发布验收保留原记录并加当前工作区范围说明。
- 旧 maxConvergenceSteersPerTurn/maxNoProgressCycles/loopBreakMode 已标 deprecated、仅作兼容；修正历史 N8 上游结果说明链接，区别当前 N8 统计核心。
- 删除不再需要的 tools 静态注入声明、clearIfTurn；核心 observeTool 在禁用时不建状态、不计数、不提醒，日志准确显示 disabled。新增核心及 hook 禁用回归测试。
- `tests/guard-core.spec.ts` 覆盖无效 mode、旧阻断配置与关闭重复检测共存、超过旧阈值后保留计数/时间、Agent/Turn 隔离及精确重复。

## 验证

通过 DSH bundled Node 执行 bundled pnpm：

- `pnpm typecheck`：退出 0，server/client 均通过。
- `pnpm test`：最终源码退出 0，17 文件、229 项全通过（新增禁用场景），包含先前超时的 policy 文件。
- `git diff --check`：退出 0；仅 Git 的 LF/CRLF 转换提示。

## 独立复审：pass

独立复审 Agent `db9247b4-5b22-4638-956e-bcd1acee55f7` 对最终源码与当前文档给出 `pass`；使用 bundled Node/pnpm 独立运行 Guard 两个文件，10/10 通过。原 H1 阻塞发现均已解决，没有必要的 N6 修复项。复审中新增 disabled 测试一度缺少返回的 info spy，补齐后通过；主代理全量验证同样通过。

复审不证明生产运行态或发布完整验收。未执行 build/pack（HANDOFF 将构建 lib 列为单独授权边界）；`lib/` 仍为旧构建，若 Host 从该目录加载，源码修改不会自动生效。未做 Host/GUI 运行态验收，因此不能宣称本地四项验证或生产兼容性通过。测试文件当前不在 TypeScript typecheck 范围内，Vitest 执行通过不等同测试源码也经过 tsc。
