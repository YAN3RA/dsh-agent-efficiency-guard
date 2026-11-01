# dsh-agent-efficiency-guard — HANDOFF

## 1. Goal（目标与范围）

### 一句话目标

把上游 Capability Menu 的能力目录、按需调用和三档策略，与 Agent Efficiency Guard 合并成一个可独立安装、可维护、可迭代、可复用、方便交接的 DSH 插件。

### 交付边界

当前阶段已完成：

- 能力目录、`meta_search`、`meta_invoke`、Resident / On-demand / Disabled 策略；
- Step / Tool / Time 预算和重复调用提醒；
- 基于可观察事件的无进展循环防护；
- PI-Desktop / Save Token / MCP Connector 职责边界；
- Windows 测试、构建、打包和项目文档；
- 仓库初始化并推送到 GitHub `main`。

当前阶段不包含：

- 生产 `desktop` profile 切换；
- npm 发布；
- 真实 Electron 桌面启动 smoke test；
- 私有 PI-Desktop Token Saver / Prompt Cache API 接入；
- 专门的 Guard 统计管理面板。

## 2. Constraints（约束与规则）

### 必须遵守

- 源码只改 `src/`；生成的 `lib/` 不手工修改。
- 新行为必须在 `tests/` 增加对应测试。
- Windows 路径使用 `node:os` 的 `tmpdir()` 和 `node:path`。
- 修改 DSH Hook 前核对当前安装的 `@deepseek-ai/dsh-*` 类型定义。
- 版本号以 `package.json` 为准；可交付前必须通过 typecheck、全量测试、build、pack dry-run。
- Guard 状态必须按 Agent / Turn 隔离。
- 只使用可观察 Tool / Result / Step / Turn 事件；结果指纹只保留哈希。
- `dsh-plugin-save-token` 继续负责工具结果压缩、展开和原文恢复。

### 禁止事项

- 禁止修改 `C:\Users\yansui\.dsh\profiles\desktop` 生产配置，除非先创建隔离副本并单独验证。
- 禁止复制第二套 Token Saver、TOON、原文展开或历史重写机制。
- 禁止调用 PI-Desktop / DSH 私有字段。
- 禁止读取、保存、输出或要求模型暴露隐藏思维链。
- 禁止只通过前端隐藏来实现 Disabled；实际执行入口必须继续拒绝。
- 禁止提交 `node_modules/`、`lib/`、`.tgz`、凭据、session、日志或本机 profile。
- 禁止把未验证的生产安装、npm 发布或 GitHub 推送写成已完成。

## 3. Progress（进展状态）

### Done（已完成）

- [x] 初始化 `dsh-agent-efficiency-guard` 插件仓库。
- [x] 保留并整理 Capability Menu 的能力目录、策略、`meta_search`、`meta_invoke` 和设置页。
- [x] 新增 `src/guard-core.ts`：Step / Tool / Time 预算、稳定签名、重复检测、无进展状态。
- [x] 新增 `src/guard.ts`：接入公开 DSH Agent / Tool Hook 和 `ctx.tools.guard()`。
- [x] 根入口通过 `config.guard` 挂载 Guard。
- [x] `cordis.patch.yml` 使用 `dsh-agent-efficiency-guard` 身份并默认启用 `normal` Guard。
- [x] Typert host-face 适配当前本机 `TypertRegistryContract` 类型。
- [x] Windows 测试夹具改为 `tmpdir()` 和平台安全路径。
- [x] 新增 `AGENTS.md`、README、运行时审计、宿主集成说明和验收文档。
- [x] 通过 `pnpm typecheck`。
- [x] 通过 `pnpm test`：14 个测试文件、203 个测试。
- [x] 通过 `pnpm build`。
- [x] 通过 `npm pack --dry-run`。
- [x] 已提交并推送到 GitHub `main`，代码修复最新提交为 `ad00daf`；本轮文档修改待提交。

### In Progress（进行中）

None。

### Blocked（受阻 / 待决策）

- [ ] 真实 Electron `desktop` profile 启动验证未完成：CLI dump 被宿主限制为 `profile "desktop" is managed exclusively by the Electron application`。
- [ ] PI-Desktop 没有发现公开 Token Saver / Prompt Cache 适配器，因此当前只做安全降级，不声明直接复用宿主服务。
- [ ] npm 尚未发布；当前只验证本地 pack dry-run。
- [ ] 隔离 profile 安装 smoke test 尚未执行。

## 4. Decisions（重要决策记录）

