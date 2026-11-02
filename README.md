# dsh-agent-efficiency-guard


<p align="center">
  <strong>把能力目录、按需调用、预算守卫和可观察的死循环防护放进一个 DSH 插件。</strong>
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.5-4D6BFE?style=flat-square&labelColor=161b22&logo=deepseek&logoColor=white" alt="DeepSeek Harness 0.2.1-rc.5" /></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/package-v0.1.8-CB3837?style=flat-square&labelColor=161b22&logo=npm&logoColor=white" alt="package version 0.1.8" /></a>
  <a href="https://github.com/YAN3RA/dsh-agent-efficiency-guard/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-configured-208B3A?style=flat-square&labelColor=161b22&logo=githubactions&logoColor=white" alt="CI configured" /></a>
  <a href="https://github.com/YAN3RA/dsh-agent-efficiency-guard/blob/main/docs/acceptance-report.md"><img src="https://img.shields.io/badge/tests-203%20passed-208B3A?style=flat-square&labelColor=161b22&logo=vitest&logoColor=white" alt="203 tests passed" /></a>
  <a href="https://github.com/YAN3RA/dsh-agent-efficiency-guard/stargazers"><img src="https://img.shields.io/github/stars/YAN3RA/dsh-agent-efficiency-guard?style=flat-square&color=dbab09&labelColor=161b22&logo=github&logoColor=white" alt="GitHub stars" /></a>
  <a href="https://github.com/YAN3RA/dsh-agent-efficiency-guard"><img src="https://img.shields.io/badge/npm-not%20published-6c757d?style=flat-square&labelColor=161b22&logo=npm&logoColor=white" alt="npm not published" /></a>
</p>

