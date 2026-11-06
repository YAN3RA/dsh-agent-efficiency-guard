# 安装、升级与卸载

本插件**不通过 npm registry 分发**（`registry.npmjs.org` 上没有这个包，`pnpm add dsh-thinking-guard`
会 `ERR_PNPM_FETCH_404`）。安装来源是 GitHub Release 附件（`.tgz`），由 DSH 自己的包管理入口
`dsh plugin --profile <name> add <附件URL>` 装进 profile。

---

## 方式一：把这句话发给 DSH 对话（推荐）

复制整段粘贴给 DSH：

```
帮我安装 dsh-thinking-guard。请按顺序做：

1. 读 https://raw.githubusercontent.com/YAN3RA/dsh-thinking-guard/main/docs/install.md
   的「方式三：手动」，用里面的命令完成安装。
2. 装完确认 ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles 里有
   "dsh-thinking-guard"（没有就告诉我，别自己猜）。
3. 报告装到的版本号，然后提醒我重启 DSH。
```

如果你本机访问 GitHub 需要代理，把那句「走代理 http://127.0.0.1:7890」也写进去。

> 为什么推荐「方式三」而不是让 DSH 自己发明步骤：下面的三条命令是**实测过**的最小路径，
> 其中 `dsh plugin add` 会自动把包登记进 `dsh.profile.bundles`。手工改 `package.json` 再
> `pnpm install` **不会**登记，插件装了但不挂载——这是最容易踩的坑。

## 方式二：一条命令（Windows PowerShell）

```powershell
$f="$env:TEMP\install-guard.ps1"; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/YAN3RA/dsh-thinking-guard/main/scripts/install.ps1' -OutFile $f; pwsh -NoProfile -File $f
```

需要代理时在末尾加 `-Proxy http://127.0.0.1:7890`。

脚本做的事：取最新 Release 的带哈希附件 → 调 `dsh plugin add` → 核对安装版本、profile 里的
pin、`dsh.profile.bundles` 是否含该包 → 提示重启。参数：

| 参数 | 作用 |
| --- | --- |
| `-Version v0.1.12` | 装指定 tag，不取最新 |
| `-Profile desktop` | 指定 profile，默认 `desktop` |
| `-DryRun` | 只解析并打印将发生什么，不写文件、不跑 pnpm |
| `-Proxy http://127.0.0.1:7890` | GitHub 与 pnpm 走代理 |
| `-DshCommand <路径>` | 手动指定 `dsh.cmd` / `dsh.ps1` |

脚本**幂等**：profile 已 pin 最新附件时，pnpm 返回 `Already up to date`，`bundles` 不会被重复追加。

## 方式三：手动（三条命令）

在任意 shell 里：

```bash
# 1. 取最新 Release 的带哈希附件 URL（本机实测无需代理也能通）
curl -s https://api.github.com/repos/YAN3RA/dsh-thinking-guard/releases/latest \
  | grep -o 'https://[^"]*\.tgz'
```

把输出的 URL 填进下一条（示例值不要照抄）：

```bash
# 2. 用 DSH 自己的入口安装；它会同时把包登记进 dsh.profile.bundles
dsh plugin --profile desktop add 'https://github.com/YAN3RA/dsh-thinking-guard/releases/download/v0.1.13/dsh-thinking-guard-0.1.13-2a6cdcae.tgz'
```

```bash
# 3. 核对：pin 的 URL、装到的版本、是否已登记进 bundles
node -e "const m=require(process.env.HOME+'/.dsh/profiles/desktop/package.json'); console.log('pinned:', m.dependencies['dsh-thinking-guard']); console.log('bundled:', m.dsh.profile.bundles.includes('dsh-thinking-guard'))"
grep '"version"' ~/.dsh/profiles/desktop/node_modules/dsh-thinking-guard/package.json
```

期望 `bundled: true`，版本号等于你装的那个 tag。**最后重启 DSH**，否则加载的还是旧代码。

### `dsh` 命令不可用时

`dsh` 通常已在 PATH 上（本机解析到 `%LOCALAPPDATA%\deepseek-harness\bin\dsh.ps1`）。找不到时用绝对路径：

