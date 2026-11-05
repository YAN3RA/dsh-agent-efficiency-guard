# dsh-agent-efficiency-guard

把 DSH 的能力目录、按需调用和 Agent 效率守卫整合为一个插件。

## 功能

- `meta_search` 按需查找能力，`meta_invoke` 调用能力。
- Resident、On-demand、Disabled 三档策略；Disabled 会在执行入口拒绝调用。
- 按 Agent / Turn 跟踪 Step 与业务 Tool 调用；循环核心按相同结果/错误证据提供 3/5/8 次重复提醒及 A-B 循环提醒，并仅对匹配调用局部拒绝一次，不停止整个 Turn。
- 工具结果压缩与原文恢复由 [dsh-plugin-save-token](https://github.com/YAN3RA/dsh-plugin-save-token) 负责；模型、Provider 和完整会话由 DSH 宿主负责。

## 安装

发布版本：[`v0.1.9`](https://github.com/YAN3RA/dsh-agent-efficiency-guard/releases/tag/v0.1.9)。该项目采用 GitHub 安装渠道，未发布 npm 包，也没有独立的 Release tarball asset。请从仓库获取源码，并使用 DSH 插件管理器支持的 Git 或本地包来源安装。

## 配置

默认 Guard 模式为 `normal`。当前 Step、Tool 次数、Duration 阈值只保留配置校验和计数，不触发软提醒或硬停止。`stepLimitMode: hard-stop` 会归一为 `warn-only`，`duplicateHardBlock: true` 会归一为 `false`，启动时分别记录弃用提示。开启 `duplicateDetection` 时，连续重复的第 3/5/8 次与有证据的 A-B 循环会提醒；只有相同操作及结果/错误指纹满足策略门槛后，才会通过 `tools.guard` 对匹配调用局部拒绝一次，不停止整个 Turn。配置位于插件 root entry 的 `config.guard`，状态按 Agent / Turn 隔离。

## 来源与许可

本项目基于 Capability Menu 实现，并按 Apache License 2.0 发布。详见 [LICENSE](LICENSE)。