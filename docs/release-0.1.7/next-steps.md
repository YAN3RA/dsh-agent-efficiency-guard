# 下一轮可执行项

更新：2026-11-01。唯一待办清单；HANDOFF 引用本文件，不另维护一组编号。

N1、N6、N7 的 Git 核对/获取/快进已完成。N2 隔离安装、N3 隔离验证/回滚、N4 生产方案、N5 发布材料与本地打包检查已完成。N8 已定位宿主 `spill-policy` 预览先于 Save Token 缓存，N11 已定位热重载异常归属，N9 已尝试但被 Electron 单实例锁/CDP 缺失阻塞；见 N8/N11 诊断和 N9 证据。本轮未发布或改生产配置，改动仍未提交。

2. **N9 ·【推荐先做】完成真实 Electron 与 MCP Session 验收**：用户关闭当前 DeepSeek Harness 实例后，用独立 DSH_HOME/userData 重新启动真实 Electron，取得 renderer 检查路径，验证设置页、实际会话和测试 MCP 授权隔离；成本：约 30–60 分钟，实际模型调用可能产生用量；建议：解除单实例和 CDP 阻塞前不发布。
3. **N10 · 审核改动、提交并执行首次发布**：N9 通过或用户明确接受其阻塞后，复核候选版本并提交；得到外部动作授权后发布 tarball、创建 annotated `v0.1.7`、推送 main/tag；成本：约 10–20 分钟加 CI 等待；建议：当前 release gate 仍阻塞，不创建 tag、不发布、不推送。

## 关键证据与现场

- 详情：`report.md`；机器证据：`evidence/results.json`；包清单/哈希：`evidence/package.json`；生产方案：`production-rollout.md`。
- 截图：`evidence/capability-menu.png`，1440×1000；冷导航与设置页 0 个捕获异常；3 个 Typert 接口业务成功。
- 原始 runtime 断言：10 通过、超长样本 1 失败；随后只重跑 400 行样本，46,289 → 25,793 → 精确恢复 46,289 字符。不要报告成原始 11 项全通过。
- 回滚：本轮三包已卸载，初始 patch 恢复，首页 200、能力接口 404；测试服务、专用 Edge 和后台浏览器持有进程均已停止。
- 当前提交 `cc382ee`；本轮源码逻辑未改，只有 exports 和文档/证据改动。最终包 63 文件，60 个运行时文件与实测安装包逐字节一致。
- scratch 内保留本轮脚本/原始日志/测试 home/临时 tgz；其生命周期随会话结束，长期结论以本目录文件为准，不把 scratch 当跨会话存储。
- N8 新证据：`evidence/n8-results.json`，默认 cap 12,500 下完整宿主文件哈希匹配；隔离 cap 200,000 下 174,389 字符全量展开通过。旧 `evidence/results.json` 保留历史失败，不视为当前未定位故障。
- N11 新证据：`evidence/n11-results.json`；N11 诊断：`n11-diagnosis.md`。隔离 profile 已卸载三包、恢复空 patch、停止宿主；真实 Electron `rebuilt` 帧仍未覆盖。
- N9 证据：`evidence/n9-results.json`，状态为 blocked；N10 的 release actions 尚未执行。
