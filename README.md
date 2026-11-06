# dsh-agent-efficiency-guard

把 DSH 的能力目录、按需调用和 Agent 效率守卫整合为一个插件。

## 功能

- `meta_search` 按需查找能力，`meta_invoke` 调用能力。
- Resident、On-demand、Disabled 三档策略；Disabled 会在执行入口拒绝调用。
- 按 Agent / Turn 跟踪 Step 与业务 Tool 调用；循环核心按相同结果/错误证据提供 3/5/8 次重复提醒及 A-B 循环提醒，并仅对匹配调用局部拒绝一次，不停止整个 Turn。
- 工具结果压缩与原文恢复由 [dsh-plugin-save-token](https://github.com/YAN3RA/dsh-plugin-save-token) 负责；模型、Provider 和完整会话由 DSH 宿主负责。

## 安装

不需要 npm（这个包不在 npm registry 上）。安装来源是 GitHub Release 附件，通过 DSH 自己的入口
`dsh plugin --profile desktop add <附件URL>` 装进 profile——它会同时把包登记进 `dsh.profile.bundles`，
手工改 `package.json` 再 `pnpm install` **不会**，那样装了也不挂载。

### 方式一：把这句话发给 DSH 对话（推荐）

复制下面整段，粘贴给 DSH：

```
帮我安装 dsh-agent-efficiency-guard。请按顺序做：

1. 读 https://raw.githubusercontent.com/YAN3RA/dsh-agent-efficiency-guard/main/docs/install.md
   的「方式三：手动」，用里面的命令完成安装。
2. 装完确认 ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles 里有
   "dsh-agent-efficiency-guard"（没有就告诉我，别自己猜）。
3. 报告装到的版本号，然后提醒我重启 DSH。
```

需要代理就补一句「走代理 http://127.0.0.1:7890」。

### 方式二：一条命令（Windows PowerShell）

```powershell
$f="$env:TEMP\install-guard.ps1"; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/YAN3RA/dsh-agent-efficiency-guard/main/scripts/install.ps1' -OutFile $f; pwsh -NoProfile -File $f
```

需要代理时末尾加 `-Proxy http://127.0.0.1:7890`；`-DryRun` 只看不改；`-Version v0.1.12` 装指定版本。
脚本幂等，会自动挑最新 Release、处理升级，并在结束时核对版本、pin 与 `dsh.profile.bundles`。

### 方式三：手动

1. 取最新 Release 的带哈希附件 URL：

   ```bash
   curl -s https://api.github.com/repos/YAN3RA/dsh-agent-efficiency-guard/releases/latest \
     | grep -o 'https://[^"]*\.tgz'
   ```

2. 用 DSH 自己的入口安装：

   ```bash
   dsh plugin --profile desktop add '<上一步输出的 URL>'
   ```

3. 重启 DSH。

安装后**必须重启 DSH** 才会加载新代码。

### 为什么附件名带哈希

profile 从附件 URL 安装时，pnpm 按「URL + integrity」缓存解析结果。**用同一个文件名覆盖附件后，pnpm 不会重新下载**——`--force`、`store prune`、删 `node_modules` 都无效，装回去的还是旧 `lib/`。这个坑实际发生过一次。

因此附件名带 tarball 自身的 SHA-256 前 8 位：内容变了 URL 就变，缓存不可能命中旧内容；内容没变则名字不变，重复发布保持幂等。

发版请用 `node scripts/release.mjs`，它会自动构建、打包并按哈希重命名，打印出准确的附件名与上传命令。

完整安装/升级/卸载、各来源形式的实测结论与排错见 [docs/install.md](docs/install.md)。

## 配置

默认 Guard 模式为 `normal`。当前 Step、Tool 次数、Duration 阈值只保留配置校验和计数，不触发软提醒或硬停止。`stepLimitMode: hard-stop` 会归一为 `warn-only`，`duplicateHardBlock: true` 会归一为 `false`，启动时分别记录弃用提示。开启 `duplicateDetection` 时，连续重复的第 3/5/8 次与有证据的 A-B 循环会提醒；只有相同操作及结果/错误指纹满足策略门槛后，才会通过 `tools.guard` 对匹配调用局部拒绝一次，不停止整个 Turn。配置位于插件 root entry 的 `config.guard`，状态按 Agent / Turn 隔离。

## 来源与许可

本项目基于 Capability Menu 实现，并按 Apache License 2.0 发布。详见 [LICENSE](LICENSE)。