> 已完成 Windows 全量测试、隔离发布包安装和 DSH 0.2.1-rc.5 Web 冷启动验证。超长 Save Token 恢复、热重载及真实 Electron / MCP Session 验收仍有限制；详见 [验收报告](https://github.com/YAN3RA/dsh-agent-efficiency-guard/blob/main/docs/acceptance-report.md)。本轮未修改生产配置，也未发布 npm。

## 目录

- [它解决什么问题](#它解决什么问题)
- [插件能做到什么](#插件能做到什么)
- [环境与目录](#环境与目录)
- [安装与使用](#安装与使用)
- [验证插件结果](#验证插件结果)
- [贡献指南](#贡献指南)
- [许可证](#许可证)

## 它解决什么问题

DSH Agent 同时看到很多 Tool、MCP Tool 和 Skill 时，常见问题是：

- 每次请求都携带大量低频 Tool Schema，浪费上下文和 Token；
- Agent 反复搜索、重复读取或重复执行同一个调用；
- 模型不断产生步骤，但没有新的有效进展；
- 能力被前端隐藏了，实际执行入口却没有真正拒绝；
- Token Saver、MCP Connector 和能力菜单各自维护，边界不清楚。

这个插件把能力目录和执行守卫放到一个包里，同时保留 DSH 原生执行管线、`dsh-plugin-save-token` 和 `dsh-mcp-connector` 的职责边界。

## 插件能做到什么

### 1. 统一能力目录

- 索引 DSH 原生工具、MCP 工具和 Skills。
- 每项能力支持 `resident` 常驻、`on-demand` 按需、`disabled` 禁用。
- `meta_search` 搜索按需能力。
- `meta_invoke` 按精确 `id + kind` 查看、执行 Tool 或加载 Skill。
- Disabled 不只是从 Prompt 隐藏，执行入口也会拒绝。
- MCP Connector 的 Session 权限仍由 MCP Connector / DSH 宿主控制，本插件不绕过、不偷偷激活。

### 2. Agent Efficiency Guard

- `quick`、`normal`、`deep` 三种预算档位。
- 分开统计模型 Step 和业务 Tool Call。
- 限制单轮 Step 数、业务工具数和持续时间。
- 相同 Tool + 相同参数重复完成时提醒 Agent 检查已有结果。
- 通过公开 DSH `ctx.tools.guard()` 做最终工具预算拒绝。
- 默认最多一次收敛提示；提示后连续无进展达到阈值，阻止新的模型步骤。
- 状态按 Agent / Turn 隔离，取消、结束和 dispose 时清理。

### 3. 不读取隐藏思维链

循环防护只使用可观察事件：

- Tool 名称和参数的稳定哈希；
- Tool 结果的稳定指纹；
- Agent Step 准入；
- Tool 结果完成；
- `agent/turn-stopping` 边界；
- 取消和 Agent dispose。

插件不读取、保存、输出或要求模型暴露隐藏思维链，也不会伪造“任务已完成”的总结。

### 4. 和宿主 Token 能力协作

- 不重复实现 `dsh-plugin-save-token` 的压缩、展开和原文恢复。
- 不改写完整对话历史，不为了统计增加额外模型调用。
- 不调用 PI-Desktop / DSH 私有字段。
- 宿主没有公开 Token Saver / Prompt Cache 适配器时，安全降级并如实记录。

## 环境与目录

当前验证环境：

- Node.js `v24.22.1`
- pnpm `11.28.5`
- DSH CLI `0.2.1-rc.5`
- DSH peer 类型检查与单测基线 `0.2.1-rc.3`，隔离发布包运行时基线 `0.2.1-rc.5`
- Windows 环境全量测试通过

目录职责：

```text
src/       唯一源码：能力目录、策略、Guard、客户端、Typert 网关
tests/     Vitest 测试
docs/      运行时审计、宿主集成、验收报告
assets/    README / UI 静态资源
lib/       构建生成物，不手工修改
cordis.patch.yml  隔离 profile 使用的 DSH bundle patch
AGENTS.md  项目开发约束
HANDOFF.md 下一次 Agent 交接文档
```

`node_modules/`、测试缓存、`.tgz` 和本机状态由 `.gitignore` 排除。

## 安装与使用

### 1. 安装依赖并构建

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
npm pack --dry-run
```

### 2. 安装到隔离 DSH profile

在专用终端中创建独立 `DSH_HOME`，使用宿主 Web 模板和本地发布包验证：

```powershell
$env:DSH_HOME = Join-Path $env:TEMP ('dsh-guard-' + [guid]::NewGuid().ToString('N'))
dsh --profile guard-smoke --from-default-profile web --dump-config
npm pack --pack-destination $env:DSH_HOME
dsh plugin --profile guard-smoke add (Join-Path $env:DSH_HOME 'dsh-agent-efficiency-guard-0.1.7.tgz')
dsh --profile guard-smoke --host 127.0.0.1 --port 0 --no-open
```

此方式不复制生产凭据或外部 MCP 连接；结束后关闭专用终端，避免继续使用测试 `DSH_HOME`。本包尚未发布 npm，不要把 registry 安装写成已可用。`pnpm bridge` 是源码开发辅助命令，不属于发布包安装步骤。

不要直接切换正在使用的 `desktop` profile。生产变更前先备份配置和状态、关闭宿主，再按切换与回滚方案操作。

### 3. Agent 使用按需能力

1. 用 `meta_search` 找到能力。
2. 对精确 `id + kind` 再调用 `meta_search` 查看详情和参数 Schema。
3. 用 `meta_invoke({ id, kind, args })` 执行 Tool 或加载 Skill。

### 4. 默认 Guard 配置

`cordis.patch.yml` 默认使用：

- Guard：`normal`；
- 重复调用检测开启；
- 重复调用默认只提醒，不硬拦截；
- 每 Turn 最多一次收敛 steer；
- 连续两次无进展后停止下一模型步骤。

配置入口是 root entry 的 `config.guard`。计数状态不能改成全局单例，必须继续按 Agent / Turn 隔离。

## 验证插件结果

### 自动化验证

```powershell
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
```

当前已验证：

- `pnpm typecheck`：通过；
- `pnpm test`：14 个测试文件、203 个测试全部通过；
- `pnpm build`：通过；
- `npm pack --dry-run`：通过，包名 `dsh-agent-efficiency-guard`，版本 `0.1.7`。

Guard 专项测试：

```powershell
pnpm exec vitest run tests/guard-core.spec.ts
```

### 隔离 profile 手工验证

安装后至少确认：

- `meta_search`、`meta_invoke` 可用；
- Resident / On-demand / Disabled 同时影响 Prompt 可见性和实际执行；
- `ctx.tools.guard()` 能拒绝超出预算的下一次 Tool；
- 重复 Tool 默认提醒而不是误杀；
- 连续无进展会停止新的模型步骤，但不伪造最终答案；
- Save Token 仍能压缩/展开，且没有重复注册；
- MCP Connector Session Tool 不能被 `meta_invoke` 绕过；
- 设置页和 Typert 远程接口可以加载。

本轮未修改或重启生产 `desktop`。现场清单已包含本插件源码链接和 bundle，不能据此认定生产验收通过；详见 [验收报告](https://github.com/YAN3RA/dsh-agent-efficiency-guard/blob/main/docs/acceptance-report.md)。

## 贡献指南

### 开发原则

- 只改 `src/` 和对应的 `tests/`；不要手改 `lib/`。
- 新行为必须补测试。
- 修改 DSH Hook 前先核对本机 `@deepseek-ai/dsh-*` 类型定义。
- 保持 Windows 路径兼容，测试临时目录使用 `tmpdir()`。
- 不复制 Save Token 的压缩链，不调用宿主私有字段。
- 不读取、保存或输出隐藏思维链。
- 不在未验证的情况下声称支持某个 DSH 版本或生产 profile。

### 提交前检查

```powershell
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
git diff --check
```

提交说明应直接写明改了什么。涉及状态格式、公共 Typert ID、插件 entry ID 或生产 profile 时，应在 PR 中写迁移和回滚方案。

### 提交贡献

1. Fork 仓库并创建功能分支。
2. 阅读 [AGENTS.md](https://github.com/YAN3RA/dsh-agent-efficiency-guard/blob/main/AGENTS.md)、[HANDOFF.md](https://github.com/YAN3RA/dsh-agent-efficiency-guard/blob/main/HANDOFF.md) 和 `docs/` 下的审计文档。
3. 修改源码与测试。
4. 运行完整检查并把实际结果写入 PR。
5. 不提交 `node_modules/`、`lib/`、临时 `.tgz`、凭据、session 或本机 profile。

## 删除与卸载

只删除本地源码目录，在工作区上一级执行：

```powershell
Remove-Item -LiteralPath ".\\plugin" -Recurse -Force
```

这只删除当前工作区的 `plugin` 目录，不会卸载 DSH，也不会删除 `C:\Users\yansui\.dsh` 下的 profile、状态文件或已安装插件。

如果已经安装到隔离 profile，先停 DSH，再执行：

```powershell
dsh plugin --profile <isolated-profile> remove dsh-agent-efficiency-guard
```

删除本地源码目录不等于生产卸载。生产卸载前要备份 patch、恢复旧 Capability Menu 状态，并验证旧 Tool 和 Skill 已恢复。

## 许可证

本项目使用 [Apache License 2.0](LICENSE)。