- **Capability Menu 与 Guard 合并为一个包**：减少两个包之间的配置、入口和维护分裂，满足最终独立安装要求。
- **保留 DSH 原生执行管线**：Tool 通过官方 `ctx.tools` 体系执行，避免绕过 DSH 权限、审批、Session 和 MCP Connector。
- **使用 `ctx.tools.guard()` 做单调最终拒绝**：Guard 预算拒绝不能被后续 Hook 重新放行，且不需要访问 Agent Loop 私有字段。
- **无进展检测只使用可观察事件**：不读取隐藏思维链，降低隐私风险并保持宿主边界清晰。
- **Save Token 不合并**：压缩、展开和原文落盘继续由 `dsh-plugin-save-token` 单独负责，避免双重压缩或结果链冲突。
- **默认 profile 使用 `normal`**：`quick` 对复杂任务过于激进，`deep` 会扩大成本；`normal` 作为日常折中值。
- **不直接改生产 profile**：当前桌面 profile 由 Electron 独占，先做隔离 profile 安装和回滚验证。
- **状态文件与旧 Capability Menu 名称保持兼容**：避免无迁移设计时破坏现有策略文件；如后续修改状态文件名，先补迁移测试。

## 5. Next Steps（下一步待办）

### 接手后第一项可直接执行

在仓库根目录执行以下命令，确认远端与本地状态一致：

```powershell
cd "C:\Users\yansui\Documents\agent workspace\dsh-agent-efficiency-guard\plugin"
git status --short --branch
git log -1 --oneline
git remote -v
```

预期：提交后工作区干净，分支为 `main`，远端为 `https://github.com/YAN3RA/dsh-agent-efficiency-guard.git`。

### 后续工作流

1. 创建 disposable DSH profile，复制现有 `desktop` profile 的必要配置，不触碰原 profile。
2. 停用旧 Capability Menu，只安装本插件。
3. 验证 `meta_search`、`meta_invoke`、三档策略、Guard、Save Token、MCP Session、设置页和 Typert 远程接口。
4. 记录启动日志、配置 dump、工具调用结果和回滚结果。
5. 若隔离验证通过，再由人工决定是否切换生产 profile。
6. 如需要 Guard 统计面板，再新增 UI 远程接口和对应测试，不修改现有能力目录行为。
7. 发布 npm 前更新版本、CHANGELOG（若创建）、验收报告和 annotated tag。

## 6. Context（关键上下文 / 现场信息）

### 文件路径

- `src/index.ts`：根入口和 Guard 挂载。
- `src/guard-core.ts`：Guard 纯逻辑核心。
- `src/guard.ts`：DSH Hook 接线。
- `cordis.patch.yml`：隔离 profile 的 bundle 入口和默认配置。
- `tests/guard-core.spec.ts`：Guard 专项测试。
- `tests/registry.spec.ts`：能力目录和状态行为测试。
- `tests/meta-search.spec.ts`：`meta_search` 测试。
- `tests/meta-invoke.spec.ts`：`meta_invoke` 测试。
- `docs/runtime-audit.md`：环境和上游基线。
- `docs/host-pi-desktop-integration.md`：宿主边界和无进展防护。
- `docs/acceptance-report.md`：验收范围和未完成项。
- `AGENTS.md`：仓库开发规则。
- `README.md`：给使用者的说明。

### Git 现场

- 仓库：`https://github.com/YAN3RA/dsh-agent-efficiency-guard.git`
- 分支：`main`
- 最新已推送提交：`ad00daf ci: run on main branch and add README status badge`
- 当前状态：README / HANDOFF 本轮仍有未提交修改，提交后需重新运行 `git status` 和 `git ls-remote --heads origin`。

### 环境与报错信息

- Node.js：`v24.22.1`
- npm：`12.2.1`
- pnpm：`11.28.5`
- DSH CLI：`0.2.1-rc.5`
- DSH peer 测试包：`0.2.1-rc.3`
- `dsh --profile desktop --dump-config`：`profile "desktop" is managed exclusively by the Electron application`
- 真实 GitHub 网络连接可能出现 `github.com:443` reset / timeout；推送前必须用 `git ls-remote --heads origin` 复核，不要仅凭 `git push` 返回判断远端状态。

### Recommended Skills（推荐技能）

- `cn.star.skill-learning/skill-learning`：本轮完成非简单文档/工程流程后，如需沉淀工作流经验再加载。
- `imported.ponytail/skill-36a767dac6c1dfbb`：需要继续进行插件治理或交付审查时使用。
- `imported.ponytail/skill-c6ae41efb87c0c18`：需要做代码/发布前审查时使用。
- `pi-desktop/imagegen`：仅在任务明确涉及光栅图片资产时使用，本项目常规开发不需要。
