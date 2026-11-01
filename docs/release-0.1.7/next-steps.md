# 下一轮可执行项

更新：2026-11-01。唯一待办清单；HANDOFF 引用本文件，不另维护一组编号。

N1–N9 已完成，包括 N9 独立 Electron/MCP Agent Session 授权链 13/13 断言通过。N10 仅剩外部发布动作，尚未授权或执行。生产配置未修改。
1. **N10 ·【推荐先做】审核并执行首次发布**：复核候选版本、最终提交与 registry 状态；经用户明确授权后发布 tarball、创建 annotated `v0.1.7`、推送 main/tag，并检查 CI/Release 结果。成本：本地准备约 10–20 分钟加发布与 CI 等待；建议：N9 已通过，但 npm/tag/push 是外部动作，仍须单独明确授权后才能执行。


## 关键证据与现场

- 详情：`report.md`；机器证据：`evidence/results.json`；包清单/哈希：`evidence/package.json`；生产方案：`production-rollout.md`。
- 截图：`evidence/capability-menu.png`，1440×1000；冷导航与设置页 0 个捕获异常；3 个 Typert 接口业务成功。
- 原始 runtime 断言：10 通过、超长样本 1 失败；随后只重跑 400 行样本，46,289 → 25,793 → 精确恢复 46,289 字符。不要报告成原始 11 项全通过。
- 回滚：本轮三包已卸载，初始 patch 恢复，首页 200、能力接口 404；测试服务、专用 Edge 和后台浏览器持有进程均已停止。
- 当前提交 `bc3604b`；源码逻辑未改，只有 exports 和文档/证据改动。最终包 63 文件，60 个运行时文件与实测安装包逐字节一致。
- scratch 内保留本轮脚本/原始日志/测试 home/临时 tgz；其生命周期随会话结束，长期结论以本目录文件为准，不把 scratch 当跨会话存储。
- N8 新证据：`evidence/n8-results.json`，默认 cap 12,500 下完整宿主文件哈希匹配；隔离 cap 200,000 下 174,389 字符全量展开通过。旧 `evidence/results.json` 保留历史失败，不视为当前未定位故障。
- N11 新证据：`evidence/n11-results.json`；N11 诊断：`n11-diagnosis.md`。隔离 profile 已卸载三包、恢复空 patch、停止宿主；真实 Electron `rebuilt` 帧仍未覆盖。
- N9 证据：`evidence/n9-results.json`，13/13 Agent 授权断言通过；真实 MCP marker 精确两条授权调用，隔离资源已清理。N10 外部发布动作尚未执行且仍需明确授权。
