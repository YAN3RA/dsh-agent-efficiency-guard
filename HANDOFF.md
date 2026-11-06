# HANDOFF

更新：2026-11-06 22:45。仓库：`YAN3RA/dsh-thinking-guard`；分支：`main`；已发布 **v0.1.15**。
代码规模：约 19000 行 / 41 个模块 / 31 个测试文件 563 项。

---

## 一、当前状态（一句话）

插件已更名为 **`dsh-thinking-guard`**，生产已装 **0.1.15** 且 Host 已于 22:32 重启加载新代码；工作区干净，本地与远端同步在 `dbf1d37`。

**待你确认的一件事**：调用统计的覆盖状态是否从「未知」推进到了「完整/部分」。代码已生效（见第四节时间线），但我无法从会话内看到 GUI。

---

## 二、本轮（v0.1.14 + v0.1.15）做了什么

### 1. 全链路改名（v0.1.14）

| 项 | 旧 | 新 |
|---|---|---|
| npm 包名 | `dsh-agent-efficiency-guard` | `dsh-thinking-guard` |
| GitHub 仓库 | `YAN3RA/dsh-agent-efficiency-guard` | `YAN3RA/dsh-thinking-guard` |
| 本地目录 | `dsh-agent-efficiency-guard/` | `dsh-thinking-guard/` |
| Cordis 模块名 | `agent-efficiency-guard` | `thinking-guard` |
| patch entry id | `agent-efficiency-guard` | `thinking-guard` |
| Typert host-face package | 旧包名 | `dsh-thinking-guard` |

旧仓库 URL 返回 **301 重定向**，已安装用户不会断。旧包与旧目录均已从本机清除。

**刻意没有改的两处，改动前务必读这段：**

1. **状态文件名 `capability-menu-policy.json`** —— 里面是用户的能力分层（**196 项工具 + 16 个技能**）。改文件名 = 插件从空状态启动 = 静默清空用户配置。**我在改名时一度误改，已回退。**
2. **`docs/release-0.1.7` / `release-0.1.8` 的历史发布说明** —— 记录当时以旧名发布的事实，改写等于伪造记录。

**已知副作用：** `usage-profile` 的分区哈希域含包名，两个固定测试值随之变化。当前是 `memory` 模式、不落盘分区，无实际数据损失；测试注释已写明此前提。

### 2. 覆盖状态修复（v0.1.15）

**根因（已查清，非猜测）：** 覆盖状态变 `complete` 的**唯一**路径是历史回补成功覆盖整个会话。原默认预算是 **8 会话 / 5000ms**，而本机光会话目录就有 **9 个** —— 窗口比真实历史还小，回补永远跑不完，页面就永远停在 `unknown`。

**改动：** `DEFAULT_USAGE_BACKFILL_LIMITS` 提到 **64 会话 / 20000 事件每会话 / 200000 总计 / 30s 墙钟**。仍然有界，只是把天花板抬到能装下真实历史。

**诚实边界不变：** 读不到的会话仍标 `unknown`，不伪装成 `complete`。这是硬红线。

### 3. 新增文档

- **`docs/ARCHITECTURE.md`** —— 功能模块与技术方案，**待你审批**。10 个模块，每个写明职责/方案/取舍/限制。
- **`docs/README.md`** —— 文档索引，按用途分组。
- **`docs/investigations/git-install.md`** —— 各安装来源实测结论。
- **`docs/specs/`** —— 归档的两份需求书。

---

## 三、安装（必须用 `dsh plugin add`）

```bash
dsh plugin --profile desktop add https://github.com/YAN3RA/dsh-thinking-guard/releases/download/v0.1.15/dsh-thinking-guard-0.1.15-3d66a504.tgz
```

**为什么不能用裸 `pnpm install`**：`dsh plugin add` 在 pnpm 之后会把带 `dsh.bundle.patch` 的新依赖自动写进 `dsh.profile.bundles`；裸 `pnpm install` **不会**。结果是包装上了但不挂载，设置 → 插件 里根本看不到。已实测双向证实。

### 各安装来源实测

| 来源 | 结果 |
|---|---|
| Release 附件 URL（带哈希） | ✅ 一次成功，约 2 秒，零配置 |
| 本地 `.tgz` 绝对路径 | ✅ 可用，换机失效 |
| `https://github.com/owner/repo` 裸链接 | ❌ `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` |
| `github:owner/repo#v0.1.15` | ❌ 同上；加 `allowBuilds` 后可装，但 key 每次 commit 都变 |
| 裸包名 | ❌ 404（未发布 npm） |

**git 形式为何不可用**：仓库不含 `lib/`（构建产物被 gitignore），pnpm 需现场跑 `prepare`（= `npm run build`），pnpm 11 默认拦截 git 依赖的构建脚本。要装就得写
`包名@https://codeload.github.com/.../tar.gz/<40位sha>: true` 的 key —— 每次 commit 都变，维护成本远超收益。

---

## 四、已验证的事实（含时间线）

