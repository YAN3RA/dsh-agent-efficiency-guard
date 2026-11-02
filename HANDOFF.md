# dsh-agent-efficiency-guard — HANDOFF

更新：2026-11-01。N9 已通过；唯一后续清单见 [next-steps.md](docs/release-0.1.7/next-steps.md)。

## 目标与边界

把 Capability Menu 的能力目录、按需调用、三档策略与 Agent Efficiency Guard 合并为一个可独立安装的 DSH 插件。

已完成 N7、N2、N3、N4、N5、N8、N9、N11。N9 使用独立 scratch Electron/profile 验收；生产 profile 文件未被修改。
真实 Electron renderer、本地 stdio MCP 初始化/工具同步、按会话模式设置、13 项 Agent Session 授权断言及隔离回滚均已完成。N10 `v0.1.7` 与 `v0.1.8` GitHub Release 已创建；本地检查通过，CI 状态未能确认。`main` 与 annotated `v0.1.8` 指向 `66a59f247caf30609a806fc2e560c71f8be4f021`；用户决定不发布 npm。不接入私有 Token Saver / Prompt Cache API。

## 必须保持的约束

- `src/` 是源码；`lib/` 只由构建生成，不手改。新运行行为须有测试，Windows 路径使用 `tmpdir()` / `node:path`。
- 改 DSH Hook 前核对当前宿主公开类型定义；不调用私有字段，不读取或保存隐藏思维链。
- Guard 按 Agent / Turn 隔离；只用可观察事件和哈希。Disabled 必须在实际执行入口继续拒绝。
- Save Token 保持压缩、展开、原文存储职责；本插件不实现第二套链路。
- 不写生产 `desktop` profile，不绕过 Electron 管理保护。生产变更与发布按当前授权和隔离验收结果单独执行。
- 不提交 `node_modules/`、`lib/`、临时 `.tgz`、本机 profile、Session、日志或凭据。
- 完整规则见 [AGENTS.md](AGENTS.md)。

## 当前结果

- N7：`main` 从 `ab78a1c` 快进到 `cc382ee9a564cab72053a342c98cef04882af55b`（`Remove related documentation section`），与获取后的 `origin/main` 一致。
- N2：独立 scratch `DSH_HOME`、`guard-smoke`、公开 `web` 模板；成功安装实际 `0.1.7` tarball，五个入口均存在；未复制生产凭据和连接。
- N3：真实 SessionStore、每 Agent 独立 Scope、合成 Agent 事件验证；常规功能有证据，超长恢复存在失败。Web 设置页、3 个 Typert 接口和卸载回退验证通过。没有把 Web/Synthetic 测试冒称 Electron 全链路。
- N4：生产备份、变更和回滚方案已写好，未实施生产切换。
- N5：保留首个候选 `0.1.7`；删除未打包 `./src/*` 导出，修正 README 的安装方式和 npm 文档链接，更新验收与发布说明。
- 本地 `pnpm typecheck`、全量 14 文件/203 测试、`pnpm build`、`npm pack --dry-run` 均通过；最终包所有 14 个 export 目标存在，60 个运行时文件与实测安装包逐字节一致。
- 最终包 201,340 bytes、63 files；SHA-256 `9afcb5c6d164e81fde217971e46ff836895169ca747bfa126196957fda050003`。包位置只在当前 session scratch，长期元数据保存在证据目录。
- 本轮重新运行 `pnpm typecheck`、全量 14 文件/203 测试、`pnpm build`、`npm pack --dry-run`，均通过。包 63 文件、201,340 bytes；N9 fixture 不在 tarball；SHA-512 integrity 与既有验收包相同。N9 报告/截图/fixture 已提交 `f2f416d`。


## 暂停点（2026-11-01）

- **生产桌面未运行，需用户自行重启。** `C:\Users\yansui\.dsh\profiles\desktop` 未被写入或切换；本轮没有关闭或操作生产进程。
- **Git / 发布**：`main` 与 annotated `v0.1.8` 已推送并确认远端 peeled commit 为 `66a59f2`；GitHub Release 页面 HTTP 200。旧 `v0.1.7` 保持不变；npm 不发布。CI API 受 rate limit 限制，结果未确认。
- **隔离资源已回滚**：N9 报告 13/13 断言通过、无 fatal/cleanupErrors；连接已断开、剩余连接为 0，隔离 `cordis.patch.yml` 恢复 `[]`，Electron/Host/MCP/探针进程已停止。生产 profile 未写入或切换。
- **N9 已通过真实 Agent 授权边界**：公开 `session_tools` search/preview/activate/deactivate 均通过；未授权直接调用和 `meta_invoke` 被拒绝，显式授权后两者均成功，另一 Agent 被隔离，停用后两者再次拒绝。server marker 精确只有 `authorized-agent-only` 与 `authorized-meta-call` 两条调用。详见 `docs/release-0.1.7/evidence/n9-results.json`。
- **继续方式**：若继续 N10，只需在 GitHub API 限流恢复后核验 `v0.1.8` 的 CI run；不重跑既有本地检查，不改 tag。

