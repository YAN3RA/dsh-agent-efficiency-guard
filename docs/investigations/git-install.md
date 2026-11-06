# 直接用 GitHub 仓库链接安装：实测报告

> 实测时间：2026-11-06
> 宿主：DSH `0.2.2-rc.1`，pnpm `11.28.5`（随宿主内置）
> 方法：每条用例都用全新的 `mktemp -d` 作为 `DSH_HOME`，`dsh plugin --profile probe add`，装完即销毁；生产 profile 全程未被读写。

## 0. 结论先行

**能，但不能只敲一条命令。** 仓库链接本身**会被 pnpm 正确识别**（4 种写法等价，都解析成
`codeload.github.com/.../tar.gz/<commit>`），但**首次必定失败**，原因是 pnpm 默认拦截 git 依赖的
`prepare` 构建脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）。必须先在 profile 的
`pnpm-workspace.yaml` 里写一条 `allowBuilds`，再重跑同一条命令。

`--allow-build=<包名>` 参数**不能**替代：实测传了也照样失败（pnpm 11 对 git 依赖用的是
`allowBuilds` 映射，且需要**带 commit 的完整 key**，短包名不生效）。

## 1. 结论表

| # | 来源写法 | 能否安装 | 需额外配置 | 装到的是什么 |
| --- | --- | --- | --- | --- |
| 1 | `https://github.com/YAN3RA/dsh-agent-efficiency-guard` | ⚠️ 二次重试后能 | 需 `allowBuilds`（key = `包名@codeload…/tar.gz/<sha>`） | **分支快照**，非 tag；实测锁定 main 的 `012e66c` |
| 2 | `https://github.com/YAN3RA/dsh-agent-efficiency-guard.git` | ⚠️ 同上 | 同上 | 同上 |
| 3 | `github:YAN3RA/dsh-agent-efficiency-guard` | ⚠️ 同上 | 同上 | 同上 |
| 4 | `git+https://github.com/YAN3RA/dsh-agent-efficiency-guard.git` | ⚠️ 同上 | 同上 | 同上 |
| 5 | `github:YAN3RA/dsh-agent-efficiency-guard#v0.1.13` | ✅ 二次重试后能 | 同上（key 换成 tag 指向的 commit） | **tag 快照**，实测 `c5cd535`，与 `v0.1.13` Release 内容一致 |
| — | Release `.tgz` 附件（对照基线） | ✅ 一次成功 | 不需要 | 已构建好的发布包 |

四种链接写法在 pnpm 里是同一个东西：全部输出 `resolved 0 … added` 后落到
`https://codeload.github.com/.../tar.gz/<40位 sha>`，`package.json` 里最终被改写成
`"github:YAN3RA/dsh-agent-efficiency-guard"`（无 tag 时）或
`"github:YAN3RA/dsh-agent-efficiency-guard#v0.1.13"`（指定 tag 时）。

## 2. 给用户的最终推荐命令

**推荐：仍然用 Release `.tgz` 附件**，不要用仓库链接。理由见第 4 节。

如果确实要用仓库链接，这是**唯一实测可用**的最小序列（Windows Git Bash，profile 名按需替换）：

```bash
D="/c/Users/yansui/AppData/Local/deepseek-harness/bin/dsh.cmd"
PROFILE=desktop
SRC='github:YAN3RA/dsh-agent-efficiency-guard#v0.1.13'   # 带 tag 才是发布版

# 1) 先跑一次，拿到报错里 pnpm 打印的精确 key（必然失败，这是预期）
"$D" plugin --profile "$PROFILE" add "$SRC"

# 2) 把上一条输出里 "allowBuilds:" 下面那一整行抄进 profile 的 pnpm-workspace.yaml，
#    形如：dsh-agent-efficiency-guard@https://codeload.github.com/.../tar.gz/<sha>: true
cat >> "$DSH_HOME/profiles/$PROFILE/pnpm-workspace.yaml" <<'YAML'

allowBuilds:
  dsh-agent-efficiency-guard@https://codeload.github.com/YAN3RA/dsh-agent-efficiency-guard/tar.gz/<sha>: true
YAML

# 3) 重跑同一条命令
"$D" plugin --profile "$PROFILE" add "$SRC"

# 4) 验证
cat "$DSH_HOME/profiles/$PROFILE/package.json"   # dsh.profile.bundles 应含 dsh-agent-efficiency-guard
```

注意 `DSH_HOME` 要按实际值代入（默认 `C:\Users\yansui\.dsh`）。

**已知的 key 可以用 ls-remote 预先算出来，跳过第一次失败**（实测一次通过，12s）：

```bash
SHA=$(git ls-remote https://github.com/YAN3RA/dsh-agent-efficiency-guard.git 'refs/tags/v0.1.13^{}' | cut -f1)
# 然后写 allowBuilds: dsh-agent-efficiency-guard@https://codeload.github.com/YAN3RA/dsh-agent-efficiency-guard/tar.gz/$SHA: true
```