```powershell
# 安装目录名在不同版本间变过（中间可能是空格），先用通配符确认真实名字
$dir = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Directory -Filter '*Harness*' | Select-Object -First 1
& (Join-Path $dir.FullName 'resources\runtime\cli\bin\dsh.cmd') plugin --profile desktop add '<附件URL>'
```

> 别手抄安装目录名。本机实测它是 `DeepSeek Harness`（中间是**空格**），而终端里常被显示成
> 连字符；照抄连字符会 `Test-Path` 为 False。`scripts/install.ps1` 用同样的通配符定位，不硬编码。

---

## 为什么必须用 `dsh plugin add`，而不是改 JSON + `pnpm install`

实测结论（隔离 `DSH_HOME`，非生产 profile）：

| 做法 | 包装上了 | 自动写 `dsh.profile.bundles` | 结果 |
| --- | --- | --- | --- |
| `dsh plugin add <url>` | 是 | **是** | 插件被挂载 |
| 手改 `dependencies` + `pnpm install` | 是 | **否** | 装了但不挂载，设置页看不到 |

`dsh plugin` 在 pnpm 跑完后会做一次 bundle 协调：新增的、`package.json` 里声明了
`dsh.bundle.patch` 的依赖会被追加进 `dsh.profile.bundles`，并校验其 patch 文件能被解析。
裸 `pnpm install` 没有这一步。

同理，`dsh plugin remove <包名>` 会**同时**把该包从 `dependencies` 和 `dsh.profile.bundles` 删掉。

## 为什么附件名带哈希（重要）

profile 从附件 URL 安装时，pnpm 按「URL + integrity」缓存解析结果。**用同一个文件名覆盖附件后，pnpm 不会重新下载**：

- `pnpm install --force` 无效
- `pnpm store prune` 无效
- 删 `node_modules/<包名>` 再装也无效
- 手工删 `pnpm-lock.yaml` 里的条目会导致 `createHeadlessDepGraph` 解析失败

结果就是「明明发布了新包，装进去的还是旧 `lib/`」。这个坑实际发生过一次，代价是一整个发版周期。

**解决办法**：附件名带 tarball 自身 SHA-256 的前 8 位。内容变了 URL 就变，缓存不可能命中旧内容；
内容没变则名字不变，重复发布保持幂等。

发版统一用：

```bash
node scripts/release.mjs
```

它会构建、打包、按哈希重命名，并打印准确的附件名与上传命令。

---

## 其它安装来源：实测结论

以下都在隔离 `DSH_HOME` 里实测过，结论可直接引用。

| 来源写法 | 实测结果 | 说明 |
| --- | --- | --- |
| `https://…/releases/download/…/…-<hash>.tgz` | ✅ 可用 | **推荐**。自动登记 bundle，升级正常 |
| 本地 `.tgz` 绝对路径 | ✅ 可用 | 会记成 `file:...`。只在同机自测有意义，换机即失效 |
| `git+https://github.com/…git` / `github:owner/repo` | ❌ 默认失败 | 见下 |
| `link:<本地目录>` | ⚠️ 能装，不推荐 | 软链到源码目录，peer 依赖不从目标 `node_modules` 解析；仓库里没有 `lib/` 时还缺构建产物 |
| 裸包名 `dsh-thinking-guard` | ❌ 404 | 包没发布到 npm registry |

### git 直装为什么不可用

`lib/` 是构建产物，`.gitignore` 里忽略、`git ls-files lib` 为 0 个文件，所以仓库里没有可运行的
`lib/`。pnpm 从 git 取包时必须跑 `prepare` 脚本（本仓库 `prepare` = `npm run build`）现场构建，而 pnpm
默认拦截构建脚本：

```
ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED: The git-hosted package "dsh-thinking-guard@0.1.13"
needs to execute build scripts but is not in the "allowBuilds" allowlist.
```

按提示把 pnpm 打印出的那行 key 写进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 后，**确实能装上**
（实测构建 11.8s，装出 0.1.13）。但这条路不推荐，原因三条：

1. 每个新 commit 的 codeload URL 不同，`allowBuilds` 的 key 带完整 URL，每次升级都要改 profile 配置。
2. 要在用户机器上跑完整 TypeScript 构建，依赖 devDependencies，慢且易受环境影响。
3. 装的是分支最新提交而非发布版本，没有发布验收，也没有哈希可核对。

**结论**：git 直装技术上可解锁，但不作为分发方式。用 Release 附件。

