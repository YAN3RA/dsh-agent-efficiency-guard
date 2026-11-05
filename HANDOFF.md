# HANDOFF

更新：2026-11-05 22:15。仓库：`YAN3RA/dsh-agent-efficiency-guard`；分支：`main`。

## 当前状态（一句话）

源码与远端已同步在 `45f9350`；本机 `desktop` profile 以 `link:` 指向仓库并运行当前构建；`typecheck` + 542 项测试 + `build` 全通过。**未发布 0.1.10，Release 与 tag 停在 0.1.9。**

## 关键事实（下次接手先看这里）

### 1. 推送问题已自行恢复，此前记录作废

本轮会话中途曾出现 `git push` 在 TLS 握手之后持续超时（代理与直连均试过；`ls-remote` 与 GitHub API 可正常访问，但 `push` 卡住）。当时判断为“推送失败”。**该结论已过期：** 稍后复查发现远端 `main` 已是 `45f9350`，本地 `rev-list origin/main..HEAD` 为 `0`。也就是说那次推送最终成功落地，无需再做任何补救。

以后若再遇到同类推送卡顿，排查顺序建议：

1. `git ls-remote origin refs/heads/main` — 先确认读通道是否正常；读正常只能说明网络可达，**不能证明写通道可用**。
2. `git push` 加 `GIT_TRACE=1 GIT_CURL_VERBOSE=1` 看卡在哪一步；本次日志显示 TLS 握手 complete 之后无进展。
3. 代理（`http://127.0.0.1:7890`）与直连各试一次；本机两者行为不一致。
4. **不要反复重推。** 每次超时都可能在服务端已提交而客户端未知；重试前先用 `ls-remote` 比对远端 SHA，避免重复劳动。
5. Git credential 里存有可用 token（`git credential fill` 可返回），API 回退脚本本轮未成功推进 ref，未保留。

### 2. 安装来源已由 Release 附件改为本地 `link:`

`~/.dsh/profiles/desktop/package.json` 当前为：

```
"dsh-agent-efficiency-guard": "link:C:/Users/yansui/Documents/agent workspace/dsh-agent-efficiency-guard/plugin"
```

含义与代价：

- DSH 加载的是**仓库里的 `lib/`**，不是 tarball 解压产物。改源码后必须 `pnpm build`，Host 重启才会看到新代码。
- 未提交的本地改动会**直接进入生产运行态**；提交前建议先确认 Host 处于预期状态。
- 换机、挪动仓库目录都会让该依赖失效。发布给他人时不能沿用这个形式。
- 已核实链接目标健康：`lib/client.js` 含新 UI（`SegmentedTabs`/`PluginSectionView`），`lib/index.js` 仍是单次 `registerCapabilityPolicyHostFace(registry, [usageHostFace()])`，且 `lib/` 比 `src/` 新（构建不过期）。

**发布版本时**（下节）应改回 Release 附件 URL；理由见下方“安装来源选择”。

### 3. 本轮已完成：设置页 UI 原生组件化（P0–P5）

提交 `45f9350`，把插件设置页从手写 HTML + 自建 `.mc-*` 样式表迁到官方 `@deepseek-ai/dsh-client-ui-primitives`。

| 阶段 | 改动 |
| --- | --- |
| P0 | 分类栏、主标签、技能子标签、目录文档标签、`LocationModal` 子标签 → `SegmentedTabs`（获得 roving tabindex 与左右/Home/End 导航） |
| P1 | 29+ 处手写 `<button>` → `Button`（`size="sm"`，按语义取 `variant`） |
| P2 | `mc-tag` 文本 → `Tag`；usage 时间范围与能力类型切换 → `Pill` |
| P3 | 目录筛选框 → `Input`（保留 `type="search"` 与 aria） |
| P4 | 6 处 `mc-preview-mask` 遮罩 + `LocationModal` → `Modal`（portal、焦点陷阱、Esc、aria） |
| P5 | 跨类覆盖提示 → `Toast`；带重试按钮的常驻通知保留（官方无 Alert/Callout 组件） |
| 清理 | 删除 14 行失效 CSS（`mc-preview-*`、`mc-catalog-btn`、`mc-search-restore`、`mc-tag`） |