## 3. 关键命令输出摘录

### 3.1 用例 1–4：全部卡在同一个地方

以用例 1 为例（用例 2/3/4 输出同构，只差 `Command failed` 行里的源字符串）：

```
$ dsh plugin --profile probe add 'https://github.com/YAN3RA/dsh-agent-efficiency-guard'
dsh: initialized profile probe at ...\profiles\probe
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from
"https://codeload.github.com/YAN3RA/dsh-agent-efficiency-guard/tar.gz/012e66c8e21399938c71ef0c1d4898099da4696a":
The git-hosted package "dsh-agent-efficiency-guard@0.1.13" needs to execute build scripts
but is not in the "allowBuilds" allowlist.
Add the package to "allowBuilds" in your project's pnpm-workspace.yaml to allow it to run scripts. For example:
allowBuilds:
  dsh-agent-efficiency-guard@https://codeload.github.com/YAN3RA/dsh-agent-efficiency-guard/tar.gz/012e66c8e21399938c71ef0c1d4898099da4696a: true
Command failed with exit code 1: "...DeepSeek-Harness.exe" --expose-internals "...pnpm.mjs" add "https://github.com/YAN3RA/dsh-agent-efficiency-guard"
dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed —
add the exact key pnpm printed above under allowBuilds in ...\profiles\probe\pnpm-workspace.yaml, then re-run
```

失败后 profile 状态**零污染**：

```json
{ "deps": {}, "bundles": ["@deepseek-ai/dsh-base"] }
```

`node_modules/dsh-agent-efficiency-guard` 不存在，无 `lib/`。

用例 5 的唯一差别是 commit：`.../tar.gz/c5cd535f044c4a6ef52fa418fc46dafeff71ead5`（即 `v0.1.13` 指向的提交）。

> **坑：`dsh.cmd` 的退出码恒为 0。** 上面这些失败，shell 拿到的 `$?` 全是 `0`
> （用 `dsh plugin ... remove nonexistent-pkg` 复验过，同样 0）。所有用例的"退出码"
> 必须从日志里的 `Command failed with exit code 1` 判断，不能看 `$?`。

### 3.2 用例 6：加 `allowBuilds` 后重试 —— 成功

第一次失败（3s），把 key 追加进 `pnpm-workspace.yaml` 后第二次：

```
... prepare: npm notice run tsc -p tsconfig.json && tsdown
... prepare: ✔ Build complete in 3216ms
... prepare: Done in 8.4s using pnpm v11.28.5
Progress: resolved 7, reused 6, downloaded 1, added 7, done

dependencies:
+ dsh-agent-efficiency-guard 0.1.13
Done in 13.7s using pnpm v11.28.5
```

总耗时 **15s**（含 3s 的失败首跑；只算成功那次约 13.7s）。落地结果：

```json
{
  "dependencies": {
    "dsh-agent-efficiency-guard": "github:YAN3RA/dsh-agent-efficiency-guard"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-agent-efficiency-guard"] } }
}
```

`node_modules/dsh-agent-efficiency-guard/lib/` 有 32 个文件（`client.js` 等齐全），
`dsh --profile probe --dump-config` 里能看到 `- id: agent-efficiency-guard` 及
`dsh-agent-efficiency-guard/registry|search|invoke|policy` 四个服务，说明**确实挂载了**，不只是装进 node_modules。

### 3.3 用例 5 带 tag：成功且锁定到 tag 提交

```
$ dsh plugin --profile probe add 'github:YAN3RA/dsh-agent-efficiency-guard#v0.1.13'
+ dsh-agent-efficiency-guard 0.1.13
Done in 12s using pnpm v11.28.5
```

`pnpm-lock.yaml`：

```yaml
dsh-agent-efficiency-guard@https://codeload.github.com/YAN3RA/dsh-agent-efficiency-guard/tar.gz/c5cd535f044c4a6ef52fa418fc46dafeff71ead5:
  resolution: {gitHosted: true, integrity: sha512-zLl7YXsgyKgWV61aeOFO/...}
```

`package.json` 记录 `"dsh-agent-efficiency-guard": "github:YAN3RA/dsh-agent-efficiency-guard#v0.1.13"`，
`bundles` 正确追加，`lib/` 32 个文件。

### 3.4 对照：`--allow-build` 参数无效

```
$ dsh plugin --profile probe add 'github:YAN3RA/dsh-agent-efficiency-guard' --allow-build=dsh-agent-efficiency-guard
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ... （同一个错）
```

pnpm 仍把它写进 yaml 成短 key `allowBuilds:\n  dsh-agent-efficiency-guard: true`，
**但重试依然报同一个错** —— 短包名不匹配 git 依赖的 `包名@codeloadURL` 身份。

### 3.5 对照：Release tgz 一次通过、共 3s

