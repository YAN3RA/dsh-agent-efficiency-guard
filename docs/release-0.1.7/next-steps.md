# 下一轮可执行项

更新：2026-11-01。唯一待办清单；HANDOFF 引用本文件，不另维护一组编号。

N1–N9 已完成，N9 独立 Electron/MCP Agent Session 授权链 13/13 断言通过。N10 已按 GitHub 安装渠道推送 main 与 annotated `v0.1.7`；按用户决定不发布 npm。CI/Release 状态正在核验。生产配置未修改。
1. **N10 ·【检查中】核验本次 CI/Release**：读取 `v0.1.7` 触发的 workflow 与 Release 结果；成本：数分钟等待；建议：以具体 run/tag 结果为准，不把 main CI 成功当作 Release 已发布。


## 关键证据与现场

- 详情：`report.md`；机器证据：`evidence/results.json`；包清单/哈希：`evidence/package.json`；生产方案：`production-rollout.md`。
- 截图：`evidence/capability-menu.png`，1440×1000；冷导航与设置页 0 个捕获异常；3 个 Typert 接口业务成功。
- 原始 runtime 断言：10 通过、超长样本 1 失败；随后只重跑 400 行样本，46,289 → 25,793 → 精确恢复 46,289 字符。不要报告成原始 11 项全通过。
- 回滚：本轮三包已卸载，初始 patch 恢复，首页 200、能力接口 404；测试服务、专用 Edge 和后台浏览器持有进程均已停止。
- 当前候选与状态更新均已推送；N9 文档、证据和 fixture 在候选提交历史中。typecheck、14 文件/203 测试、build、pack dry-run 全通过。GitHub 安装使用 tag `v0.1.7`；npm 按用户决定未发布。
- scratch 内保留本轮脚本/原始日志/测试 home/临时 tgz；其生命周期随会话结束，长期结论以本目录文件为准，不把 scratch 当跨会话存储。
- N8 新证据：`evidence/n8-results.json`，默认 cap 12,500 下完整宿主文件哈希匹配；隔离 cap 200,000 下 174,389 字符全量展开通过。旧 `evidence/results.json` 保留历史失败，不视为当前未定位故障。
- N11 新证据：`evidence/n11-results.json`；N11 诊断：`n11-diagnosis.md`。隔离 profile 已卸载三包、恢复空 patch、停止宿主；真实 Electron `rebuilt` 帧仍未覆盖。
- N10：`main` 和 annotated `v0.1.7` 已推送；npm 未发布（用户决定改用 GitHub）。当前 CI/Release 结果待核验。
