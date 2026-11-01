# dsh-agent-efficiency-guard 项目约束

## 项目定位

这是一个可独立安装的 DSH 插件，融合 Capability Menu 与 Agent Efficiency Guard：

- `src/` 是唯一源码来源；不要直接修改 `lib/` 里的生成文件。
- 能力目录、`meta_search`、`meta_invoke`、Resident / On-demand / Disabled 策略来自上游 Capability Menu 基线。
- Guard 负责 Step / Tool / Time 预算、重复调用提醒和可观察的无进展循环停止。
- `dsh-plugin-save-token` 继续负责工具结果压缩与原文恢复；本项目不得再实现第二套压缩链。
- PI-Desktop / DSH 宿主继续负责模型、Provider、reasoning effort、完整历史和全局上下文预算。

## 目录约定

- `src/`：TypeScript/TSX 源码；按职责拆分能力目录、策略、Guard、客户端和 Typert 网关。
- `tests/`：Vitest 测试；每个新行为必须有对应测试，Windows 路径使用 `node:os` 的 `tmpdir()` 和 `node:path`。
- `docs/`：运行时审计、宿主集成、验收和后续设计记录。
- `assets/`：README 或设置页使用的静态资源。
- `lib/`：`pnpm build` 生成的发布产物；不得手工编辑。
- `cordis.patch.yml`：隔离 profile 使用的 bundle patch；不要把用户真实 `desktop` profile 的配置复制进来。
- `package.json` / `pnpm-lock.yaml`：依赖、exports、构建和发布契约；升级依赖时一起检查 peer 兼容范围。
- `AGENTS.md`：本项目开发约束。

## 开发流程

1. 先阅读 `docs/runtime-audit.md`、`docs/host-pi-desktop-integration.md` 和 `docs/acceptance-report.md`。
2. 先改 `src/` 与 `tests/`，再运行：

   ```powershell
   pnpm typecheck
   pnpm test
   pnpm build
   npm pack --dry-run
   ```

3. 修改 DSH Hook 前，先核对当前安装的 `@deepseek-ai/dsh-*` 类型定义；不要根据旧示例猜 API。
4. 修改能力策略时，保持 Disabled 的执行层拒绝，不得只隐藏前端 Schema。
5. 修改 Guard 时，保持 Agent / Turn 隔离；不要读取、保存或输出模型隐藏思维链。
6. 如果需要改变状态文件格式，先增加迁移测试，并保留旧文件回滚能力。
7. 生产 profile 只做隔离验证后再切换；本仓库默认不触碰 `C:\Users\yansui\.dsh\profiles\desktop`。

## Token 与宿主边界

- 不重复实现 Save Token 的压缩、展开、原文落盘或历史重写。
- 不调用 PI-Desktop / DSH 私有字段；宿主没有公开适配器时必须安全降级并如实记录。
- Prompt 投影和 `meta_search` 输出保持短、稳定、可缓存；不要为了统计增加额外模型请求。
- Guard 只使用可观察的工具签名、结果指纹、Step 和 Turn 事件；结果指纹只保留哈希，不保存完整结果。

## 版本与发布

- 版本号以 `package.json` 为准；发布前必须更新 `CHANGELOG.md`（若创建）和 `docs/acceptance-report.md`。
- GitHub 仓库：`https://github.com/YAN3RA/dsh-agent-efficiency-guard`。
- 只有 `typecheck`、全量测试、`build` 和 `npm pack --dry-run` 全部通过，才可把版本标记为可交付。
- 不提交 `node_modules/`、测试缓存、临时 `.tgz`、本机 profile、凭据、session 或日志。

## 修改边界

可以直接修改：源码、测试、文档、`cordis.patch.yml`、package 元数据和 CI。

必须先说明并单独验证：生产 profile 安装、切换旧 Capability Menu、批量删除或移动用户配置、发布 npm 包、推送带凭据的外部内容。
