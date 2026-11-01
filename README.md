# dsh-agent-efficiency-guard
[![CI](https://github.com/YAN3RA/dsh-agent-efficiency-guard/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/YAN3RA/dsh-agent-efficiency-guard/actions/workflows/ci.yml)

这是一个给 DSH 用的能力目录 + Agent 效率守卫插件。它已经把上游 Capability Menu 的核心能力和预算/死循环防护放进同一个可构建包里。

## 现在做到了什么

### 能力目录

- 统一索引 DSH 原生工具、MCP 工具和 Skills。
- 每项能力支持三档：`resident` 常驻、`on-demand` 按需、`disabled` 禁用。
- Agent 可以通过 `meta_search` 搜索按需能力，再通过 `meta_invoke` 精确查看/执行 Tool 或加载 Skill。
- Disabled 不只是从提示词隐藏，实际执行入口也会拒绝。
- MCP Connector 的 Session 权限仍由 MCP Connector 和 DSH 宿主控制，本插件不绕过、不偷偷激活。

### Agent 效率守卫

- `quick`、`normal`、`deep` 三种预算档位。
- 分开统计模型 Step 和业务 Tool Call。
- 限制单轮 Step 数、业务工具数和总时长。
- 相同工具 + 相同参数重复执行时提醒 Agent 检查已有结果。
- 只根据可观察事件判断无进展，不读取或保存模型隐藏思维链。
- 默认最多发出一次收敛提示；提示后连续无进展达到阈值，会阻止新的模型步骤。
- 每个 Agent、每个 Turn 独立计数，取消、结束和 dispose 时清理状态。

### 宿主 Token 边界

- 不重复实现 `dsh-plugin-save-token` 的压缩、展开和原文恢复。
- 不改写完整对话历史，不调用额外模型做总结。
- PI-Desktop / DSH 没有公开 Token Saver / Prompt Cache 适配器时，插件安全降级，不伪称已经调用宿主服务。
- 详细边界见 [宿主集成说明](docs/host-pi-desktop-integration.md)。

## 目录怎么分

```text
src/       源码：能力目录、策略、Guard、客户端、Typert 网关
 tests/    Vitest 测试
 docs/     运行时审计、宿主集成、验收与交接材料
 assets/   README / UI 使用的静态资源
 lib/      构建生成物，不手改
 cordis.patch.yml  隔离 profile 的 DSH bundle patch
```

`node_modules/`、测试缓存和临时打包文件不属于仓库内容；`.gitignore` 已排除。

## 怎么安装和使用

### 从源码安装到隔离 profile

先准备 Node.js、pnpm 和 DSH。当前本地验证过 Node.js `v24.22.1`、pnpm `11.28.5`、DSH `0.2.1-rc.5`，插件 peer 测试包为 DSH `0.2.1-rc.3`。

在本目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm build
npm pack --dry-run
```

然后只在隔离的 DSH profile 中安装生成的本地包：

```powershell
dsh plugin --profile <isolated-profile> add .
```

不要直接对正在使用的 `desktop` profile 做切换。生产切换前必须先复制 profile、备份 patch 和旧 Capability Menu 状态文件。

### 默认配置

`cordis.patch.yml` 默认启用：

- Guard：`normal`
- 重复调用检测：开启
- 重复调用硬拦截：关闭
- 每 Turn 最多一次收敛 steer
- 连续两次无进展后停止下一模型步骤

常用配置入口是 root entry 的 `config.guard`。不要把 Guard 计数器做成全局单例；状态必须跟 Agent / Turn 绑定。

### Agent 怎么用按需能力

1. 先调用 `meta_search` 找能力。
2. 对精确 `id + kind` 调用 `meta_search` 查看详情和参数 Schema。
3. 用 `meta_invoke({ id, kind, args })` 执行 Tool 或加载 Skill。

## 怎么验证插件结果

### 本地自动化验证

在 `plugin` 目录运行：

```powershell
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
```

当前已验证结果：

- `pnpm typecheck`：通过
- `pnpm test`：14 个测试文件、203 个测试全部通过
- `pnpm build`：通过，生成客户端 bundle 和服务端 `lib/`
- `npm pack --dry-run`：通过，包名为 `dsh-agent-efficiency-guard`

Guard 专项测试：

```powershell
pnpm exec vitest run tests/guard-core.spec.ts
```

### 手工隔离 profile 验证

安装到隔离 profile 后，至少检查：

- `meta_search`、`meta_invoke` 是否可用；
- Resident / On-demand / Disabled 是否同时影响提示词可见性和实际执行；
- `ctx.tools.guard()` 是否能阻止超出预算的下一次工具调用；
- 重复工具调用是否只提醒、不默认误杀；
- 连续无进展时是否停止新的模型步骤，且不伪造最终答案；
- Save Token 仍能压缩/展开，且没有重复注册；
- MCP Connector Session 工具不能被 `meta_invoke` 绕过；
- 设置页和 Typert 远程接口能加载。

当前生产 `desktop` profile 尚未切换。完整边界见 [验收报告](docs/acceptance-report.md)。

## 如何删除本地目录

如果只是删除本地工作区副本，在确认不再需要构建产物后，从上一级目录执行：

```powershell
Remove-Item -LiteralPath ".\\plugin" -Recurse -Force
```

这只删除当前工作区的 `plugin` 目录，不会卸载 DSH，也不会删除 `C:\Users\yansui\.dsh` 下的 profile、状态文件或已安装插件。

如果已经安装到隔离 profile，先停 DSH，再按该 profile 的插件管理方式移除：

```powershell
dsh plugin --profile <isolated-profile> remove dsh-agent-efficiency-guard
```

不要把删除本地源码目录当成生产卸载。生产卸载前要备份 patch、恢复旧 Capability Menu 状态，并验证旧工具和 Skills 已恢复。

## 文档入口

- [项目约束](AGENTS.md)
- [运行时审计](docs/runtime-audit.md)
- [PI-Desktop 宿主集成](docs/host-pi-desktop-integration.md)
- [验收报告](docs/acceptance-report.md)
- 工作区交接：[../HANDOFF.md](../HANDOFF.md)

## License
- 工作区交接：[HANDOFF.md](HANDOFF.md)
Apache License 2.0，见 [LICENSE](LICENSE)。
