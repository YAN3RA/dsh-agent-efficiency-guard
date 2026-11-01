# 0.1.7 生产变更与回滚方案

本文件是可审阅的操作方案，未执行生产安装、重启、卸载或切换。

## 现场基线（2026-11-01，只读）

- `C:\Users\yansui\.dsh\profiles\desktop\package.json` 已声明 `dsh-agent-efficiency-guard` 的源码 `link:` 依赖，bundle 列表已包含本插件。
- 旧 `@daweifu/capability-menu@0.1.7` 仍在 dependencies 中，但不在 bundle 列表中。不要仅凭依赖存在认定双重加载，也不要未经必要性确认先删除它。
- Save Token 实装版本 `2.4.1`，MCP Connector 实装版本 `0.2.87`。
- 本轮未写入生产 profile，也未重启 Electron。构建更新了生产链接目标中的 `lib/`，因此不能把源码链接当作固定版本安装。
- CLI 的 `desktop` 启动/dump 受 Electron 管理限制；不得通过改名生产 profile 或调用私有字段绕过。

## 放行条件

1. 当前候选包的 typecheck、全量测试、build、pack dry-run 通过。
2. 隔离发布包安装、冷启动、工具链、设置页、Typert 与卸载回退有证据；详细覆盖范围见 `report.md`。
3. 真实 Electron 环境下，确认设置页可用、无重复注册、实际会话的 MCP 工具授权和 Guard 行为正常。无模型的合成 Agent 测试不能替代这一项。
4. 接受或解决报告中的共存/热重载限制，再授权生产变更。运行中的宿主不做包升级或源码热替换。

## 执行顺序（需后续明确授权）

1. 退出 Electron 并确认相关宿主进程已关闭。记录当前 package manifest、lockfile、bundle 顺序、Guard 配置和实际包版本。
2. 在本机受控备份目录保存 profile 的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml`、`cordis.patch.yml`，以及 DSH_HOME 层的 patch、`capability-menu-policy.json`、旧搜索状态（若存在）。保留必要的 `plugin-data` 状态。备份可能含凭据，只保留在本机，不提交、不上传、不在日志输出内容。
3. 保留当前源码目录和已构建产物作为回退目标。核对候选 `.tgz` 的 SHA-256、版本和验收报告，不使用浮动 `latest` 代替已验收包。
4. 通过当前 Electron 版本公开支持的插件管理入口，将本插件从源码链接替换为候选固定版本包；如管理入口不支持本地包，先核对受支持的官方安装方式，不绕过 managed-profile 保护。本轮未验证生产安装入口，因此这里不提供未经验证的执行命令。
5. bundle 中只保留一个能力目录实现。当前旧 Capability Menu 未在 bundle 中，通常不需要额外移除；若实际配置发生变化，先比较有效配置再处理。
6. 启动 Electron，检查能力菜单、按需检索与执行、Disabled 拒绝、Guard、Save Token 展开、真实 MCP Session 隔离和现有工作区。记录实际结果；失败即停止放量并回退。

## 回滚

1. 关闭 Electron。根据本机备份恢复 profile manifest、锁文件、bundle/patch 顺序和菜单状态，恢复原来的本地链接安装。
2. 通过受支持的宿主/包管理方式恢复与备份一致的依赖安装；仅复制旧 `package.json` 不等于完成包回滚。
3. 重新启动 Electron，核对原有工具和 Skill 可见性、MCP 会话权限、能力菜单和状态持久化。
4. 保留失败候选包的版本/哈希及去敏错误摘要。不要删除生产 Session、凭据、工作区或原始素材。

隔离环境中执行的卸载与配置回退只证明隔离回滚路径；不等同于生产回滚已执行。