```
$ dsh plugin --profile probe add 'https://github.com/.../releases/download/v0.1.13/dsh-agent-efficiency-guard-0.1.13-2a6cdcae.tgz'
+ dsh-agent-efficiency-guard 0.1.13
Done in 1.9s using pnpm v11.28.5
bundles=["@deepseek-ai/dsh-base","dsh-agent-efficiency-guard"]
```

不需要 `allowBuilds`（tgz 里已含 `lib/`，没有 prepare 需要跑）。

### 3.6 代理

- 走代理（`http://127.0.0.1:7890`）：codeload 直取，稳定。
- **不走代理也能通**（本次实测）：无代理首跑 25s，出现
  `[WARN] HEAD https://github.com/... error (ECONNRESET). Will retry in 500 ms. 2 retries left.`
  重试后照样取到 tarball，最终仍以 `allowBuilds` 报错收场。
  → 结论：代理是**提速/稳定性**问题，不是硬前提；慢但可成。

## 4. 风险与限制

1. **不带 tag = 装分支快照，版本号会骗人。**
   裸仓库链接解析到 main 的 `012e66c`，其 `package.json` 也写着 `0.1.13`，
   与 `v0.1.13` Release **版本字符串完全相同但内容不同**。此时装到的 `0.1.13`
   比 Release 的 `0.1.13` 多若干提交，且 main 后续任何提交都会让下一次安装内容漂移。
   本次实测正是如此：本地 HEAD 已改名为 `dsh-thinking-guard`、remote main 仍是 `012e66c`，
   而 `012e66c` 与 `c5cd535`（tag）之间已有差异（含 `docs/install.md`、`scripts/install.ps1`、
   大量 `src/`）。
2. **每次 commit 变动都要改一次 `allowBuilds` 的 key。**
   key 里嵌了完整 40 位 sha。实测流程：装好 main（key = `012e66c…`）后改成
   `#v0.1.13`（sha = `c5cd535…`），**立刻重新报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`**，
   必须再补一条 key 才能装。这意味着 main 一旦有新提交，旧 key 失效，用户会莫名失败。
3. **要现场跑完整构建。** `prepare` = `tsc -p tsconfig.json && tsdown`，
   依赖 pnpm 在这一步临时装齐全套 devDependencies（tsc 6 / tsdown 0.22 / vitest 4 …），
   每次安装都要下载并编译。实测成功那次 12–14s（本机、store 已热身）；
   冷 store 或首次下载 devDeps 会明显更慢，且任一 devDep 解析失败就装不成。
4. **构建产物的可信度依赖构建机。** 与本仓库发版时出版的 tgz 相比，git 安装是
   "任意提交 + 现场构建"，没有发布流程的哈希附件校验，也无法比对 Release 的
   `-<hash>.tgz` 文件名。
5. **`dsh.cmd` 不传递真实退出码**（恒 0）。脚本化安装必须解析输出文本，
   不能靠 `if ! dsh plugin add …`。
6. **`dsh plugin` 本身没有任何"允许构建"参数。** 帮助只说明"转发给 pnpm"，
   DSH 在失败时追加一句提示让用户手改 yaml —— 即官方设计上就要求**两次尝试 + 手改配置**。
7. 私有/受限网络下 codeload 与 github.com 是不同域，代理白名单要同时覆盖
   `github.com`、`codeload.github.com`、`api.github.com`（若用 API 取版本）。

## 5. 一句话结论

- **只复制 `https://github.com/YAN3RA/dsh-agent-efficiency-guard` 给 `dsh plugin add`：装不上，必报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。**
- 必须走「先失败拿 key → 手改 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds` → 重跑」三步；且要加 `#v0.1.13` 才装到发布版，否则装的是 main 快照。
- **推荐仍旧用 Release 附件 URL**：一次成功、3 秒、无需任何额外配置。

## 附：本次实测的临时目录

全部在 `C:\Users\yansui\AppData\Local\Temp\tmp.*`，测试完已删除；
未创建、未修改任何生产 profile（`~/.dsh/profiles/desktop` 的 `package.json` 与
`pnpm-workspace.yaml` 实测前后一致，仍指向 `releases/download/v0.1.13/dsh-agent-efficiency-guard-0.1.13-2a6cdcae.tgz`）。

## 附：实测环境备注

- `dsh` 实际路径是 `C:\Users\yansui\AppData\Local\deepseek-harness\bin\dsh.cmd`（全小写），
  任务书里给的 `Programs\DeepSeek-Harness\resources\runtime\cli\bin\dsh.cmd` 在本机不存在；
  `pnpm.mjs` 确实在 `Programs\DeepSeek-Harness\resources\runtime\primary-runtime\dependencies\pnpm\` 下。
- 每条用例后 `rm -rf` 掉临时 `DSH_HOME`，最终 `ds -d Temp/tmp.*` 只剩两个与本次测试无关的旧目录。
