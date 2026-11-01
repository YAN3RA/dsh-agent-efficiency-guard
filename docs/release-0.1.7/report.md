# 0.1.7 隔离验收与发布准备记录

日期：2026-11-01。起始源码提交：`cc382ee9a564cab72053a342c98cef04882af55b`。本轮随后只修改 package exports 与文档，未改插件运行逻辑。

## 结论

独立 DSH_HOME 的发布包安装、Web 冷启动、工具链、设置页、Typert 和卸载回退已取得证据。N8 已定位超长结果为宿主 `spill-policy` 的 12,500 Token 内联保留策略：Save Token 展开的是上游预览，完整原文仍在宿主 spill 文件中并已通过 SHA-256 校验；隔离上限放宽后同一大样本也可全量展开。N9 的真实 Electron renderer、本地 stdio MCP 连接和 Agent Session 授权链均已在隔离环境验收，13 项授权断言全部通过。未调用模型、未修改生产 profile；N10 的 npm/tag/push 仍需单独授权，不能据此宣称发布完成或完整生产兼容性验收通过。

## 环境与隔离边界

- Windows；开发 Node.js `v24.22.1`、pnpm `11.28.5`、Vitest `4.1.11`。
- typecheck / 单测使用项目锁定的 DSH peer `0.2.1-rc.3`；运行时使用已安装的 DSH `0.2.1-rc.5`（Electron 内置 Node.js `v24.21.0`）。这是两条验证基线，不混称同一环境。
- `DSH_HOME=<session scratch>/guard-isolated-home`，profile=`guard-smoke`，源自公开的 `web` 模板；未复制生产凭据、Session 或外部 MCP 连接。
- 安装实际 `.tgz`，未使用源码 link。共存包为 Save Token `2.4.1`、MCP Connector `0.2.87`。
- 测试服务仅监听 `127.0.0.1`；夹具使用真实 SessionStore、独立 Scope 和合成 Agent 主体，通过公开工具执行和事件 API 验证；没有调用模型。
- 测试夹具、原始启动日志、配置 dump、本机 profile 和访问令牌均留在 scratch，不进入 npm 包或 Git 提交。

## 已验证结果

| 项目 | 实际结果 |
| --- | --- |
| Git 同步 | `main` 从 `ab78a1c` 快进到 `cc382ee`，无分叉 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 14 个文件、203 项通过 |
| `pnpm build` | 通过；客户端 bundle 成功生成 |
| 发布包安装 | DSH plugin CLI 成功安装 `dsh-agent-efficiency-guard@0.1.7`，五个入口均出现在有效配置中 |
| 三档策略 | Resident / On-demand / Disabled 分类正常；界面显示三档测试能力 |
| 搜索与调用 | `meta_search` 列表/详情、`meta_invoke` 参数与调用者 Session 保留通过 |
| 执行拒绝 | Disabled 的直接与 meta 执行拒绝通过；已知 MCP 工具 ID 不能绕过调用者 Scope 拒绝 |
| Guard | 重复提醒最多一次；8 Step 硬预算、12 业务工具硬预算、Agent/Turn 隔离、一次 steer 与无进展停止均通过；控制面检索仍可用 |
| Save Token 常规样本 | 400 行、46,289 字符压缩至 25,793 字符；`save_token_expand` 返回值与展示文本均精确恢复全部 46,289 字符 |
| Connector 共存 | 宿主 ready 后 Connector 管理工具挂载，含 `mcp_connector_session_tools`；没有连接外部 MCP server |
| Typert | `getConfig`、`classifyAll`、`catalogVersion` 均 HTTP 200 且业务 `ok:true`；测试时目录 68 项 |
| 浏览器 | Edge 无头实测，冷导航和能力菜单页均 0 个捕获异常；截图 1440×1000 |
| 回退 | 停服后卸载本轮三个测试包、恢复初始 patch；dump 无测试入口；基线冷启动首页 200，`capabilityPolicy/getConfig` 404 |

原始完整运行中的 11 项断言有 10 项通过、超长 Save Token 样本 1 项失败；随后仅以 400 行样本重跑 Save Token 并通过。不能把这两轮结果写成“原始 11 项全通过”。

机器可读的去敏证据：[evidence/results.json](evidence/results.json)。实际截图：[evidence/capability-menu.png](evidence/capability-menu.png)。

## 已知限制