**刻意未迁移（下次不要“顺手”改掉）：**

- `mc-dot` / `mc-chip--*` / `mc-count--*` 编码的是**策略层级字形**（常驻=实心圆、按需=半填充、禁用=斜线），与 `StateDot` 的生命周期语义（done/warning/ongoing/error/idle）不是同一套。替换会丢失形状区分。本轮已实际读 CSS 后确认，非推测。
- 官方库**没有** Card、表格、树、Alert、进度条、布局/栅格、Select、Textarea、骨架屏。这些必须继续手写。参考插件（`dsh-cost-meter` 零 primitive、`dsh-better-sidebar` 仅 3 个）也印证这是既定惯例。
- `mc-tab-group` 仍有一处 live 引用（usage 时间范围组的容器 div），未清理。

### 4. 测试基建：官方 primitives 的上游打包缺陷

`@deepseek-ai/dsh-client-ui-primitives` 内部 `import` 了约 20 个**未声明**的依赖（`clsx`、`shiki/*`、`katex`、`diff`、`simple-icons`、`@deepseek-ai/dsh-client-store` 等），并附带 `.module.css`。生产由 DSH 客户端模块加载器解析，Vitest 无法。

处理方式：`vitest.config.ts` 将该 specifier 别名到 `tests/stubs/ui-primitives.tsx`，后者镜像真实 API 子集。**该 stub 仅测试用，不进构建**；构建产物经核实仍正确 external 到真实包。

这属于上游问题。若未来要提 issue，可附：包名 + 版本 `0.2.1-rc.3` + 上述未声明依赖清单。

## 验证记录（2026-11-05 22:12 复跑）

- `pnpm typecheck`：Node + Client 两套通过。
- `pnpm test`：31 个测试文件、542 项全部通过。
- `pnpm build`：通过（`lib/` 生成于 22:11，晚于全部 `src/`）。
- `npm pack --dry-run`：111 个文件。

## 历史记录（本轮之前，保留原文）

## 当前范围

本包面向 DSH，使用 DSH 插件公开接口。插件负责 DSH 能力目录、按需检索/调用和 Agent/Turn 执行保护；DSH 宿主负责模型、Provider、推理强度和完整会话；Save Token 负责工具结果压缩与原文恢复。

## 当前实现

- **2026-11-05 设置页 UI 原生组件化（P0–P5，未发布）：** 手写的标签/按钮/输入框/弹窗全部改用官方 `@deepseek-ai/dsh-client-ui-primitives`，观感与宿主一致。
  - P0 标签：`PluginSection`（分类切换）、`CapabilitySection` 主标签与技能子标签、目录文档标签、`LocationModal` 子标签均改用 `SegmentedTabs`（获得 roving tabindex 与左右/Home/End 键盘导航）。
  - P1 按钮：29+ 处手写 `<button>` 改为 `Button`（`size="sm"`，按语义取 `variant`）。
  - P2 标签件：`mc-tag`/`mc-chip` 文本改用 `Tag`；usage 的时间范围与能力类型切换改用 `Pill`。**保留** `mc-dot`/`mc-chip--*`/`mc-count--*`：它们是策略层级字形（常驻/按需/禁用，三种不同形状与配色），与 `StateDot` 的生命周期语义不是同一套，强行替换会丢信息。
  - P3 输入：目录筛选框改用 `Input`（保留原生 `type="search"` 与 aria 属性）。
  - P4 弹窗：6 处手写 `mc-preview-mask` 遮罩全部改为 `Modal`（获得 portal、背景遮罩、焦点陷阱、Esc 关闭与 aria 接线）；`LocationModal` 同样接入。
  - P5 提示：跨类覆盖提示改用 `Toast`；带重试按钮的常驻通知保留（官方无 Alert/Callout 组件）。
  - 清理：删除 14 行已失效的 CSS 规则（`mc-preview-*`、`mc-catalog-btn`、`mc-search-restore`、`mc-tag`）。
  - **测试基建：** 官方 primitives 包 `import` 了约 20 个未声明的依赖（`clsx`、`shiki/*`、`katex`、`diff`、`simple-icons`、`@deepseek-ai/dsh-client-store` 等）并附带 `.module.css`；生产由 DSH 客户端模块加载器解析，Vitest 无法。`vitest.config.ts` 现将该 specifier 别名到 `tests/stubs/ui-primitives.tsx`（镜像真实 API 子集）。**该 stub 只用于测试，不参与构建。**
