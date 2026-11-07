# dsh-thinking-guard

一个 DSH 插件：把**能力目录与按需调用**（Capability Menu 思路）和 **Agent 效率守卫**（重复/循环调用提醒）整合在一起。当前版本 **0.1.15**。

## 它做什么

- `meta_search` 按需查找能力，`meta_invoke` 调用能力；工具与技能按 Resident / On-demand / Disabled 三档分层，Disabled 会在执行入口拒绝调用，不只是隐藏 Schema。
- Guard 按 Agent / Turn 隔离，用工具签名与 Step 的结果/错误指纹做重复与 A-B 循环检测；只在证据满足门槛时对匹配调用局部拒绝一次，**不停止整个 Turn**。
- 设置页提供四个页面：总览、防循环、调用统计、能力目录。

## 它不做什么

- 不做工具结果压缩与原文恢复——那是 [dsh-plugin-save-token](https://github.com/YAN3RA/dsh-plugin-save-token) 的职责。
- 不做模型 / Provider / 完整会话管理——那是 DSH 宿主的职责。
- 不读取、保存或输出隐藏思维链。

## 安装

不需要 npm（这个包不在 npm registry 上）。安装来源是 GitHub Release 附件，通过 DSH 自己的入口
`dsh plugin --profile desktop add <附件URL>` 装进 profile——它会同时把包登记进 `dsh.profile.bundles`，
手工改 `package.json` 再 `pnpm install` **不会**，那样装了也不挂载。

### 方式一：把这句话发给 DSH 对话（推荐）

复制下面整段，粘贴给 DSH：

```
帮我安装 dsh-thinking-guard。请按顺序做：

1. 取最新 Release 的带哈希附件 URL：
   curl -s https://api.github.com/repos/YAN3RA/dsh-thinking-guard/releases/latest | grep -o 'https://[^"]*\.tgz'
2. 用 dsh plugin --profile desktop add '<上一步输出的 URL>' 安装。
3. 装完确认 ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles 里有
   "dsh-thinking-guard"（没有就告诉我，别自己猜）。
4. 报告装到的版本号，然后提醒我重启 DSH。
```

需要代理就补一句「走代理 http://127.0.0.1:7890」。

### 方式二：一条命令（Windows PowerShell）

```powershell
$f="$env:TEMP\install-guard.ps1"; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/YAN3RA/dsh-thinking-guard/main/scripts/install.ps1' -OutFile $f; pwsh -NoProfile -File $f
```

需要代理时末尾加 `-Proxy http://127.0.0.1:7890`；`-DryRun` 只看不改；`-Version v0.1.12` 装指定版本。
脚本幂等，会自动挑最新 Release、处理升级，并在结束时核对版本、pin 与 `dsh.profile.bundles`。

### 方式三：手动

1. 取最新 Release 的带哈希附件 URL：

   ```bash
   curl -s https://api.github.com/repos/YAN3RA/dsh-thinking-guard/releases/latest \
     | grep -o 'https://[^"]*\.tgz'
   ```

2. 用 DSH 自己的入口安装：

   ```bash
   dsh plugin --profile desktop add '<上一步输出的 URL>'
   ```

3. 重启 DSH。

安装后**必须重启 DSH** 才会加载新代码。

### 为什么必须用 `dsh plugin add`

实测结论（隔离 `DSH_HOME`，非生产 profile）：

| 做法 | 包装上了 | 自动写 `dsh.profile.bundles` | 结果 |
| --- | --- | --- | --- |
| `dsh plugin add <url>` | 是 | **是** | 插件被挂载 |
| 手改 `dependencies` + `pnpm install` | 是 | **否** | 装了但不挂载，设置页看不到 |

`dsh plugin` 在 pnpm 跑完后会做一次 bundle 协调：新增的、`package.json` 里声明了
`dsh.bundle.patch` 的依赖会被追加进 `dsh.profile.bundles`。裸 `pnpm install` 没有这一步。

### 为什么附件名带哈希

profile 从附件 URL 安装时，pnpm 按「URL + integrity」缓存解析结果。**用同一个文件名覆盖附件后，pnpm 不会重新下载**——`--force`、`store prune`、删 `node_modules` 都无效，装回去的还是旧 `lib/`。这个坑实际发生过一次。

因此附件名带 tarball 自身的 SHA-256 前 8 位：内容变了 URL 就变，缓存不可能命中旧内容；内容没变则名字不变，重复发布保持幂等。

发版请用 `node scripts/release.mjs`，它会自动构建、打包并按哈希重命名，打印出准确的附件名与上传命令。

### 其它安装来源

| 来源写法 | 结果 | 说明 |
| --- | --- | --- |
| `https://…/releases/download/…/…-<hash>.tgz` | ✅ 可用 | **推荐**。自动登记 bundle，升级正常 |
| 本地 `.tgz` 绝对路径 | ✅ 可用 | 会记成 `file:...`。只在同机自测有意义，换机即失效 |
| `git+https://github.com/…git` / `github:owner/repo` | ❌ 默认失败 | 仓库不含 `lib/`，pnpm 需现场跑 `prepare` 构建，而 pnpm 默认拦截 git 依赖的构建脚本 |
| `link:<本地目录>` | ⚠️ 能装，不推荐 | 软链到源码目录，peer 依赖不从目标 `node_modules` 解析 |
| 裸包名 `dsh-thinking-guard` | ❌ 404 | 包没发布到 npm registry |

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

插件留下的状态文件（`~/.dsh/capability-menu-policy.json`）不会自动删除。如需彻底清理，确认备份后再手动删除。

## 排错

### 装完看不到插件

先查这一条，它解释了绝大多数情况：

```bash
node -e "const m=require(process.env.HOME+'/.dsh/profiles/desktop/package.json'); console.log('bundled:', m.dsh.profile.bundles.includes('dsh-thinking-guard'))"
```

`false` → 当初是手改 JSON + `pnpm install` 装的，包在但没挂载。补跑一次 `dsh plugin add <附件URL>`，或手工把包名加进 `dsh.profile.bundles`，然后重启。

`true` 却仍看不到 → 确认**已重启** DSH；再看 设置 → 插件 是否有加载报错。

### 装进去的还是旧版本

几乎一定是缓存问题。比对安装目录与 Release 附件里的 `lib/client.js` 大小：

```bash
ls -la ~/.dsh/profiles/desktop/node_modules/dsh-thinking-guard/lib/client.js
tar -tzvf <下载的 tgz> | grep 'lib/client.js'
```

不一致说明命中了旧缓存——确认你 pin 的是**带哈希**的附件名。

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

注意：**API 与附件下载的可达性可能不一致**。本机实测 `api.github.com` 与 `releases/download/...` 直连可通，但 `github.com/.../releases/latest` 这个 HTML 页会超时——所以脚本只用 API，不抓网页。

### `ERR_PNPM_FETCH_404` / `is not in the npm registry`

用了裸包名。本包不在 npm registry，必须给完整附件 URL。

### `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`

用了 git 来源。换 Release 附件，不要去改 `allowBuilds`。

### 提示 DSH 版本不兼容

`dsh plugin add` 会在安装前读包的 manifest，比对它对 DSH 的版本要求（`engines` 与 `peerDependencies`），不匹配就拒绝安装并回滚 manifest 与 lockfile。它会在输出里打印一条
`dsh plugin --profile desktop allow-version <包@版本> --dsh-version <版本> --accept-risk`。
**那条命令会跳过兼容检查**，只在确认风险后执行。

### 找不到 DSH runtime / profile

`~/.dsh/profiles/desktop` 与 `~/.dsh/dsh-runtimes/` 都是 DSH 首次启动才生成的。先正常启动一次 DSH。

### 想看 pnpm 到底报了什么

`dsh plugin` 把完整 pnpm 输出写到 profile 下的日志目录：

```bash
ls -t ~/.dsh/profiles/desktop/.plugin-manager/logs | head
```

## 配置

默认 Guard 模式为 `normal`。当前 Step、Tool 次数、Duration 阈值只保留配置校验和计数，不触发软提醒或硬停止。`stepLimitMode: hard-stop` 会归一为 `warn-only`，`duplicateHardBlock: true` 会归一为 `false`，启动时分别记录弃用提示。开启 `duplicateDetection` 时，连续重复的第 3/5/8 次与有证据的 A-B 循环会提醒；只有相同操作及结果/错误指纹满足策略门槛后，才会通过 `tools.guard` 对匹配调用局部拒绝一次，不停止整个 Turn。配置位于插件 root entry 的 `config.guard`，状态按 Agent / Turn 隔离。

## 文档入口

本文件就是代码仓的 README（工作区里位于 `01_Source_Code/README.md`）。其余文档在**工作区根**，不随仓库发布：

| 想做的事 | 去哪 |
|---|---|
| 找任意文档 | 根目录 `PROJECT_INDEX.md` |
| 看现在做到哪 / 接手 | 根目录 `HANDOFF.md` |
| 长期规则与开发规范 | 根目录 `AGENTS.md` |
| 查架构与模块方案 | 见项目层 `02_Design/` 下的方案文档（不在本仓库内） |
| 查历史与归档 | 根目录 `04_Docs/02_history/README.md` |

## 目录约定

- 本目录是**唯一代码仓**（独立 git，远端 `YAN3RA/dsh-thinking-guard`）。
- 仓库只发布**源码 + 测试 + 本 README**。`AGENTS.md` / `PROJECT_INDEX.md` / `HANDOFF.md` 与 `docs/` 均为本地保留，不提交。

## 来源与许可

本项目基于 Capability Menu 实现，并按 Apache License 2.0 发布。详见 [LICENSE](LICENSE)。
