# HANDOFF

更新：2026-11-06 02:45。仓库：`YAN3RA/dsh-agent-efficiency-guard`；分支：`main`；已发布 **v0.1.10**。

## 当前状态（一句话）

v0.1.10 已提交、已推送、已发布 Release（含 tarball 附件）；本机 profile 已从 `link:` 切回 Release 附件 URL 并安装 0.1.10；**Host 未重启，新 UI 尚未在 GUI 中生效**。

## 一、本轮完成（五项）

### 1. DSH v0.2.2-rc.1 兼容（代码）

| 项 | 值 |
| --- | --- |
| 本机 dsh CLI | `0.2.2-rc.1` |
| 安装路径 | `C:\Users\yansui\AppData\Local\Programs\DeepSeek Harness`（**目录名是空格**） |
| 运行时 node / pnpm | `24.21.0` / `11.28.5` |
| Cordis | `4.1.0` |

**两个真实破坏点**（升级后编译即失败）：

1. `ToolsService.execute` 改为批量契约，`ToolBatchInput` 无 `parent`。`meta_invoke` 单次转发改用 `ToolExecutionPipeline`（prepare → dispatch → complete），血缘保留。
2. `system-prompt/assemble` 不再拥有工具声明（provider 的 `tools` 在水位后被原样贴回）。按需隐藏改由 `agent/created` 时施加的 agent 作用域 `tools.restrict({ deny })`。

**关键回归修复：** `meta_invoke` 转发按全局视图解析本插件分类为 on-demand 的目标，否则「按需工具反而无法 meta_invoke」。别人的 restrict 仍然生效。

**两个必须保留的坑：**

- `policy.ts` 的 `applying` 重入守卫不能删。`restrict()`/`dispose()` 都 emit `tools/change`；无守卫会把外层刚装的 mask dispose 掉，导致 **Resident 工具被永久隐藏**。
- `meta_invoke` 的全局视图回退必须限定在「本插件判定为 on-demand」的名字上。

详见 `docs/release-0.2.2/compat-impact.md`（行号已逐条核对）。

### 2. 设置页改为四页签

顺序：**总览 → 思考限制 → 能力目录 → 调用统计**。

| 文件 | 作用 |
| --- | --- |
| `src/client/PluginSection.tsx` | 四页签外壳，`SegmentedTabs`，面板用 `hidden` 切换保留订阅 |
| `src/client/OverviewPanel.tsx` | 总览纯视图（无 hook，可被测试遍历） |
| `src/client/OverviewContainer.tsx` | 总览容器，读真实 usage 快照（7 天口径） |
| `src/client/GuardPanel.tsx` | 思考限制，A/B/C 三段 + 模型侧标识 |

- **思考限制**：删除了「当前生效」摘要栏（信息由总览承担，避免两处不同步）。三段标题对用户是中文，同时显示模型侧英文标识 `duplicate_call` / `alternating_cycle` / `no_progress`。
- **调用统计**：类型标签改为 `原生工具` / `MCP 工具` / `Skills` / `第三方插件`。真实页原本就没有「未完成」「失败率」列，只有成功/失败，无需删除。
- 顺带修了一个真 bug：`tabCatalog`/`tabUsage` 两个 key 在语言字典里根本不存在，页签标签一直是空字符串。已补齐中英文。

### 3. 验证（2026-11-06 02:35，亲自复跑）

- `tsc -p tsconfig.json --noEmit` → EXIT=0
- `tsc -p tsconfig.client.json --noEmit` → EXIT=0
- `vitest run` → **31 个文件 / 546 项全部通过**
- `pnpm build` → 通过；`npm pack` → 111 files

### 4. 发布

- commit `7babecf`（兼容 + UI）、`f6c7a69`（版本号）
- tag `v0.1.10` 已推送
- Release：https://github.com/YAN3RA/dsh-agent-efficiency-guard/releases/tag/v0.1.10
- 附件：`dsh-agent-efficiency-guard-0.1.10.tgz`（324369 字节，state=uploaded）

### 5. profile 安装来源已切回 Release 附件

`~/.dsh/profiles/desktop/package.json` 现为：

```
"dsh-agent-efficiency-guard": "https://github.com/YAN3RA/dsh-agent-efficiency-guard/releases/download/v0.1.10/dsh-agent-efficiency-guard-0.1.10.tgz"
```

核实结果：