- 安装来源（**已过期，见本文档开头“关键事实”第 2 条**）：profile `desktop` 曾由本地 tarball `file:` 改为 GitHub Release 附件 URL（`.../releases/download/v0.1.9/dsh-agent-efficiency-guard-0.1.9.tgz`），附件 SHA-1 `fdb26211d0f730d5959606748b291fa09ec616f9` 与本地 tarball 一致；现该依赖已是 `link:` 指向仓库。三种来源的取舍与实测结论见“安装来源选择”一节。

- 包版本：`0.1.9`；GitHub `v0.1.9` 已发布（tag 与 Release 均指向 `c11e9a8`），CI 在 main 与 tag 上均 success。已安装到本机生产 profile `desktop`。
- **2026-11-05 本轮修复（待 Host 重载生效）：** `capabilityPolicy.classifyAll` 在生产 Host 报 `gateway/definition-unavailable: … its strict definition was withdrawn and SRC fallback is forbidden`。根因是同一 package `dsh-agent-efficiency-guard` 被 `register()` 两次（`capabilityPolicyHostFace` 与 `usageHostFace` 各一次），Typert 按 package 键控，第二次注册撤销了第一次的 strict definition，端点保持 `hasSeen()` 却无法解析。修复：新增 `mergeHostFaces()` 把两个 face 合成单一 contribution，`src/index.ts` 只调用一次 `registerCapabilityPolicyHostFace(registry, [usageHostFace()])`。回归用例见 `tests/host-face.spec.ts`（merged host face 5 项）与 `tests/client-plugin-section.spec.tsx`。
- **2026-11-05 设置页合并：** 原来 `capability`(12) 与 `usage`(13) 两个 `settings.section` 合成一个（仍 id `capability`、order 12），由新的 `src/client/PluginSection.tsx` 提供功能分类标签（能力目录 / 调用统计），两个视图都保持挂载（`hidden` 切换）以保留各自 Remote 订阅。`src/client/index.ts` 不再注册第二个 section。
- 能力菜单支持 Native/MCP Tools 与 Skills 目录、`meta_search` / `meta_invoke`、Resident / On-demand / Disabled 策略、筛选/详情、MCP/Skill 来源管理、检索元数据和诊断。
- N6 去掉预算硬停止与按软阈值收尾/steer；Step/Tool/Duration 计数仅作统计。旧 `stepLimitMode: hard-stop` 归一为 `warn-only`，`duplicateHardBlock: true` 归一为 `false`，保留弃用日志。
- N7 源码已接入 callId dispatch 序号缓冲、polling/exclusion 配置、动态 `metaTools()`、真实 user inbox reset、独立 Guard message source 和拒绝结果回灌排除；dispatch/pending history 上限 64，溢出时 loop detection fail-open。白名单独立复审对当前源码快照结论为 `pass`，不代表生产运行态或可发布产物通过。
- N8 已接入公开 `session/event` 实时采集（有界微批）、独立只读 `usage` Remote 与设置页统计面板；原始报告经有界白名单投影，UI 按窗口/工作区/能力类型聚合，并对 unavailable/unknown coverage 保持显式状态。受限历史 backfill 已接入 runtime：先订阅实时事件，再并行读有界历史页；队列在历史状态合并前保持有界等待，之后再折叠实时事件；队列达上限时取消/作废回补结果并优先处理实时事件。已修复取消后复用旧 Promise、`open()` 漏传 signal、合法短页误判、fork 子会话继承前缀被重复统计、预算跳过 Session 未标 coverage、Host aggregate DTO 到 500 行后静默裁切，以及 teardown 注册失败的监听器泄漏；排序承诺限定为微批内，跨 tick 重排由 collector coverage 标记。历史原因计数与实时 collector 诊断分离。collector 和 cursor 仍只在内存，不能宣称跨重启恢复或 profile-local 落盘。
- Workspace 只在 registry 明确映射时标记 `current-mapping`，缺失/歧义为 `unknown`；`profileContext` 的 `ProfileContext` 类型在上游 `@deepseek-ai/dsh-app-boot` rc.3 起存在并含 `name`/`dir`，但本插件未声明该依赖，当前 `name` 仍是 best-effort 标签，Host 运行态注入与 launcher 覆盖尚未独立验证。未知 profile 禁用回补。没有从 cwd 推断 workspace。
- 默认回补预算为 8 Sessions / 每 Session 2,000 events / 总计 10,000 events / 每页 100 / 5 秒；cursor 仅保存 profile hash 与 Session id、offset、revision，当前只是调用方持有的内存对象，尚未持久化。
- 已发现上游公开 durable KV 候选 `ctx.storageDomain`；storage 与 storage-domain 仅在 lockfile 中作为 `dsh-workspace` peer 依赖出现，插件 `package.json` 未声明也未安装它们。当前 DSH 默认 base bundle 将 JSON backend root 配为 `dshHomePath('storages')`，是 `$DSH_HOME` 级共享目录，不是 profile-local；插件无法从公开 API 读取 backend/root，且默认域 API 不接受 profile/path。因此继续暂停落盘，维持 memory-only，不能声称跨 profile 隔离或跨重启恢复。隔离 Host 的进程内挂载状态尚未直接探测。