1. **超长结果已定位（N8 完成）**：默认宿主上限 `maxInlineTokens: 12500` 下，174,389 字符输入展开为 49,933 字符的上游预览，宿主定位器文件仍完整且 SHA-256 相同。49,984/49,985 边界对照成立；仅将隔离上限改为 200,000 后，同一输入的展开值、展示文本和 Save Token 文件全部精确恢复。默认“展开即最初原文”的假设仍不成立，应沿预览内宿主定位器分段读取；详见 [N8 诊断](n8-diagnosis.md) 和 [证据](evidence/n8-results.json)。未修改生产配置或 Guard 逻辑。
2. **热重载归属已定位（N11 完成）**：冷启动、隔离 profile patch reload、隔离 package manager 变更均无页面/服务错误，但公开 Web CLI 未触发 Electron Client Modules 的 `rebuilt` 替换帧。源码证据表明 `session-maybe` 异常来自宿主 Client Modules 串行 teardown 窗口；Connector 的 `layout` 异常来自其卸载路径缺少 `layout` Cordis inject/不安全 fallback。官方规避是安装/配置变更后冷重启或刷新页面；Connector 修复需上游处理。详见 [N11 诊断](n11-diagnosis.md) 和 [证据](evidence/n11-results.json)。
3. **N9 已通过隔离授权验收**：独立 `DSH_HOME`、Electron userData 和最终 tarball 环境下，真实 renderer 与此前保存的 1920×1233 CDP 截图证据保留；本次本地 synthetic stdio server 健康并注册 `n9_echo`，`injectionMode=session` 生效。13 项真实 Agent 断言全部通过：未授权直接和 `meta_invoke` 调用拒绝，search/preview/activation 正常，授权后的直接和 meta 调用均抵达 MCP server，另一 Agent 被隔离，deactivate 后两种调用再次拒绝；server marker 精确只有两条授权调用。没有 fatal 或 cleanup error；连接断开、剩余连接为 0、patch 恢复空列表，隔离 Electron/Host 已停止。未调用模型、未触碰生产 profile。详见 [N9 证据](evidence/n9-results.json) 与 [renderer 截图](evidence/n9-electron-renderer.png)。
4. **宿主 Token/Cache 接口**：仍未接入任何私有 Token Saver / Prompt Cache API；安全降级与职责边界保持不变。

## 生产现场与 N4

生产 manifest 已包含本插件源码 link 和 bundle；旧 Capability Menu 仅保留依赖而未列入 bundle。本轮未修改生产配置、未重启 Electron。构建确实更新了链接目标中的 `lib/`，应避免把源码链接视为固定版本部署。

生产变更的备份、安装、验收与回滚顺序见 [production-rollout.md](production-rollout.md)。建议先处理上面的实际限制，再决定生产变更。

## N5 发布准备

- 保留版本 `0.1.7`，不因一次未发布的首个候选而盲目 bump。发布前重新确认 registry 中该版本可用。
- 删除未进入 tarball 的 `./src/*` 导出；其余运行时 exports 必须逐项存在于最终 tarball 中。
- README 使用独立 DSH_HOME + Web 模板 + `.tgz` 的已验证安装方式；npm 页面所需的文档链接改为 GitHub URL。
- `pnpm bridge` 是源码开发辅助脚本，未打包；不把它列为安装后的运行依赖。正常 tarball 在宿主的公开模块解析机制下完成了运行验证。
- release job 只创建 GitHub Release，不发布 npm。annotated tag 必须恰好为 `v0.1.7`，说明非空且不能只有 `Release v0.1.7`。
- 发布说明候选见 [release-notes.md](release-notes.md)。材料已提交为 `bc3604b`；本轮没有创建 tag、发布 npm 或推送。
- N9 真实 Electron Agent Session 授权验收已完成，13 项断言通过；其余发布准备完成后，N10 的 npm/tag/push 仍须另行明确授权。

完成剩余验收、审核本地改动并提交后，才可在明确授权下发布和推送标签。计划中的命令如下，本轮未执行：

```powershell
# 核对提交干净、package.version 和 tag 不冲突后，再创建带实质说明的标签。
git tag -a v0.1.7 -F docs/release-0.1.7/release-notes.md
# npm 发布使用已验收、哈希一致的 tarball；实际路径以 evidence/package.json 为准。
# npm publish <verified-tarball> --access public --registry https://registry.npmjs.org/
# git push origin main
# git push origin v0.1.7
```

标签应指向包含最终材料的已审核提交，不能因为本次验证从 `cc382ee` 开始，就把新版本标签强行打在旧提交上。