## 真正的遗留与限制

- N8 已完成：宿主默认 `spill-policy.maxInlineTokens: 12500` 先生成约 49.93k 的头尾预览，Save Token 再缓存预览。默认新实验中 174,389 → 展开 49,933，但宿主定位器文件完整且 SHA-256 匹配；49,984/49,985 边界成立，隔离改为 200,000 Token 后同一输入的展开值/展示文本/文件全部精确恢复。不改 Guard 或生产配置；详情见 `docs/release-0.1.7/n8-diagnosis.md`。
- 首轮完整 runtime 断言 10 通过、1 失败；之后只重跑 Save Token 小样本并通过，不是原始 11 项全通过。
- N11 已完成：冷启动、隔离 patch reload 与隔离 package-manager 变更均 0 页面/服务异常；公开 Web CLI 未触发 Electron `rebuilt` 帧。源码归属已确认：`session-maybe` 是宿主 Client Modules 串行 teardown 窗口，Connector `layout` 是其客户端缺少 Cordis inject/卸载 fallback 问题。规避为变更后冷重启/刷新；第三方修复不上游不改本仓库。详情见 `docs/release-0.1.7/n11-diagnosis.md`。
- N9 已通过：独立 DSH_HOME/userData 中真实 Electron renderer（1920×1233 截图证据）与本地 stdio MCP Session 授权链均有记录。13/13 断言通过，marker 精确两条授权调用，隔离连接与进程已清理；零模型请求，生产 profile 未修改。详见 `docs/release-0.1.7/evidence/n9-results.json`。
- 生产 manifest 在本轮开始时已经含本插件的源码 link 与 bundle；旧 Capability Menu 仅在 dependencies，不在 bundle 列表。本轮未写生产配置，但构建更新了源码 link 的 `lib/` 目标，不可把源码链接当固定部署。
- 当前没有已验证的公开宿主 Token Saver/Prompt Cache 适配器，继续安全降级。

## 证据与接手路径

- [验收摘要](docs/acceptance-report.md)
- [完整隔离与发布准备记录](docs/release-0.1.7/report.md)
- [去敏结果](docs/release-0.1.7/evidence/results.json) 与 [截图](docs/release-0.1.7/evidence/capability-menu.png)
- [最终包证据](docs/release-0.1.7/evidence/package.json)
- [生产变更/回滚方案](docs/release-0.1.7/production-rollout.md)
- [annotated tag 发布说明候选](docs/release-0.1.7/release-notes.md)
- [N9 隔离授权验收证据](docs/release-0.1.7/evidence/n9-results.json)
- [唯一后续清单 N10](docs/release-0.1.7/next-steps.md)；[N8 根因与恢复证据](docs/release-0.1.7/n8-diagnosis.md)

当前工作区：`C:\Users\yansui\Documents\agent workspace\dsh-agent-efficiency-guard\plugin`；仓库 `https://github.com/YAN3RA/dsh-agent-efficiency-guard.git`。

环境：Node.js `v24.22.1`、npm `12.2.1`、pnpm `11.28.5`；单测/typecheck peer `0.2.1-rc.3`；实际 DSH runtime `0.2.1-rc.5`（内置 Node.js `v24.21.0`）。

隔离 profile 的三个测试包已卸载、patch 恢复初始状态；基线首页 HTTP 200、移除后的能力 API HTTP 404。测试宿主、专用 Edge 和浏览器后台持有进程均已停止。原始日志、脚本、令牌和临时包在 session scratch，不依赖它们跨会话存续。

## 已验证的工作方法

- 使用独立 `DSH_HOME` 和新模板，不复制生产凭据。`dsh profile` 不是子命令；用 `dsh --profile guard-smoke --from-default-profile web --dump-config` 初始化。
- 跨工具调用需要托管后台任务；普通终端创建的子进程会在工具命令结束后被回收。
- 在公开 `appReady.onReady` 后验证异步插件；无模型测试也必须创建真实 SessionStore 条目，并为每个合成 Agent 创建独立 `createScope` 后再注册。
- RPC 请求需 `type:'client-request'`、唯一 `rpcId`、`method:'capabilityPolicy/getConfig'`、`payload:{args:{}}`，POST 到 `/api/capabilityPolicy/getConfig`；同时检查 HTTP 和业务 `result.ok`。
- 当前 npm JSON pack 输出按包名分组，不是数组。正常 tarball 的宿主解析机制已可运行，不需要执行开发用 `pnpm bridge`。
- `pnpm remove` 不接受 `--ignore-scripts`；本轮用进程级 `NPM_CONFIG_IGNORE_SCRIPTS=true` 后执行卸载成功。
- release job 只创建 GitHub Release；tag 必须为 annotated `v<package.json version>` 且含实质说明。`v0.1.7` 与 `v0.1.8` 均已发布。
