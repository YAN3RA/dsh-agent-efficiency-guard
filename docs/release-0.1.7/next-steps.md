# 下一轮可执行项

更新：2026-11-01。唯一待办清单；HANDOFF 引用本文件，不另维护一组编号。

N1、N6、N7 的 Git 核对/获取/快进已完成。N2 隔离安装、N3 隔离验证/回滚、N4 生产方案、N5 发布材料与本地打包检查已完成。N8 已定位宿主 `spill-policy` 预览先于 Save Token 缓存，N11 已定位热重载异常归属，N9 已完成真实 Electron renderer 的部分验证但外部 MCP Session 授权未覆盖；见 N8/N11 诊断和 N9 证据。本轮未发布或改生产配置。

2. **N9 ·【推荐先做】补充真实 MCP Session/授权验收**：在独立 Electron profile 中配置一个本地测试 MCP server，验证连接、按会话注入、`meta_invoke` 不绕过授权及冷退出回滚；成本：约 20–40 分钟；建议：不调用模型，需先确定本地测试 server 方案。
3. **N10 · 审核并执行首次发布**：N9 的 MCP 授权和 renderer 截图证据补齐或用户明确接受限制后，复核候选版本并提交；得到外部动作授权后发布 tarball、创建 annotated `v0.1.7`、推送 main/tag；成本：约 10–20 分钟加 CI 等待；建议：当前 release gate 仍阻塞，不创建 tag、不发布、不推送。

## 关键证据与现场

- 详情：`report.md`；机器证据：`evidence/results.json`；包清单/哈希：`evidence/package.json`；生产方案：`production-rollout.md`。
- 截图：`evidence/capability-menu.png`，1440×1000；冷导航与设置页 0 个捕获异常；3 个 Typert 接口业务成功。
- 原始 runtime 断言：10 通过、超长样本 1 失败；随后只重跑 400 行样本，46,289 → 25,793 → 精确恢复 46,289 字符。不要报告成原始 11 项全通过。
- 回滚：本轮三包已卸载，初始 patch 恢复，首页 200、能力接口 404；测试服务、专用 Edge 和后台浏览器持有进程均已停止。
- 当前提交 `bc3604b`；源码逻辑未改，只有 exports 和文档/证据改动。最终包 63 文件，60 个运行时文件与实测安装包逐字节一致。
- scratch 内保留本轮脚本/原始日志/测试 home/临时 tgz；其生命周期随会话结束，长期结论以本目录文件为准，不把 scratch 当跨会话存储。
- N8 新证据：`evidence/n8-results.json`，默认 cap 12,500 下完整宿主文件哈希匹配；隔离 cap 200,000 下 174,389 字符全量展开通过。旧 `evidence/results.json` 保留历史失败，不视为当前未定位故障。
- N11 新证据：`evidence/n11-results.json`；N11 诊断：`n11-diagnosis.md`。隔离 profile 已卸载三包、恢复空 patch、停止宿主；真实 Electron `rebuilt` 帧仍未覆盖。
- N9 证据：`evidence/n9-results.json`，状态为 blocked；N10 的 release actions 尚未执行。
