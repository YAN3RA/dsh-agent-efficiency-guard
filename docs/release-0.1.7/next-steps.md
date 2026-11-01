# 下一轮可执行项

更新：2026-11-01。唯一待办清单；HANDOFF 引用本文件，不另维护一组编号。

N1–N9 已完成，包括 N9 独立 Electron/MCP Agent Session 授权链 13/13 断言通过。N10 本地审核及 tarball 校验已完成；npm publish 被 registry 以 E403 拒绝，要求 2FA 或启用 bypass 2FA 的 granular token。GitHub 443 当前不可达，tag/push/CI 未执行。生产配置未修改。
1. **N10 ·【推荐先做】完成 npm 首发**：在终端完成 npm 交互式 2FA，或由账号管理员提供已启用 bypass 2FA 的 granular token；发布重新校验的 `0.1.7` tarball 并查询 registry 确认。成本：数分钟；建议：凭据只在 npm 官方登录流程中输入，不通过聊天传递。
2. **N10 ·【网络恢复后】创建 annotated tag 并推送 main/tag**：先重新读取远端 main/tag，再推送审核提交与 `v0.1.7`，检查 CI/Release。成本：数分钟加 CI 等待；建议：当前 GitHub 443 连接失败，网络恢复前不要盲推。


## 关键证据与现场

- 详情：`report.md`；机器证据：`evidence/results.json`；包清单/哈希：`evidence/package.json`；生产方案：`production-rollout.md`。
- 截图：`evidence/capability-menu.png`，1440×1000；冷导航与设置页 0 个捕获异常；3 个 Typert 接口业务成功。
- 原始 runtime 断言：10 通过、超长样本 1 失败；随后只重跑 400 行样本，46,289 → 25,793 → 精确恢复 46,289 字符。不要报告成原始 11 项全通过。
- 回滚：本轮三包已卸载，初始 patch 恢复，首页 200、能力接口 404；测试服务、专用 Edge 和后台浏览器持有进程均已停止。
- 当前本地提交 `5198628` 更新了 N10 状态，父提交 `f2f416d` 包含 N9 文档、证据和 fixture；远端最近已知 `main` 为 `cc382ee`，本轮查询因网络连接失败未刷新。typecheck、14 文件/203 测试、build、pack dry-run 全通过。候选包 63 文件、201,340 bytes；N9 fixture 未进入包，SHA-512 integrity 与此前验收包相同。
- scratch 内保留本轮脚本/原始日志/测试 home/临时 tgz；其生命周期随会话结束，长期结论以本目录文件为准，不把 scratch 当跨会话存储。
- N8 新证据：`evidence/n8-results.json`，默认 cap 12,500 下完整宿主文件哈希匹配；隔离 cap 200,000 下 174,389 字符全量展开通过。旧 `evidence/results.json` 保留历史失败，不视为当前未定位故障。
- N11 新证据：`evidence/n11-results.json`；N11 诊断：`n11-diagnosis.md`。隔离 profile 已卸载三包、恢复空 patch、停止宿主；真实 Electron `rebuilt` 帧仍未覆盖。
- N10 状态：npm `whoami` 为 `yan3ra`，但 `npm publish` 收到 E403：需要 2FA 或启用 bypass 2FA 的 granular token；registry 仍返回 E404，版本未发布。GitHub remote 检查连接失败。没有创建 tag 或 push，本次提交尚未触发 CI。
