# dsh-agent-efficiency-guard 0.1.7

首个独立包候选，将能力目录、按需检索与调用、三档暴露策略和 Agent 效率守卫整合为一个 DSH 插件。

- 保留 `meta_search`、`meta_invoke` 和 Resident / On-demand / Disabled 策略，Disabled 在实际执行入口拒绝。
- 新增按 Agent / Turn 隔离的 Step、业务 Tool 和 Time 预算、重复提醒、一次收敛提示及可观察的无进展循环防护。
- 继续使用宿主公开执行管线；工具结果压缩、展开和原文存储由 Save Token 负责，不接入私有 Token Saver 或 Prompt Cache API。
- 修正 Windows 测试路径，删除发布包中不存在的源码子路径导出，补充隔离安装与回滚说明。

Windows 类型检查、203 项单测和构建通过；DSH 0.2.1-rc.5 的隔离 tarball 安装、Web 冷启动、设置页、Typert 与卸载回退已有证据。

已知限制：默认宿主 `spill-policy` 会先生成超长结果的内联预览，Save Token 展开可能只恢复这份预览；N8 已验证预览内宿主定位器保存完整原文，且隔离放宽上限后同一 174,389 字符样本可精确恢复。不宣称任意长度均可全量内联。N11 已定位热重载异常归属：宿主 Client Modules 的串行替换窗口与 Connector 自身缺少 `layout` inject；公开 Web CLI 对照未触发 Electron `rebuilt` 帧，支持的规避是变更后冷重启/刷新。N9 已验证独立真实 Electron renderer、本地无凭据 stdio MCP 初始化与 `n9_echo` 工具同步、`injectionMode=session` 设置及 Agent Session 授权链；13 项断言全部通过，包含未授权/跨 Agent/停用后拒绝、授权后直接调用和 `meta_invoke` 成功，以及服务端 marker 精确记录两次授权调用。N10 已将 GitHub 安装渠道推送至 `v0.1.7`；按用户决定未发布 npm 包。

本说明是待审核的发布材料；GitHub `main` 与 `v0.1.7` tag 已推送。GitHub Actions 与 Release 的最终状态仍待核验；按用户决定未发布 npm 包。
