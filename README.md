# dsh-agent-efficiency-guard

把 DSH 的能力目录、按需调用和 Agent 效率守卫整合为一个插件。

## 功能

- `meta_search` 按需查找能力，`meta_invoke` 调用能力。
- Resident、On-demand、Disabled 三档策略；Disabled 会在执行入口拒绝调用。
- 按 Agent / Turn 管理 Step、Tool、Time 预算，提醒重复调用，并停止可观察到的无进展循环。
- 工具结果压缩与原文恢复由 [dsh-plugin-save-token](https://github.com/YAN3RA/dsh-plugin-save-token) 负责；模型、Provider 和完整会话由 DSH 宿主负责。

## 安装

发布版本：[`v0.1.8`](https://github.com/YAN3RA/dsh-agent-efficiency-guard/releases/tag/v0.1.8)。该项目采用 GitHub 安装渠道，未发布 npm 包，也没有独立的 Release tarball asset。请从仓库获取源码，并使用 DSH 插件管理器支持的 Git 或本地包来源安装。

## 配置

默认 Guard 模式为 `normal`：重复调用只提醒；每个 Turn 最多发送一次收敛提示；连续两次无进展后阻止下一模型步骤。配置位于插件 root entry 的 `config.guard`，计数按 Agent / Turn 隔离。

## 来源与许可

本项目基于 Capability Menu 实现，并按 Apache License 2.0 发布。详见 [LICENSE](LICENSE)。