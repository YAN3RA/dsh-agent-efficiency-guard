# dsh-agent-efficiency-guard — handoff

## 目标

把上游 `dsh-capability-menu` 的能力目录能力与 Agent Efficiency Guard 合并成一个可独立安装、可持续维护、可交接的 DSH 插件，并避免在宿主 PI-Desktop 中重复实现 Token Saver 或上下文压缩。

## 当前工作区

- 工作区：`C:\Users\yansui\Documents\agent workspace\dsh-agent-efficiency-guard`
- 插件仓库根目录：`C:\Users\yansui\Documents\agent workspace\dsh-agent-efficiency-guard\plugin`
- GitHub：`https://github.com/YAN3RA/dsh-agent-efficiency-guard.git`
- 当前包名：`dsh-agent-efficiency-guard`
- 当前版本：`0.1.7`
- 任务书：`dsh-agent-efficiency-guard-implementation-spec.md`

## 已完成

### 基线与运行时审计

- 审计了本机 DSH：CLI `0.2.1-rc.5`，Node.js `v24.22.1`，pnpm `11.28.5`。
- 确认本机 `desktop` profile 由 Electron 独占，CLI dump 被阻止；没有修改生产 profile。
- 审计了本机已有 `@daweifu/capability-menu@0.1.7`、`dsh-plugin-save-token@2.4.1`、`dsh-mcp-connector@0.2.87`。
- 上游源码基线已放入本目录，未再依赖旧 npm 包作为运行时依赖。

### 代码

- `src/guard-core.ts`：预算、状态隔离、稳定签名、重复调用和无进展循环核心。
- `src/guard.ts`：接入公开 DSH `agent/pre-step`、`agent/turn-stopping`、`tools/result`、`agent/disposed`、`ctx.tools.guard()`。
- 根插件 `src/index.ts`：能力目录网关与 Guard 使用同一包入口。
- `cordis.patch.yml`：已使用 `dsh-agent-efficiency-guard` 运行时身份，并默认启用 `normal` Guard。
- Typert host-face 已适配本机 `TypertRegistryContract` 的类型检查。
- 测试夹具已改为 Windows 安全临时目录和路径。

### 文档

- `AGENTS.md`：项目开发约束和目录规则。
- `README.md`：白话说明、安装、验证、删除和生产边界。
- `docs/runtime-audit.md`：运行时审计。
- `docs/host-pi-desktop-integration.md`：宿主 Token / Cache 边界和死循环防护。
- `docs/acceptance-report.md`：实现范围、验证结果和未完成项。

## 已验证

在仓库根目录执行过：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
```

结果：

- typecheck：通过
- test：14 个测试文件、203 个测试全部通过
- build：通过
- pack：通过，生成 `dsh-agent-efficiency-guard-0.1.7.tgz` 的 dry-run 结果


## 重要边界

- 没有切换生产 `desktop` profile。
- 没有卸载旧 Capability Menu。
- 没有发布 npm。
- 没有运行真实 Electron 桌面启动 smoke test。
- 本机没有发现公开的 PI-Desktop Token Saver / Prompt Cache 适配服务；当前实现是安全降级，不声明直接调用宿主服务。
- `dsh-plugin-save-token` 仍是工具结果压缩、展开和原文恢复的唯一所有者。
- Guard 不读取、保存或输出隐藏思维链；只使用工具调用、结果哈希、Step 和 Turn 事件。

## 下一次对话建议先做

1. 进入插件目录，检查 Git 状态和远端：

   ```powershell
   cd "C:\Users\yansui\Documents\agent workspace\dsh-agent-efficiency-guard\plugin"
   git status --short --branch
   git remote -v
   ```

2. 读取 `AGENTS.md` 和本文件，不要重新调查已经记录的 DSH 版本与测试结果。
3. 如果继续实现，优先做隔离 profile smoke test：复制 `desktop` profile，停用旧 Capability Menu，只加载新包。
4. 验证 `meta_search`、`meta_invoke`、策略、Guard、Save Token、MCP Session 和设置页。
5. 如需修改公共 Typert package ID、状态文件名或 plugin entry ID，先增加迁移/回滚设计，不要直接改旧状态兼容名。
6. UI 统计、Token 对照报告和完整隔离 profile 验证仍是后续工作，不要在没有实际证据时宣称完成。

## 推送状态

本轮将把 `plugin` 目录初始化为 Git 仓库，设置远端：

```text
https://github.com/YAN3RA/dsh-agent-efficiency-guard.git
```

预计推送分支为 `main`。推送后下一次对话应先以远端 `main` 为基线，不要重新从任务书复制源码。