## 本轮验证

- `pnpm typecheck`：Node 与 Client 两套 TypeScript 配置均通过。
- `pnpm test`：30 个测试文件、531 项全部通过；Usage runtime 29 项、backfill 24 项、Host usage Remote 25 项，覆盖 fork prefix、budget coverage、aggregate/coverage/error-count caps、`__proto__` 对象键及 Map 精确/超限边界与取消单飞，并断言客户端只 mount 一份合并 Remote contribution。
- `pnpm build`：通过，生成客户端 bundle 与声明文件。
- `npm pack --dry-run`：通过，包版本 `0.1.8`、111 个文件；未生成需保留的归档。
- 隔离验收：在独立 `$DSH_HOME` 的 `guard-smoke` 安装重新构建的 `0.1.8` tarball（111 个文件，SHA-1 `0eacbdde9e2067b2dd7131dc67c7f569fb82f856`）。真实 Host 插件页显示该插件启用且 5/5 组件运行；设置 → 调用统计正常渲染，`usage/getSnapshot` 返回 HTTP 200，点击刷新后再次返回 HTTP 200；页面显示覆盖未知提示，未出现 Remote 未挂载错误，浏览器未记录页面异常。原因是 capability 与 usage Remote 各自以同一 package 注册，Typert Store 拒绝重复包；现合并 descriptors 并只 mount 一次。隔离 Host 未登录且未配置 API Key，因此未测试真实模型/会话调用或历史回补；本结果不是生产兼容性或发布验收。隔离 Host 与浏览器会话已停止，临时 profile 保留未清理。
- N7 的独立复审结论仅适用于当时源码快照，不代表 Host 运行态或发布验收。

## 本轮验证（2026-11-05 02:09）

- `pnpm typecheck`：Node + Client 两套均通过。
- `pnpm test`：31 个测试文件、542 项全部通过（新增 5 项 merged host face、6 项 combined settings page）。
- `pnpm build`：通过。
- `npm pack`：111 个文件，包版本 `0.1.8`，tarball SHA-1 `f0f4250cae53f6e98b55cefa0bdaea400d207362`。
- 已安装到本机生产 profile `desktop`（`file:` 依赖指向该 tarball）。安装产物校验：全部 `lib/**/*.js` 通过 `node --check`；`lib/index.js` 只调用一次 `registerCapabilityPolicyHostFace(registry, [usageHostFace()])`；独立加载 `lib/host-face.js` 后 `mergeHostFaces` 产出 26 个 invocation、package 为 `dsh-agent-efficiency-guard`；`lib/client.js` 中 `settings.section` 注册只剩 1 处（id `capability`）。
- **重启后复验（2026-11-05 15:34 重启，PID 22220）：** Host 启动正常（`boot-state ok:true`、`crashReason:null`）；插件已在新 Host 中加载（`capability-menu-policy.json` 于 15:44 被写入）；`desktop` profile 中的 `lib/` 与仓库构建逐字节一致；`lib/index.js` 只有一次 `registerCapabilityPolicyHostFace(registry, [usageHostFace()])`；进程内建 merged face 自检 6/6 通过（单一 package、无重复 invocation id、`classifyAll` 与 `getSnapshot` 均在列、2 namespace / 2 service）。
- **仍未直接断言「Remote 返回 200」：** Web 网关对所有 `/api/*` 统一返回 401（连不存在的 namespace 也是 401），认证依赖进程内存中的签名 cookie secret，因此无法从外部区分「未注册」与「需认证」。需要用户在 GUI 的 设置 → 能力菜单 / 调用统计 页面确认。

