# 下一轮可执行项

更新：2026-11-01。唯一待办清单；HANDOFF 引用本文件，不另维护一组编号。

N1–N9 已完成，包括 N9 独立 Electron/MCP Agent Session 授权链 13/13 断言通过。N10 本地审核与 npm 认证已完成；版本 `0.1.7` 尚未发布。当前 GitHub 远端连接失败，push/CI 待网络恢复。生产配置未修改。
1. **N10 ·【推荐先做】完成首次发布收尾**：发布已审核的 `0.1.7` tarball，创建 annotated `v0.1.7`，待 GitHub 连通后推送 main/tag，并检查新 CI/Release。成本：本地发布与 tag 数分钟，远端等待视网络和 CI 而定；建议：npm 账号 `yan3ra` 已认证，registry 确认版本尚不存在；先完成 npm 发布，再处理 GitHub 连接失败。
2. **N10 ·【网络恢复后】推送 main/tag 并核验 CI/Release**：确认远端基线仍为 `cc382ee` 后推送审核提交与 `v0.1.7`，再检查 CI/Release；成本：数分钟加 CI 等待；建议：当前 GitHub 连接失败，重试前必须重新读取远端状态。


## 关键证据与现场

- 详情：`report.md`；机器证据：`evidence/results.json`；包清单/哈希：`evidence/package.json`；生产方案：`production-rollout.md`。
- 截图：`evidence/capability-menu.png`，1440×1000；冷导航与设置页 0 个捕获异常；3 个 Typert 接口业务成功。
- 原始 runtime 断言：10 通过、超长样本 1 失败；随后只重跑 400 行样本，46,289 → 25,793 → 精确恢复 46,289 字符。不要报告成原始 11 项全通过。
- 回滚：本轮三包已卸载，初始 patch 恢复，首页 200、能力接口 404；测试服务、专用 Edge 和后台浏览器持有进程均已停止。
- 当前本地提交 `f2f416d` 包含 N9 文档、证据和 fixture；远端最近已知 `main` 为 `cc382ee`，本轮查询因网络连接失败未刷新。typecheck、14 文件/203 测试、build、pack dry-run 全通过。候选包 63 文件、201,340 bytes；N9 fixture 未进入包，SHA-512 integrity 与此前验收包相同。
- scratch 内保留本轮脚本/原始日志/测试 home/临时 tgz；其生命周期随会话结束，长期结论以本目录文件为准，不把 scratch 当跨会话存储。
- N8 新证据：`evidence/n8-results.json`，默认 cap 12,500 下完整宿主文件哈希匹配；隔离 cap 200,000 下 174,389 字符全量展开通过。旧 `evidence/results.json` 保留历史失败，不视为当前未定位故障。
- N11 新证据：`evidence/n11-results.json`；N11 诊断：`n11-diagnosis.md`。隔离 profile 已卸载三包、恢复空 patch、停止宿主；真实 Electron `rebuilt` 帧仍未覆盖。
- N10 状态：`npm whoami` 成功返回 `yan3ra`，registry 查询 `0.1.7` 返回 E404（可用）；GitHub remote 检查连接失败。尚未执行 npm publish、创建 tag 或 push；本次提交尚未触发 CI。
