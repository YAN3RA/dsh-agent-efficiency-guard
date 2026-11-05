# dsh-agent-efficiency-guard

## 项目概述

独立 DSH 插件，融合 Capability Menu 的能力目录、按需检索/调用与 Resident / On-demand / Disabled 策略，并增加 Agent Efficiency Guard。插件只使用 DSH 插件公开接口；Guard 只管理本插件的 Agent / Turn 执行限制。DSH 宿主负责模型与会话，Save Token 负责工具结果压缩和原文恢复。

## 环境与命令

- TypeScript / TSX，pnpm，Vitest；锁定环境见 `package.json` 与 `pnpm-lock.yaml`。
- 安装：`pnpm install --frozen-lockfile`
- 检查：`pnpm typecheck`、`pnpm test`
- 构建：`pnpm build`
- 发布包检查：`npm pack --dry-run`
- 当前 DSH peer / 实际宿主版本及验证边界以 `HANDOFF.md` 和 `docs/acceptance-report.md` 为准。

## 架构与目录

- `src/`：唯一运行时代码来源；能力目录、策略、Guard、客户端与 Typert 网关。
- `tests/`：Vitest。每个新行为补对应测试；Windows 路径使用 `node:os` 的 `tmpdir()` 和 `node:path`。
- `lib/`：由 `pnpm build` 生成，禁止手工编辑。
- `cordis.patch.yml`：插件 bundle patch；不复制真实用户 profile 配置。
- `docs/`：运行时审计、宿主集成、验收结果、诊断与发布材料；`HANDOFF.md` 只记录当前进度。

## 开发规矩

- 修改 DSH Hook 前核对当前 `@deepseek-ai/dsh-*` 类型定义与公开 API，不从旧示例猜接口。
- Disabled 必须在实际执行入口拒绝调用，不能只隐藏前端 Schema。
- Guard 状态按 Agent / Turn 隔离；当前 N7 适配器使用工具签名、Step 与 tools/result 的结果/错误指纹。只保留 SHA-256 和有界计数/循环历史，不保存原始参数或结果；不读取、保存或输出隐藏思维链。
- Guard 新版目标：`stepLimitMode` 仅为旧配置兼容保留，`hard-stop` 强制降级为 `warn-only` 并提示弃用，`hardSteps` 不拒绝 Step；`soft*` / `hard*` 阈值当前只参与配置校验，不产生诊断、提醒或停止。`duplicateHardBlock: true` 降级为 `false` 并提示弃用。开启 `duplicateDetection` 时连续重复的第 3/5/8 次与有证据的 A-B 循环会提醒；只有相同操作及结果/错误哈希证据满足门槛后，才通过 `tools.guard` 对匹配调用局部拒绝一次，不得停止整个 Turn。

- N7 源码与 Hook 回归测试已接入；生成的 `lib/` 仍可能是旧产物，未构建并验证前不得据此宣称生产 Host 已使用 N7。
- 不重复实现 Save Token 的压缩、展开、原文落盘或历史重写；不调用 DSH 私有字段。没有公开适配器时安全降级并如实记录。
- Prompt 投影和 `meta_search` 输出保持短、稳定、可缓存；不为统计增加模型请求。
- 改状态文件格式时先补迁移测试并保留旧文件回滚能力。
- 测试使用临时目录和平台安全路径；不硬编码 POSIX `/tmp`。

## 验证与发布

改源码或行为后运行：

```powershell
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
```

只有四项全部通过，才可称版本本地验证通过。版本号以 `package.json` 为准；GitHub Release tag 必须为匹配版本的 annotated `v<version>`，并包含实质说明。发布渠道与 CI 工作流见 `.github/workflows/ci.yml`。不得因本项目采用 GitHub 安装而执行 npm publish。

不提交 `node_modules/`、`lib/`、临时 `.tgz`、测试缓存、本机 profile、Session、凭据或原始日志。

## 已知边界与修改授权

- 历史 0.1.7 N8（上游结果保留验证，区别于当前 N8 调用统计核心）：默认宿主 spill policy 可能让 Save Token 展开上游预览；完整原文定位与限制见 `docs/host-pi-desktop-integration.md` 的 Verified upstream result retention 与 `docs/release-0.1.7/n8-diagnosis.md`。
- N11：真实 Electron `rebuilt` 热重载帧未覆盖；已知限制见 `docs/release-0.1.7/n11-diagnosis.md`。
- 隔离 N9 Agent Session 授权链通过 13/13 断言，不代表完整生产兼容性验收通过。
- 默认不触碰 `C:\Users\yansui\.dsh\profiles\desktop`。生产安装、切换旧 Capability Menu、批量删除/移动用户配置属于单独操作，先说明影响并取得明确授权。
- 可直接修改源码、测试、文档、patch、package 元数据和 CI；任何外部发布、生产 profile 变更都须按本轮授权执行。