# N11：热重载异常归属与隔离对照

2026-11-01，N11 已完成。结论是：本插件不是两条异常的归属方；官方可支持的规避是安装/配置变更后冷重启或刷新页面，不在运行中的宿主执行热替换。MCP Connector 的 `layout` 报错还存在一个第三方包自身的最小修复候选，但本轮不修改第三方包。

## 隔离对照

环境为全新 scratch `DSH_HOME`、公开 Web 模板、最终 `0.1.7` tarball、Save Token `2.4.1` 和 MCP Connector `0.2.87`；没有复制生产凭据，没有模型请求。

| 场景 | 页面异常 | 服务端异常 | 结论 |
| --- | ---: | ---: | --- |
| 冷启动 | 0 | 0 | 基线通过 |
| 运行中修改隔离 `cordis.patch.yml` | 0 | 0 | 普通 Web CLI profile patch reload 未进入 Client Modules HMR replace 路径 |
| 运行中卸载并重新安装 Connector 包 | 0 | 0 | profile package manager 本身未触发 Web client HMR |

这三项不是“历史 HMR 异常全未发生”的反证：当前公开 Web CLI 没有触发 Electron renderer 的 `rebuilt`/Client Modules 替换帧。因此不把本轮 CLI 对照写成真实 Electron HMR 通过。去敏记录见 [evidence/n11-results.json](evidence/n11-results.json)。

## 两条异常的归属

### `SlotAssemblyError: scope 'session-maybe' rendered without an installed adapter`

宿主 `dsh-client-ui-renderer` 在渲染器中对缺失的 Scope adapter fail-loud。`session-maybe` 会解析到 `session` adapter，该 adapter 由 `dsh-client-ui-session` 通过 `ctx.slots.installScope('session', ...)` 挂在 fiber 生命周期上。

宿主 `dsh-client-modules` 的替换/协调路径逐条执行 teardown、import、refresh 和级联依赖重载；替换窗口中 ui-session adapter 可能已卸载，而旧消费者仍在渲染 `session-maybe`，于是抛出该错误。官方 HMR 语义是“替换插件并级联重载依赖方”，不是原地补丁；文档同时说明 bootstrap/Host release 变化需要刷新页面。

本插件客户端只声明 `slots`、`locale`、`remote`，注册自己的 `settings.section`，没有创建、提供或消费 `session`/`session-maybe` Scope adapter。它不能删除宿主的 `session` adapter，也不能关闭宿主 teardown 窗口。

### Connector `cannot get property "layout" without inject`

Connector `0.2.87` 客户端声明的 Cordis inject 是：`slots`、`sessions`、`workspaces`、`conversation`，没有 `layout`。但其 `disposeNativeEntry → leaveNativePanel` 卸载路径执行 `ctx.get('layout') ?? ctx.layout`。

当 `dsh-client-ui-layout` 正在 teardown 时，`ctx.get('layout')` 返回 `undefined`；回退访问 `ctx.layout` 时，Cordis 因当前 fiber 没有声明 `layout`，抛出 `cannot get property "layout" without inject`。Connector 的 package-level client inject 已包含 `@deepseek-ai/dsh-client-ui-layout`，但那只保证模块先到达，不等于当前客户端 fiber 声明了 `layout` 服务。

因此这条是 Connector 自身卸载路径缺少服务声明/不安全回退的问题；不是本插件的 `dsh.client.inject` 或 `cordis.patch.yml` 引入的服务缺失。

## 支持的处理方式

### 本插件和宿主侧

- 安装、升级、改 profile/package 后关闭当前宿主并冷启动；必要时刷新页面。
- 不在正在运行的宿主中做源码热替换、包卸载/重装或依赖树变更。
- 本方案已写入 [生产变更/回滚方案](production-rollout.md)，不需要新增插件代码。
- 不使用未记录语义的 `immediately` 或其他私有字段规避宿主生命周期。

### Connector 侧

存在上游可提交的最小修复候选：

1. 在 Connector 客户端 Cordis `inject` 数组中加入 `layout`；或
2. 删除 `?? ctx.layout` 回退，统一通过安全的 `ctx.get('layout')` 处理服务暂不可用。

两者都属于第三方 `dsh-mcp-connector` 的改动，本轮没有修改安装包、生产依赖或 `node_modules`。应由 Connector 上游发布修复后再升级验证，不能把本地 patch 当作本项目交付内容。

## 尚未覆盖

- 未在真实 Electron renderer 中触发 `rebuilt` 帧；因此无法判断历史事件是安装后的 Host release 变化还是具体 HMR rebuilt 事件。
- 没有验证 Connector 上游是否已发布修复；未访问网络或执行外部发布动作。
- 本轮未改生产 profile、未改第三方包、未创建提交或推送。
