# HANDOFF

更新：2026-11-06 20:15。仓库：`YAN3RA/dsh-agent-efficiency-guard`；分支：`main`；已发布 **v0.1.13**。

## 当前状态（一句话）

v0.1.12 已提交、已推送、已发布 Release（含 tarball 附件）；本机 profile 已安装 0.1.12；**Host 未重启，0.1.12 的改动尚未在 GUI 中生效**。

v0.1.11 的核心：思考限制的三个开关**不再是假的**。此前 Guard 只有一个 `duplicateDetection` 总闸，而页面展示三个独立开关，其中两个改了不产生任何效果。

## 零点五、v0.1.12 变更

1. **思考限制每段补上功能说明**（用户反馈「只有三个开关没有说明，与预览版不符」）。九条说明走 i18n 中英文双语；固定 3/5/8 阈值只出现在 A 段。
2. **开关写入成功弹 Toast「已保存」**。开关是乐观更新的，光是它动了不能证明 Host 接受。
3. **调用统计覆盖文案与真实页对齐**：`unknown` 渲染为「覆盖未知：…0 不代表未使用」+ 工作区归属说明，**永不渲染成 complete**。预览页同步了这套文案并新增「覆盖未知」数据状态。

### 实测证据（不是推断）

- 生产状态文件 `~/.dsh/capability-menu-policy.json`：**mtime 18:37:48，version 3**，`guard` 段四项齐全 → 说明重启后新代码已运行、开关读写回路已通。
- 该文件 `tools` 段 **196 项全部是 `on-demand`，没有一项 resident**。这解释了当前会话为什么所有工具都要经检索；也意味着总览的「常驻」数会显示 0（或只含 meta 工具）。

### 验证

- `tsc`（Node + Client）均 EXIT=0
- `vitest run`：31 个文件 / **561 项**通过（v0.1.11 是 559，本轮 +2）
- 安装产物：实体目录、`lib/**/*.js` 全部 `node --check` 通过、`lib/client.js` SHA256 与本地构建一致
- 预览页：59 项断言通过

## 零、v0.1.11 变更（本轮）

### Guard 三段能力拆开并真正生效

| 开关 | 关闭后的真实行为 |
| --- | --- |
| `duplicate_call`（相同调用重复提醒） | 不再对重复调用发出提醒 |
| `alternating_cycle`（交替循环识别） | 检测器不再报告 A→B→A→B 循环 |
| `no_progress`（无进展保护） | 仍提醒，但**不再**局部拒绝任何调用 |

新增配置字段 `alternatingCycleDetection` / `noProgressProtection`（`guard-core.ts`、`guard.ts`），在 `guard-loop-core.ts` 的检测器里被真实遵守：`cycleSize` 受交替循环开关控制，`blockCandidate` 受无进展保护开关控制。

### 持久化：状态文件，不是 patch 文件

开关写入 `capability-menu-policy.json`（**version 3**，新增 `guard` 段；能读 v1/v2）。**关键**：dsh 会监视 patch 文件并在每次写入后重新应用插件，若把开关存进 patch，每拨一次开关就会重载一次插件。已有测试覆盖「v2 文件缺 guard 段读作未设置」与「非布尔值拒绝而非强转」。

### 即时生效

Guard 每次调用经 `ctx.capabilityPolicy.getGuard()` 读实时值，所以拨动开关**无需重启**即生效。`tests/guard.spec.ts` 有端到端用例：关掉总闸后同一批调用不再被拒绝；关掉无进展保护后仍提醒但从不拒绝。

### 接线链路

`policy.getGuard/updateGuard` → Typert Remote（`src/server/remote.ts`）→ host-face `METHODS` → client descriptors → `GuardContainer`。

总览现在读取真实的 Guard 开关、usage 快照与 `classifyAll` 分层统计，数字不再是占位值。

### 失败处理

- 读取失败：开关显示**不可用**，不是「关闭」——未知状态不伪装成选择。
- 写入失败：**回滚**到先前值并显示原因。

### 验证（2026-11-06 18:14 亲自复跑）

