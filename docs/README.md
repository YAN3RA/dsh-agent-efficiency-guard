# 文档索引

按用途分组。**新增文档请归入对应分组，不要散落在根目录。**

## 先读这两份

| 文档 | 内容 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | **功能模块与技术方案**，供审批复核。每个模块的职责、方案、取舍、限制 |
| [install.md](install.md) | 安装 / 升级 / 卸载 / 排错 |

## 使用与集成

| 文档 | 内容 |
|---|---|
| [host-pi-desktop-integration.md](host-pi-desktop-integration.md) | 与 DSH 宿主的集成方式、上游结果保留边界 |
| [runtime-audit.md](runtime-audit.md) | 运行时行为审计 |

## 验证记录

| 文档 | 内容 |
|---|---|
| [acceptance-report.md](acceptance-report.md) | 验收结果与覆盖范围 |

## 调查记录（`investigations/`）

| 文档 | 内容 |
|---|---|
| [git-install.md](investigations/git-install.md) | 各种安装来源的实测结论（含 git 形式为何不可用） |

## 需求书（`specs/`）

| 文档 | 内容 |
|---|---|
| [implementation-spec-2026-11-03.md](specs/implementation-spec-2026-11-03.md) | 当时的实施方案与状态基线 |
| [vnext-remodel-2026-11-04.md](specs/vnext-remodel-2026-11-04.md) | vNext 整体改造任务书 |

## 按版本归档（`release-*/`）

历史发布材料，**保持原样不改写**——它们记录的是当时的事实，包括当时使用的旧包名。

| 目录 | 内容 |
|---|---|
| `release-0.1.7/` | N8/N9/N11 诊断与发布说明 |
| `release-0.1.8/` | 发布说明 |
| `release-0.2.2/` | DSH 0.2.2-rc.1 兼容修复影响报告 |
| `h1-h2-2026-11-04/` | 当日验收材料 |

## 进度

| 文档 | 内容 |
|---|---|
| [../HANDOFF.md](../HANDOFF.md) | 当前进度、关键坑、下一轮可执行项。**只记录当前状态，不是历史归档** |