---

## 升级

重跑方式一 / 方式二即可。脚本会比对当前 pin 与最新附件：

- 一致 → 只重装同样的字节，`bundles` 不动
- 不一致 → 打印 `from:` / `to:`，走 `dsh plugin add` 换版本

手动升级就是把方式三第 2 条的 URL 换成新版本的哈希附件再跑一次。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-thinking-guard
```

一条命令同时清掉 `dependencies` 与 `dsh.profile.bundles`（已实测）。然后重启 DSH。

手工兜底：从 `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 各删掉该包，再
`cd ~/.dsh/profiles/desktop && pnpm install`，最后重启。

插件留下的状态文件（`~/.dsh/capability-menu-policy.json`）不会自动删除。如需彻底清理，确认备份后再手动删除。

---

## 排错

### 装完看不到插件

先查这一条，它解释了绝大多数情况：

```bash
node -e "const m=require(process.env.HOME+'/.dsh/profiles/desktop/package.json'); console.log('bundled:', m.dsh.profile.bundles.includes('dsh-thinking-guard'))"
```

`false` → 当初是手改 JSON + `pnpm install` 装的，包在但没挂载。
补跑一次 `dsh plugin add <附件URL>`，或手工把包名加进 `dsh.profile.bundles`，然后重启。

`true` 却仍看不到 → 确认**已重启** DSH；再看 设置 → 插件 是否有加载报错。

### 装进去的还是旧版本

几乎一定是缓存问题。比对安装目录与 Release 附件里的 `lib/client.js` 大小：

```bash
ls -la ~/.dsh/profiles/desktop/node_modules/dsh-thinking-guard/lib/client.js
tar -tzvf <下载的 tgz> | grep 'lib/client.js'
```

不一致说明命中了旧缓存——确认你 pin 的是**带哈希**的附件名，而不是被覆盖过的同名附件。

### `dsh plugin add` 超时 / `fetch failed`

GitHub 附件下载在部分网络下会 `ETIMEDOUT`。先确认代理可用，再重跑：

```powershell
pwsh -NoProfile -File scripts/install.ps1 -Proxy http://127.0.0.1:7890
```

或手动设环境变量后重跑方式三：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

注意：**API 与附件下载的可达性可能不一致**。本机实测 `api.github.com` 与
`releases/download/...` 直连可通，但 `github.com/.../releases/latest` 这个 HTML 页会超时——
所以脚本只用 API，不抓网页。

### `ERR_PNPM_FETCH_404` / `is not in the npm registry`

用了裸包名。本包不在 npm registry，必须给完整附件 URL。

### `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`

用了 git 来源。见上文「git 直装为什么不可用」——换 Release 附件，不要去改 `allowBuilds`。

### 提示 DSH 版本不兼容

`dsh plugin add` 会在安装前读包的 manifest，比对它对 DSH 的版本要求（`engines` 与
`peerDependencies`），不匹配就拒绝安装并回滚 manifest 与 lockfile。它会在输出里打印一条
`dsh plugin --profile desktop allow-version <包@版本> --dsh-version <版本> --accept-risk`。
**那条命令会跳过兼容检查**，只在确认风险后执行。

### 找不到 DSH runtime / profile

`~/.dsh/profiles/desktop` 与 `~/.dsh/dsh-runtimes/` 都是 DSH 首次启动才生成的。先正常启动一次 DSH。
脚本会明确报「Profile manifest not found」并指出期望路径。

### 想看 pnpm 到底报了什么

`dsh plugin` 把完整 pnpm 输出写到 profile 下的日志目录：

```bash
ls -t ~/.dsh/profiles/desktop/.plugin-manager/logs | head
```

---

## 给发布者的检查清单

1. `npm version <版本> --no-git-tag-version`
2. `node scripts/release.mjs` —— 构建 + 打包 + 按哈希命名
3. 打 annotated tag 并推送，CI 会建 Release 并上传附件
4. 确认 Release 里**只有带哈希的附件**，没有同名的无哈希残留
5. 更新 README / 本文档里出现的示例版本号（如 v0.1.13）
6. **不要**复用无哈希的同名附件——这是上面那个坑的根源
7. 发完用 `-DryRun` 跑一次 `scripts/install.ps1`，确认脚本能解析到新附件