- `tsc`（Node + Client）均 EXIT=0
- `vitest run`：31 个文件 / **559 项**全部通过（v0.1.10 是 546 项，本轮新增 13 项）
- `pnpm build` 通过；`npm pack` 111 files
- 安装产物：实体目录（无 `src/`、无 `docs/`）、全部 `lib/**/*.js` 通过 `node --check`、`lib/client.js` 与 `lib/server/remote.js` 的 SHA256 与本地构建**逐字节一致**

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
3. ~~思考限制的开关只读~~ — **已在 v0.1.11 完成**：三个开关真实可读写、持久化到状态文件、拨动即生效。

4. ~~总览的 Guard 状态未接真实配置~~ — **已在 v0.1.11 完成**：总览读取真实 `getGuard()`、usage 快照与 `classifyAll()` 分层统计。
5. 未验证：`resume`/preset 作用域下 `agent/created` 时序、PTC(`run_code`) 组合、并发多个 `meta_invoke`、与第三方 restrict 叠加、0.2.1-rc.3 回退路径。
6. `meta_invoke` 单次转发不再经过所选 executor 的调度器（并发分类、`maxParallelToolCalls`），单次转发无影响但语义不完全等价。

## 三、下一轮可执行项

1. **重启 DSH 验证四页签 UI** — 打开 设置 → 插件，确认顺序为 总览 / 思考限制 / 能力目录 / 调用统计，四页均可切换，深浅色可读。成本 3 分钟。这是唯一未闭环的验收项。
2. ~~给思考限制接真实读写~~ — **已在 v0.1.11 完成**（见「零、v0.1.11 变更」）。
3. ~~总览接入 Guard 与策略统计~~ — **已在 v0.1.11 完成**。
4. **UI 预览稿同步** — `docs/design/preview/index.html` 已按同一套改动更新（56 项断言通过），但与真实页仍有差异（真实页无「未完成/失败率」列）。成本 10 分钟，可选。
5. **清理 `lib/` 与 node_modules 之外残留** — 仓库内 `dsh-agent-efficiency-guard-0.1.10.tgz` 是发布产物，`.gitignore` 已忽略，确认无需保留后可删。成本 1 分钟。

## 三点四、v0.1.13 变更

### 1. 原生工具调用此前一律归为「未知来源」（真 bug，已修）

`src/usage/usage-runtime.ts` 的 `createClassifier()` 只从 capability 记录里取了 MCP server，
**从未填充 `nativeToolIds`**，于是每次原生工具调用都落到 `owner-not-verified`，
页面报「未知来源」——尽管目录里明明有 `built-in` 记录。

修复：记录落在 `built-in` 伪服务器即判定为原生工具，并缓存结果。
回归测试 `tests/usage-runtime.spec.ts` 覆盖多个原生工具 + 一个 MCP 工具。
**注意**：该文件里原有一条断言明确期望 `bash` 归为 `unknown`，已改为 `native`。

### 2. 发布流程：附件名带内容哈希（已固化）

`scripts/release.mjs`：构建 → 打包 → 按 tarball SHA-256 前 8 位重命名 → 打印附件名与上传命令。
v0.1.13 自身就是用这个脚本发的（`dsh-agent-efficiency-guard-0.1.13-2a6cdcae.tgz`）。

### 3. 一键安装（不用 npm）

- `README.md`：三种安装方式，首选「把一句话粘贴给 DSH 对话」。
- `scripts/install.ps1`：取最新 Release → 改 profile 依赖 → `pnpm install` → 报告实际版本。
  幂等；支持 `-Version` / `-Profile` / `-DryRun` / `-Proxy`。
- `docs/install.md`：安装 / 升级 / 卸载 / 排错全流程。

**注意仓库根就是 `plugin/`**，raw URL 是
`https://raw.githubusercontent.com/YAN3RA/dsh-agent-efficiency-guard/main/scripts/install.ps1`
（没有 `plugin/` 前缀——曾写错并已修正，两个 URL 均已验证 200）。

### 4. 「196 个工具全按需」的成因与恢复工具

成因：`policy.ts` 的 `replayMoves()` 会把状态文件里每条记录**叠加在 patch 规则之上**。
UI 批量把工具设为按需后，patch 里 7 项常驻有 6 项被覆盖（`bash` 幸存）。

恢复：`scripts/restore-resident-tiers.mjs`，默认 `--dry-run` 只报告。
**这是用户策略数据，未经确认不要自动执行。**

### 验证

