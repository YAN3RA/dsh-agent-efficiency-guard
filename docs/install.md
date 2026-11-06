# 安装、升级与卸载

本插件**不通过 npm registry 分发**。安装来源是 GitHub Release 附件（`.tgz`），
由 DSH profile 的 `package.json` 依赖指向该附件 URL，再 `pnpm install`。

---

## 方式一：把这句话发给 DSH 对话（推荐）

复制整段粘贴给 DSH：

```
帮我安装 dsh-agent-efficiency-guard：
1. 读 https://raw.githubusercontent.com/YAN3RA/dsh-agent-efficiency-guard/main/plugin/docs/install.md 的「方式三：手动」
2. 取 https://api.github.com/repos/YAN3RA/dsh-agent-efficiency-guard/releases/latest 里文件名形如
   dsh-agent-efficiency-guard-<版本>-<哈希>.tgz 的附件
3. 把 ~/.dsh/profiles/desktop/package.json 的 dependencies 里 dsh-agent-efficiency-guard 改成该附件 URL
4. 在 ~/.dsh/profiles/desktop 跑 pnpm install
5. 告诉我重启 DSH
```

> 如果你的网络访问 GitHub 需要代理，把「走代理 http://127.0.0.1:7890」也写进去。

## 方式二：一条命令（Windows）

```powershell
$f="$env:TEMP\install-guard.ps1"; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/YAN3RA/dsh-agent-efficiency-guard/main/plugin/scripts/install.ps1' -OutFile $f; pwsh -NoProfile -File $f
```

需要代理时：

```powershell
$f="$env:TEMP\install-guard.ps1"; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/YAN3RA/dsh-agent-efficiency-guard/main/plugin/scripts/install.ps1' -OutFile $f; pwsh -NoProfile -File $f -Proxy http://127.0.0.1:7890
```

脚本参数：`-Version v0.1.12`（指定版本）、`-Profile desktop`（指定 profile）、`-DryRun`（只看不改）。

## 方式三：手动

1. 取最新 Release 的附件 URL：

   ```
   https://api.github.com/repos/YAN3RA/dsh-agent-efficiency-guard/releases/latest
   ```

   在 `assets` 里找 `name` 形如 `dsh-agent-efficiency-guard-<版本>-<8位哈希>.tgz` 的那一项，
   复制它的 `browser_download_url`。

2. 编辑 `~/.dsh/profiles/desktop/package.json`，把 `dependencies` 里对应项改成该 URL：

   ```json
   "dsh-agent-efficiency-guard": "https://github.com/YAN3RA/dsh-agent-efficiency-guard/releases/download/v0.1.12/dsh-agent-efficiency-guard-0.1.12-d3ee6d6d.tgz"
   ```

3. 确认 `dsh.profile.bundles` 数组里含 `"dsh-agent-efficiency-guard"`，否则包装了但不会挂载。

4. 安装：

   ```bash
   cd ~/.dsh/profiles/desktop
   pnpm install
   ```

5. **重启 DSH。**

---

## 为什么附件名带哈希（重要）

profile 从附件 URL 安装时，pnpm 按「URL + integrity」缓存解析结果。**用同一个文件名覆盖附件后，pnpm 不会重新下载**：

- `pnpm install --force` 无效
- `pnpm store prune` 无效
- 删 `node_modules/<包名>` 再装也无效
- 手工删 `pnpm-lock.yaml` 里的条目会导致 `createHeadlessDepGraph` 解析失败

结果就是「明明发布了新包，装进去的还是旧 `lib/`」。这个坑实际发生过一次，代价是一整个发版周期。

**解决办法**：附件名带 tarball 自身 SHA-256 的前 8 位。内容变了 URL 就变，缓存不可能命中旧内容；内容没变则名字不变，重复发布保持幂等。

发版统一用：

```bash
node scripts/release.mjs
```

它会构建、打包、按哈希重命名，并打印准确的附件名与上传命令。

---

## 升级

重跑方式一或方式二即可。脚本会检测当前 pin 与最新附件是否一致，一致就只重装同样的字节，不重复改动。

手动升级：把 `package.json` 里的 URL 换成新版本的哈希附件，再 `pnpm install`。

## 卸载

1. 从 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 删除 `dsh-agent-efficiency-guard`。
2. 从 `dsh.profile.bundles` 删除 `"dsh-agent-efficiency-guard"`。
3. `cd ~/.dsh/profiles/desktop && pnpm install`
4. 重启 DSH。

插件留下的状态文件（`~/.dsh/capability-menu-policy.json`）不会自动删除。如需彻底清理，确认备份后再手动删除。

---

## 排错

### 装完看不到插件
- 确认 `dsh.profile.bundles` 里有该包名。
- 确认已重启 DSH。
- 看 设置 → 插件 里是否有报错。

### 装进去的还是旧版本
几乎一定是缓存问题。检查安装目录里 `lib/client.js` 的大小是否与 Release 附件里一致：

```bash
ls -la ~/.dsh/profiles/desktop/node_modules/dsh-agent-efficiency-guard/lib/client.js
tar -tzf <下载的 tgz> | head
```

不一致说明命中了旧缓存——确认你 pin 的是**带哈希**的附件名。

### pnpm install 超时
GitHub 直连在部分网络不可用。加代理：

```powershell
pwsh -NoProfile -File scripts/install.ps1 -Proxy http://127.0.0.1:7890
```

或手动设置环境变量后重跑：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

### 提示找不到 DSH runtime
DSH 首次启动才会生成 `~/.dsh/dsh-runtimes/`。先正常启动一次 DSH，再装插件。

---

## 给发布者的检查清单

1. `npm version <版本> --no-git-tag-version`
2. `node scripts/release.mjs` —— 构建 + 打包 + 按哈希命名
3. 上传：`gh release upload v<版本> <哈希附件名> --clobber`
4. 确认 Release 里**只有带哈希的附件**，没有同名的无哈希残留
5. 更新 README 里的安装指引（如版本号出现在文中）
6. **不要**复用无哈希的同名附件——这是上面那个坑的根源
