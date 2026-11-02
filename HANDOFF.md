# HANDOFF

更新：2026-11-02。仓库：`YAN3RA/dsh-agent-efficiency-guard`；分支：`main`。

## 当前目标

维护 DSH 能力目录与 Agent Efficiency Guard 插件。用户安装入口见 [README.md](README.md)；AI 开发规则见 [AGENTS.md](AGENTS.md)。

## 当前状态

- 当前包版本：`0.1.8`。GitHub Release `v0.1.8` 已创建，annotated tag 指向提交 `66a59f2`；`main` 当前为 `d79d371`。旧 `v0.1.7` 保持不变。
- 0.1.8 仅更新版本元数据和文档，没有运行时代码变化；按用户决定不发布 npm。
- 最近本地验证通过：`pnpm typecheck`、`pnpm test`（14 文件 / 203 项）、`pnpm build`、`npm pack --dry-run`（63 files）。

## 验收边界

N9 隔离 Electron/MCP Agent Session 授权链 13/13 断言通过，不代表完整生产兼容性签核。N8 的超长结果行为及 N11 的 Electron `rebuilt` 帧限制仍按已有诊断记录；没有修改或切换生产 `desktop` profile。

详细运行与宿主边界见 [runtime audit](docs/runtime-audit.md)、[Host integration](docs/host-pi-desktop-integration.md) 和 [acceptance report](docs/acceptance-report.md)。0.1.7 隔离证据与诊断保存在 `docs/release-0.1.7/`。

## 未完成事项

GitHub Actions API 查询返回 403 rate limit exceeded，`v0.1.8` CI 结论尚未确认。限流恢复后只需查看对应 workflow run；不需要重跑本地检查或移动已发布 tag。

## 关键边界

- `src/` 是源码，`lib/` 由构建生成；新行为需补测试。
- Disabled 必须在执行入口拒绝；Guard 状态按 Agent / Turn 隔离。
- Save Token 继续拥有工具结果压缩与恢复；不调用宿主私有 API，不读取隐藏思维链。
- 默认不触碰 `C:\Users\yansui\.dsh\profiles\desktop`。生产 profile 变更须单独授权并隔离验证。