- `tsc`（Node + Client）均 0 错误
- `vitest run`：31 个文件 / **563 项**通过（v0.1.12 是 562）
- `pnpm build` 通过；`install.ps1` 已用真实 Release 端到端跑通（0.1.12 → 0.1.13）
- 安装产物：实体包、`lib/**/*.js` 全部 `node --check` 通过、`lib/client.js` 哈希与本地一致

## 三点五、安装缓存坑（本轮踩到，务必记住）

**Release 附件 URL 被 pnpm 按 URL 缓存 integrity，覆盖同名附件后不会重新下载。**

现象：把修好的 tarball 覆盖上传成同名 `dsh-agent-efficiency-guard-0.1.12.tgz` 后，`pnpm install --force`、`store prune`、删 `node_modules` 全部无效，装进去的仍是旧 `lib/client.js`（404175 vs 应为 404537）。

排查结论：
- 解包本地 tarball 核对：**tarball 本身是正确的**（404537，含新代码）。
- 远端附件 size 也正确（330946 = 本地）。
- 但 `pnpm-lock.yaml` 里该 URL 的 `resolution.integrity` 是旧的，pnpm 按 integrity 判定「已满足」，不再取新内容。
- 手工删 lockfile 里的 packages 条目会导致 `createHeadlessDepGraph` 失败，**不要这么做**。

正确做法：**用带内容指纹的附件名**，让 URL 变化：

```
dsh-agent-efficiency-guard-0.1.12-d3ee6d6d.tgz   # d3ee6d6d = tgz 的 sha256 前 8 位
```

`~/.dsh/profiles/desktop/package.json` 已指向该带哈希的附件。旧的同名附件已从 Release 删除，避免下次又被误装。

**以后发版规则：附件名带 tgz 内容哈希，不要复用同名。**

## 三点六、另一个坑：临时便携 git 没有凭据助手

ops_bash 里的 `git` 是 dsh-ops 的临时便携版（`niugit`），`credential.helper=manager` 找不到对应可执行文件，推送会报
`git: 'credential-manager' is not a git command`。

推送必须用系统 Git 且把 GCM 目录放进 PATH：

```bash
export PATH="/c/Program Files/Git/ucrt64/bin:$PATH"
"/c/Program Files/Git/cmd/git.exe" -c http.proxy=http://127.0.0.1:7890 push origin main --tags
```

## 三点七、调用统计的覆盖状态说明（用户提问的答案）

`unknown` 是**保守设计**，不是 bug：

- `src/client/usage-adapter.ts` 的 `mergeCoverage()`：**最差状态胜出**。一个会话读不出来，整页就是 `unknown`；一个会话部分缺失就是 `partial`。
- 没有任何 coverage 条目时也是 `unknown`，而不是 `complete` ——「没有报告」不等于「没有缺失」。
- 因此「覆盖未知：…0 不代表未使用」是**正确的诚实表述**，不能改成看起来更好的文案。
- 要让状态变 `complete`，需要每个被统计的会话都成功读到事件且没有跳过/截断（`skippedSessions=0`、`skippedEvents=0`、未触达聚合上限）。

**顺带发现（重要）：** 生产状态文件里 **196 个工具全部是 `on-demand`，没有一项 resident**。这解释了当前会话为何所有工具都要经检索才可用；也让总览的「常驻」数字接近 0。

## 四、网络与推送规程（本轮实测）

- 直连 GitHub `push` 与 `pnpm install` 都可能超时；**代理 `http://127.0.0.1:7890` 可用**。
- 推送前先 `git ls-remote origin refs/heads/main` 比对；**超时不等于失败**。
- 推送命令：`git -c http.proxy=http://127.0.0.1:7890 push origin main --tags`，并在同一 shell 里 `unset HTTPS_PROXY HTTP_PROXY` 避免叠加。
- GitHub API 可用：从 `git credential fill` 取 token，`Authorization: Bearer <token>`。`gh` CLI 本机未安装。

## 五、工作区与安全边界

- 不提交 `node_modules/`、`lib/`、临时 `.tgz`、测试缓存、本机 profile、Session、凭据或原始日志。
- 本轮变更了 `~/.dsh/profiles/desktop/package.json` 的依赖来源（已授权）；备份在 `%TEMP%\profile-package.json.bak-v0110`。