## 未完成 / 未验证

- **未发布 0.1.10。** tag 与 Release 停在 `v0.1.9`（`v0.1.9` 指向 `c11e9a8`），不含本轮 UI 组件化。`package.json` 版本仍是 `0.1.9`。
- **未做生产 GUI 视觉回归。** `Select`/`Textarea`/表格/统计条等未迁移部分、以及 `Modal` 的焦点陷阱与 Esc 行为，均未在真实 Host GUI 中确认。这是本轮风险最高、覆盖最弱的一环。
- `SettingsForm` 家族（`SettingsValueField`/`SettingsSecretField`）**未实测**。从其文档注释推断是“暂存-保存”模型，与本插件即时写入语义可能不符，故本轮未采用；该判断是推断而非实测结论。
- N7/N8 的历史边界项（`businessToolCalls` 计数口径、usage collector 与 Guard 计数不等价、profile-local persistence 未实现）见下文与 `docs/`，本轮未动。

## 安装来源选择（发布时决策依据，已实测）

| 方案 | 结果 |
| --- | --- |
| `git+https://…#vX.Y.Z` | **不适用**：仓库不含 `lib/`（构建产物），会触发 pnpm `prepare` 本地构建，并被 pnpm 拦截构建脚本，需在 `pnpm-workspace.yaml` 的 `allowBuilds` 写**带 commit sha 的 key**（每次发版都变）。 |
| Release 附件 URL | **推荐用于发布**：`https://github.com/YAN3RA/dsh-agent-efficiency-guard/releases/download/v<版本>/dsh-agent-efficiency-guard-<版本>.tgz`。纯下载，实测 2.3 秒完成，无需 allowlist。发版时须先上传 tarball 附件，再改依赖 URL。 |
| `link:` 指向仓库 | **仅适合本机开发**：改动即时生效、无需发版；代价见上文第 2 条。 |

## 下一轮可执行项

1. **生产 GUI 视觉回归** — 重启 Host 后打开 设置 → 能力菜单 / 调用统计，重点验 `Modal` 的焦点陷阱与 Esc 关闭、`SegmentedTabs` 键盘导航、`LocationModal` 滚动。成本 5 分钟。这是本轮唯一未闭环的验收项，建议先做。
2. **发布 v0.1.10** — `npm version 0.1.10` → `pnpm typecheck/test/build` → `npm pack` → 传 Release 附件 → 建 tag 与 Release。成本 15 分钟。依赖第 1 项通过。
3. **改回安装来源** — 发布后把 profile 依赖从 `link:` 换回 Release 附件 URL，避免未提交改动进入生产运行态。成本 3 分钟。依赖第 2 项。
4. **清理临时残留** — `%TEMP%\css-prune-backup`（3 个源文件备份）与 `%TEMP%\tgz-trash-latest`（0.1.7/0.1.8 tarball）。成本 1 分钟，属破坏性操作，删除前确认无需回滚。
5. **评估 `mc-dot` 自建组件** — 若希望三态字形与官方观感统一，可写一个保留形状区分的本地组件。成本 1–2 小时，非必需。

## 工作区与安全边界

- 默认不触碰 `~/.dsh/profiles/desktop`；本轮该 profile 的依赖来源已变更（见第 2 条），属已授权改动。
- 可直接修改源码、测试、文档、patch、package 元数据、CI；外部发布与生产 profile 变更须按当轮授权执行。
- 不提交 `node_modules/`、`lib/`、临时 `.tgz`、测试缓存、本机 profile、Session、凭据或原始日志。
