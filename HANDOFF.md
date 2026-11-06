# HANDOFF

更新：2026-11-06 22:25。仓库：`YAN3RA/dsh-thinking-guard`；分支：`main`；已发布 **v0.1.14**。

## 当前状态（一句话）

插件已更名为 **`dsh-thinking-guard`**（原 `dsh-agent-efficiency-guard`），包名 / 仓库 / 本地目录 / 文档全部同步；生产已用 `dsh plugin add` 装好 0.1.14；测试 563 项全过。

## 一、v0.1.14：改名

| 项 | 旧 | 新 |
|---|---|---|
| npm 包名 | `dsh-agent-efficiency-guard` | `dsh-thinking-guard` |
| GitHub 仓库 | `YAN3RA/dsh-agent-efficiency-guard` | `YAN3RA/dsh-thinking-guard` |
| 本地目录 | `dsh-agent-efficiency-guard/` | `dsh-thinking-guard/` |
| Cordis 模块名 | `agent-efficiency-guard` | `thinking-guard` |
| patch entry id | `agent-efficiency-guard` | `thinking-guard` |

旧仓库 URL 返回 **301 重定向**，已安装用户不会断。

**刻意没改的两处：**

1. **状态文件名** `capability-menu-policy.json` —— 里面是用户的能力分层（196 项工具 + 16 技能）。改文件名等于静默清空配置。
2. **`docs/release-0.1.7` / `release-0.1.8` 的历史说明** —— 记录当时以旧名发布的事实。

**已知副作用：** `usage-profile` 的分区哈希域含包名，两个固定测试值随之变化。当前是 `memory` 模式、不落盘分区，无实际数据损失。

## 二、v0.1.14：覆盖状态改进

**根因（已查清）：** 覆盖状态变成 `complete` 的唯一路径是**历史回补成功覆盖整个会话**。原默认预算是 8 会话 / 5000ms，而本机有 9 个会话目录 —— 窗口比真实历史还小，回补永远跑不完，页面就永远停在 `unknown`。

**改动：** 默认预算提到 64 会话 / 20000 事件每会话 / 200000 总计 / 30s 墙钟。**仍然有界**，只是把天花板抬到能装下真实历史。

**诚实边界不变：** 读不到的会话仍然标 `unknown`，不伪装成 `complete`。

## 三、新增文档

- **`docs/ARCHITECTURE.md`** —— 功能模块与技术方案，供审批复核。每个模块的职责、方案、取舍、已知限制。
- **`docs/README.md`** —— 文档索引，按用途分组。
- **`docs/investigations/git-install.md`** —— 各安装来源实测结论。
- **`docs/specs/`** —— 归档的两份需求书。

## 四、安装（重要：必须用 `dsh plugin add`）

```bash
dsh plugin --profile desktop add https://github.com/YAN3RA/dsh-thinking-guard/releases/download/v0.1.14/dsh-thinking-guard-0.1.14-808e2080.tgz
```

**为什么不能用裸 `pnpm install`**：`dsh plugin add` 会在 pnpm 之后把带 `dsh.bundle.patch` 的新依赖自动写进 `dsh.profile.bundles`；裸 `pnpm install` **不会**，结果是包装上了但不挂载，设置里看不到插件。

## 五、各安装来源实测

| 来源 | 结果 |
|---|---|
| Release 附件 URL（带哈希） | ✅ 一次成功，约 2 秒，零配置 |
| 本地 `.tgz` 绝对路径 | ✅ 可用，换机失效 |
| `https://github.com/owner/repo` 裸链接 | ❌ `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` |
| `github:owner/repo#v0.1.14` | ❌ 同上；加 `allowBuilds` 后可装，但要手改 key 且每次提交都变 |
| 裸包名 | ❌ 404（未发布 npm） |

**git 形式为何不可用**：仓库不含 `lib/`（构建产物被 gitignore），pnpm 需现场跑 `prepare`（= `npm run build`），而 pnpm 11 默认拦截 git 依赖的构建脚本。要装就得在 profile 的 `pnpm-workspace.yaml` 里写形如
`包名@https://codeload.github.com/.../tar.gz/<40位sha>: true` 的 key —— **每次 commit 都变**，维护成本远超收益。

## 六、必须知道的环境坑

1. **`dsh.cmd` 退出码恒为 0**（实测：`remove 不存在的包` 也返回 0）。脚本化必须解析输出里的 `Command failed with exit code 1`。
2. **`dsh.cmd` 有两个位置**：`AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`（当前用）与 `AppData\Local\deepseek-harness\bin\dsh.cmd`（旧路径，仍存在）。
3. **安装目录名是空格**：`DeepSeek Harness`，不是连字符。终端显示会误导。
4. **pnpm 按 URL+integrity 缓存**：同名覆盖 Release 附件不会重新下载。附件名必须带内容哈希。
5. **推送要用系统 Git**：`ops_bash` 里的 `git` 是便携版，没有 GCM，报 `git: 'credential-manager' is not a git command`。用
   `PATH="/c/Program Files/Git/ucrt64/bin:$PATH" "/c/Program Files/Git/cmd/git.exe"`。

## 七、未完成 / 未验证

1. **覆盖状态是否真的变 complete** —— 改了预算但没重启验证。
2. **旧目录 `dsh-agent-efficiency-guard/` 未删除** —— 被当前会话工作目录占用，需重启会话后删。
3. **macOS / Linux 未验证**。
4. `meta_invoke` 单次转发不经过 executor 调度器（并发分类、`maxParallelToolCalls`），与批量 `execute` 语义不完全等价。
5. 调用统计是 `memory` 模式，重启清零。

## 八、下一轮可执行项

1. **重启 DSH，看调用统计覆盖状态** —— 确认是否从 `unknown` 变成 `complete` 或 `partial`。成本 3 分钟。
2. **删除旧目录** —— 重启会话后 `rm -rf "dsh-agent-efficiency-guard"`。成本 1 分钟。
3. **验证四页签 UI 在改名后正常** —— 确认 设置 → 插件 里显示的是 `dsh-thinking-guard`。成本 2 分钟。
4. **审批 `docs/ARCHITECTURE.md`** —— 逐模块复核方案是否认可。成本 15 分钟。
5. **决定 196 项工具是否恢复常驻** —— 先跑 `node scripts/restore-resident-tiers.mjs` 看清单。成本 5 分钟。

## 九、工作区与安全边界

- 默认不触碰 `~/.dsh/profiles/desktop`；本轮安装属已授权改动。
- 不提交 `node_modules/`、`lib/`、临时 `.tgz`、测试缓存、本机 profile、Session、凭据或原始日志。
- 备份：改名前的完整副本在 `%TEMP%\guard-pre-rename-backup`。
