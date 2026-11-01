# dsh-agent-efficiency-guard — HANDOFF

更新：2026-11-01。本文件保留接手所需现场；唯一待办清单见 [next-steps.md](docs/release-0.1.7/next-steps.md)。

## 目标与边界

把 Capability Menu 的能力目录、按需调用、三档策略与 Agent Efficiency Guard 合并为一个可独立安装的 DSH 插件。

本轮执行 N7 → N2 → N3 → N4 → N5：快进同步、隔离 tarball 安装、集成/回滚验证、生产方案和发布准备。没有发布 npm、创建 tag、Git 提交/推送或修改生产配置，也没有重启现用 Electron。

真实 Electron renderer、实际模型回合、外部 MCP Session 授权与专门 Guard 统计面板未在本轮实施；不接入私有 Token Saver / Prompt Cache API。

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
- 本轮材料已提交为 `bc3604b`；未创建 tag、未发布 npm、未推送。当前候选不能声明完整生产兼容性通过。

## 真正的遗留与限制

- N8 已完成：宿主默认 `spill-policy.maxInlineTokens: 12500` 先生成约 49.93k 的头尾预览，Save Token 再缓存预览。默认新实验中 174,389 → 展开 49,933，但宿主定位器文件完整且 SHA-256 匹配；49,984/49,985 边界成立，隔离改为 200,000 Token 后同一输入的展开值/展示文本/文件全部精确恢复。不改 Guard 或生产配置；详情见 `docs/release-0.1.7/n8-diagnosis.md`。
- 首轮完整 runtime 断言 10 通过、1 失败；之后只重跑 Save Token 小样本并通过，不是原始 11 项全通过。
- N11 已完成：冷启动、隔离 patch reload 与隔离 package-manager 变更均 0 页面/服务异常；公开 Web CLI 未触发 Electron `rebuilt` 帧。源码归属已确认：`session-maybe` 是宿主 Client Modules 串行 teardown 窗口，Connector `layout` 是其客户端缺少 Cordis inject/卸载 fallback 问题。规避为变更后冷重启/刷新；第三方修复不上游不改本仓库。详情见 `docs/release-0.1.7/n11-diagnosis.md`。
- N9 blocked：现有用户 Electron 实例持有单实例锁；打包应用没有可用 CDP 端点，独立 DSH_HOME 未创建 desktop profile。当前生产 manifest 已含本插件 source link/bundle，但不等同真实 renderer 验收。N10 的 tag/npm/push release gate 因此仍阻塞；证据见 `docs/release-0.1.7/evidence/n9-results.json`。
- 生产 manifest 在本轮开始时已经含本插件的源码 link 与 bundle；旧 Capability Menu 仅在 dependencies，不在 bundle 列表。本轮未写生产配置，但构建更新了源码 link 的 `lib/` 目标，不可把源码链接当固定部署。
- 当前没有已验证的公开宿主 Token Saver/Prompt Cache 适配器，继续安全降级。

## 证据与接手路径

- [验收摘要](docs/acceptance-report.md)
- [完整隔离与发布准备记录](docs/release-0.1.7/report.md)
- [去敏结果](docs/release-0.1.7/evidence/results.json) 与 [截图](docs/release-0.1.7/evidence/capability-menu.png)
- [最终包证据](docs/release-0.1.7/evidence/package.json)
- [生产变更/回滚方案](docs/release-0.1.7/production-rollout.md)
- [annotated tag 发布说明候选](docs/release-0.1.7/release-notes.md)
- [N9 阻塞证据](docs/release-0.1.7/evidence/n9-results.json)
- [唯一后续清单 N9/N10](docs/release-0.1.7/next-steps.md)；[N8 根因与恢复证据](docs/release-0.1.7/n8-diagnosis.md)

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
- release job 只创建 GitHub Release；tag 必须为 annotated `v0.1.7` 且含实质说明。本轮未真实触发 release job。