- 安装目录是**实体目录**，不是符号链接（无 `src/`、无 `docs/`，符合 tarball 内容）
- 版本 `0.1.10`
- `lib/client.js` SHA256 与本地构建逐字节一致（`993C00F1…109D`）
- 全部 `lib/**/*.js` 通过 `node --check`
- `lib/index.js` 只有一次 `registerCapabilityPolicyHostFace(...)` 调用

**安装时必须走代理**：直连 GitHub 会 `ETIMEDOUT`。用 `HTTPS_PROXY=http://127.0.0.1:7890`。

### 6. 清理

已删除：`%TEMP%\css-prune-backup`（3 个 11-05 的 CSS 清理备份）、`%TEMP%\tgz-trash-latest`（0.1.7/0.1.8 旧包）、仓库内 `dsh-agent-efficiency-guard-0.1.9.tgz`。删除前已核对路径与文件清单。

## 二、未完成 / 未验证（必须知道）

1. **Host 未重启，新 UI 尚未生效。** Host 于 1:52 启动，而安装产物构建于 2:39。GUI 里现在看到的仍是旧两页签。重启 DSH 后才会看到四页签。
2. **未做真实 GUI 视觉回归。** 四页签切换、思考限制开关、总览真实数据、深色主题，均未在真实 Host GUI 中确认。
3. **思考限制的开关目前是只读呈现。** `GuardPanel` 的 `onToggle`/`onReset` 尚未接到 Remote：Guard 配置目前只来自 patch 文件，没有读写它的 Remote 方法。要真正可改，需要新增一个 Guard 配置 Remote（读写 patch 或独立状态文件）。**这是本轮明确未做的功能，不是 bug。**
4. **总览的 Guard 状态未接真实配置**，`guardEnabled`/`duplicateThresholds`/`tiers` 目前未传入，因此显示 `—`。等第 3 项的 Remote 落地后再接。
5. 未验证：`resume`/preset 作用域下 `agent/created` 时序、PTC(`run_code`) 组合、并发多个 `meta_invoke`、与第三方 restrict 叠加、0.2.1-rc.3 回退路径。
6. `meta_invoke` 单次转发不再经过所选 executor 的调度器（并发分类、`maxParallelToolCalls`），单次转发无影响但语义不完全等价。

## 三、下一轮可执行项

1. **重启 DSH 验证四页签 UI** — 打开 设置 → 插件，确认顺序为 总览 / 思考限制 / 能力目录 / 调用统计，四页均可切换，深浅色可读。成本 3 分钟。这是唯一未闭环的验收项。
2. **给思考限制接真实读写** — 新增 Guard 配置 Remote（`getGuardConfig` / `updateGuardConfig`），把 `GuardPanel` 的开关与总览的 Guard 状态接上。成本 1–2 小时。做完后思考限制页才真正可操作。
3. **总览接入 Guard 与策略统计** — 依赖第 2 项，接 `guardEnabled`、`duplicateThresholds`、`tiers`。成本 30 分钟。
4. **UI 预览稿同步** — `docs/design/preview/index.html` 已按同一套改动更新（56 项断言通过），但与真实页仍有差异（真实页无「未完成/失败率」列）。成本 10 分钟，可选。
5. **清理 `lib/` 与 node_modules 之外残留** — 仓库内 `dsh-agent-efficiency-guard-0.1.10.tgz` 是发布产物，`.gitignore` 已忽略，确认无需保留后可删。成本 1 分钟。

## 四、网络与推送规程（本轮实测）

- 直连 GitHub `push` 与 `pnpm install` 都可能超时；**代理 `http://127.0.0.1:7890` 可用**。
- 推送前先 `git ls-remote origin refs/heads/main` 比对；**超时不等于失败**。
- 推送命令：`git -c http.proxy=http://127.0.0.1:7890 push origin main --tags`，并在同一 shell 里 `unset HTTPS_PROXY HTTP_PROXY` 避免叠加。
- GitHub API 可用：从 `git credential fill` 取 token，`Authorization: Bearer <token>`。`gh` CLI 本机未安装。

## 五、工作区与安全边界

- 不提交 `node_modules/`、`lib/`、临时 `.tgz`、测试缓存、本机 profile、Session、凭据或原始日志。
- 本轮变更了 `~/.dsh/profiles/desktop/package.json` 的依赖来源（已授权）；备份在 `%TEMP%\profile-package.json.bak-v0110`。
