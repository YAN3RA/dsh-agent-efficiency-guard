# N8：超长 Save Token 展开结果的根因

2026-11-01，N8 已完成：定位裁剪层，验证完整原文仍可恢复，并验证宿主公开配置的规避方式。没有修改 Guard 源码、已安装第三方包或生产配置。

## 因果链

DSH `0.2.1-rc.5` 的基座启用 `@deepseek-ai/dsh-spill-policy`，默认 `maxInlineTokens: 12500`。单个纯文本块按 `ceil(text.length / 4) + 4` 估算 Token，故 49,984 个 UTF-16 code units 正好到上限，49,985 开始触发保留策略。这不是普遍的 50 KB 字节上限，也不是模型真实 tokenizer 的精确边界。

```text
原始工具输出（174,389 字符）
  → 宿主 spill-policy：完整落盘，再保留头尾＋省略说明＋宿主定位器
  → 约 49.93k 字符的内联预览
  → Save Token：压缩预览，并把预览缓存/落盘为其“原文”
  → save_token_expand：恢复上述预览，不能把它误当作最初工具输出
  → 按预览内 Full formatted result stored at 的宿主定位器读取完整文件
```

两者都使用 `tools/post-execute` 且 `prepend:true`，Save Token 的回调先 `await next()` 再处理内层返回的 `decision.content`。在本次真实 bundle 顺序中，宿主先生成预览，Save Token 再处理预览。Guard 的 `tools/result` 是只读观察和哈希，不重写返回内容。

`save_token_expand.value.truncated === false` 只表示 Save Token 自己的 262,144 字符缓存未触发截断；不能用这个标志推断上游没有生成过预览。宿主 policy 也会作用于 `save_token_expand`，当前只豁免名为 `read` 的工具，不能假设调整处理顺序就能保证全量内联。

## 实测

新建独立 `DSH_HOME`，从公开 `web` 模板初始化 `n8-probe`，安装最终候选 `.tgz` 和 Save Token `2.4.1`。测试夹具使用真实 SessionStore、独立 Scope、公开 ToolRuntime 与 `appReady`，模型请求为零。spill root 显式放在本轮 scratch，关闭清理、遥测和 HMR。

| 上限（估算 Token） | 输入字符 | 展开值/展示文本字符 | 宿主原文文件 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 12,500 | 174,389 | 49,933 | 174,389 | 预览含省略说明；宿主文件与输入 SHA-256 相同 |
| 12,500 | 49,984 | 49,984 | 未触发宿主裁剪 | 精确恢复 |
| 12,500 | 49,985 | 49,930 | 49,985 | 边界后一字符触发；宿主文件仍完整 |
| 200,000 | 174,389 | 174,389 | Save Token 文件 174,389 | 同一输入的值、展示文本与文件均精确恢复 |

默认组中，Save Token 自己的定位器文件与展开后的约 49.93k 预览一致；预览里的**宿主定位器文件**与最初输入一致。读取两层文件均通过路径检查，仅允许访问本次隔离 spill 根目录。

174,389 字符输入/完整原文的 SHA-256：`c8604cd52a3c4eb10ba2a04cdb1059bd66ed227e920644ef31feeb7bc781ca94`。

本次预览 49,933 与历史约 49,932 的差异来自说明与定位器字符串长度，不代表不同的硬上限。历史原始验收的 10 通过/1 失败仍保留；N8 的四个样本是单独的诊断实验，不改写历史结果。

去敏证据：[evidence/n8-results.json](evidence/n8-results.json)。该 JSON 保留长度、SHA-256 与断言结果，不含令牌、本机路径或原始长文本。

## 已验证的处理方式

默认配置下，若展开结果含 `[...]` 和 `Full formatted result stored at:`，沿该**宿主定位器**读取原文；正常使用时按提示通过 `read` 的 offset/limit 或 grep 分段读取。本轮直接读取合成样本的定位器文件并校验完整内容/hash，证明文件恢复路径完整；未新增生产 read 工具的端到端验收。

确实需要全量内联时，可经授权在宿主 patch 中调整上限。本轮只对隔离实例使用下列公开配置：

```yaml
- id: spill-policy
  config:
    maxInlineTokens: 200000
```

启动时通过 `--patch <path>` 追加，保持同一包、同一输入、相同工具调用链；上限是本实验值，不是推荐生产默认值。增加内联上限会增加展开结果进入上下文的 Token 和成本。`maxInlineTokens: 0` 不是禁用策略；省略 config 键才会在该实现中不注册策略。本轮未测试或应用生产禁用。

不在 Guard 中豁免或重写 Save Token、不另建压缩/落盘链、不修改本插件默认 Guard 预算。若未来需要 Save Token 提供更明确的“上游预览”标志或分页展开，属于独立的 Save Token/宿主改进，不能把它当作本仓库已实现的行为。

## 可复核的源码依据

以下是本机已安装发布版本的文件位置与行号，未将宿主整份源码复制进项目：

- `@deepseek-ai/dsh-base/cordis.patch.yml:414`：默认 spill policy 上限 12,500。
- `@deepseek-ai/dsh-token-meter/lib/types/estimate.js:9`、`:11`、`:40`：4 字符/Token、块开销 4、纯文本估算公式。
- `@deepseek-ai/dsh-spill-policy/lib/index.js:141`、`:179`、`:237`：读取 cap、先落盘再保留头尾、post-execute 仅排除 `read` 等条件。
- `@deepseek-ai/dsh-spill-local/lib/index.js:556`：`saveText` 完整写入本地文件，默认落在独立 OS 临时目录；不由 `DSH_HOME/storages` 决定。本轮显式配置 scratch 根目录。
- `dsh-plugin-save-token@2.4.1/src/index.js:244`、`:260`、`:307`：先等待内层回调、豁免自身展开的压缩、保存收到的文本。
- `dsh-plugin-save-token@2.4.1/src/index.js:195`、`:474`：自身缓存上限 262,144、展开返回缓存。

源码的定价公式、边界两侧结果、默认与放宽组，以及两层定位器文件哈希共同构成因果闭环。任意更大输入、跨进程缓存恢复、真实模型与 Electron/MCP 授权不在 N8 覆盖内。