| 项 | 证据 |
|---|---|
| 测试 | `vitest run` 连跑 3 次均 **563 项全过** |
| 类型 | 两套 `tsc` 均 0 错误 |
| 构建 | `pnpm build` 通过 |
| 生产安装 | `node_modules/dsh-thinking-guard` = 0.1.15，实体目录（无 `src/`） |
| **新代码已生效** | 产物 mtime **22:27**，Host 启动 **22:32** → 回补预算已进运行态 |
| 回补预算 | 安装产物内实测 `maxSessions: 64` / `maxRuntimeMs: 30_000` |
| 旧包清除 | `node_modules/dsh-agent-efficiency-guard` 已不存在 |
| 旧目录清除 | 工作区只剩 `dsh-thinking-guard/` |
| 同步 | 本地 = 远端 = `dbf1d37` |

---

## 五、必须知道的环境坑（踩过，会再踩）

1. **`dsh.cmd` 退出码恒为 0**。实测 `remove 不存在的包` 也返回 0。脚本化必须解析输出里的 `Command failed with exit code 1`。
2. **`dsh.cmd` 有两个位置**：
   - 当前用：`AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
   - 旧路径仍在：`AppData\Local\deepseek-harness\bin\dsh.cmd`
3. **安装目录名是空格**：`DeepSeek Harness`，不是连字符。终端显示会误导，`$LOCALAPPDATA` 变量拼出来也可能是连字符。
4. **pnpm 按 URL+integrity 缓存**：同名覆盖 Release 附件**不会**重新下载，`--force`/`store prune`/删 `node_modules` 全部无效。附件名必须带内容哈希（`scripts/release.mjs` 已固化）。
5. **推送要用系统 Git**：`ops_bash` 里的 `git` 是便携版无 GCM，报 `git: 'credential-manager' is not a git command`。用：
   ```bash
   PATH="/c/Program Files/Git/ucrt64/bin:$PATH" "/c/Program Files/Git/cmd/git.exe" -c http.proxy=http://127.0.0.1:7890 push origin main --tags
   ```
6. **GitHub 直连不通**，代理 `http://127.0.0.1:7890` 可用。
7. **一个测试偶发失败**：`tests/policy.spec.ts` 的 tier 持久化用例与 50ms 防抖计时器赛跑，并发高时会偶发失败。**单独跑必过，连跑全套通常过**。已把轮询放宽到 10s/25ms，但仍非 100% 确定性——若见它失败，先单独重跑确认。

---

## 六、未完成 / 未验证

1. **覆盖状态是否真的变 complete** —— 代码已生效，但未在 GUI 确认结果。
2. **`docs/ARCHITECTURE.md` 未审批** —— 需要你逐模块复核。
3. **macOS / Linux 未验证** —— 安装脚本 `#Requires -Version 7.0`，只做 Windows。
4. **196 项工具全按需** —— 这是你手动设置的，尊重现状未改。恢复工具见下。
5. `meta_invoke` 单次转发不经过 executor 调度器（并发分类、`maxParallelToolCalls`），与批量 `execute` 语义不完全等价。
6. 调用统计是 `memory` 模式，**重启清零**，不跨重启恢复。
7. 未在真实 GUI 验证四页签在改名后是否正常显示。

---

## 七、下一轮可执行项

1. **确认覆盖状态** —— 设置 → 插件 → 调用统计，看是否从「未知」变为「完整/部分」。成本 1 分钟。**推荐先做**，这是 v0.1.15 的唯一验收点。
2. **审批 `docs/ARCHITECTURE.md`** —— 逐模块复核方案。重点看第 3 节（On-demand 实现）与第 9 节（安装为何必须用 `dsh plugin add`）。成本 15 分钟。
3. **确认改名后 UI 正常** —— 设置 → 插件 应显示 `dsh-thinking-guard`，四页签可切换。成本 2 分钟。
4. **决定 196 项工具是否恢复常驻** —— 先跑 `node scripts/restore-resident-tiers.mjs`（默认只报告，不改）。当前 patch 声明 7 项常驻，其中 6 项被状态文件覆盖成按需。成本 5 分钟。
5. **清理备份** —— `%TEMP%\guard-pre-rename-backup`（改名前的完整副本，1.4G）。确认无误后可删。成本 1 分钟。

---

## 八、常用命令速查

```bash
# 测试与检查（必须用宿主 runtime 的 node/pnpm）
NODE="$USERPROFILE/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
PNPM="$USERPROFILE/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
"$NODE" "$PNPM" exec tsc -p tsconfig.json --noEmit
"$NODE" "$PNPM" exec tsc -p tsconfig.client.json --noEmit
"$NODE" "$PNPM" exec vitest run
"$NODE" "$PNPM" build

# 发版（构建+打包+按哈希命名，打印上传命令）
NPM_CLI_JS="C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" "$NODE" scripts/release.mjs

# 安装到生产
dsh plugin --profile desktop add <带哈希的附件 URL>
```

---

## 九、工作区与安全边界

- 默认不触碰 `~/.dsh/profiles/desktop`；本轮安装属已授权改动。
- 不提交 `node_modules/`、`lib/`、临时 `.tgz`、测试缓存、本机 profile、Session、凭据或原始日志。
- 备份：改名前完整副本在 `%TEMP%\guard-pre-rename-backup`（1.4G）。
