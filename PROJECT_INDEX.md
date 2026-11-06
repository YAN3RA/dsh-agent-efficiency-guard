# 项目索引（仓库内）

本文件只索引**本仓库内容**。工作区级的索引在仓库之外（`../PROJECT_INDEX.md`），那里才包含 `02_Design/`、`04_Docs/` 等本地目录的路由。

定位：`dsh-thinking-guard` 是一个 DSH 插件，把工具/技能的能力目录与按需调用（Resident / On-demand / Disabled 三档）与 Agent 效率守卫（重复调用、A-B 循环检测）整合在一起。

## 发布范围

仓库只发布**源码、测试与根目录三份文档**：

| 发布 | 不发布（仅本地保留） |
|---|---|
| `src/`、`tests/`、`scripts/`、`assets/`、`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`、`tsconfig*.json`、`vitest.config.ts`、`tsdown.config.mjs`、`.github/` | `docs/`（26 个文件，已 `git rm --cached` 并写入 `.gitignore`） |

## 任务路由

| 任务 | 去哪找 |
|---|---|
| 了解怎么装、怎么用 | [README.md](README.md) |
| 现在做到哪 | [HANDOFF.md](HANDOFF.md) |
| 开发规则与验证要求 | [AGENTS.md](AGENTS.md) |
| 改源码 | `src/` |
| 加测试 | `tests/`（Vitest，每个新行为补对应测试） |
| 发版 | `scripts/release.mjs`（构建 + 打包 + 按哈希命名） |
| 一键安装 | `scripts/install.ps1` |
| 恢复常驻工具分层 | `scripts/restore-resident-tiers.mjs`（默认只报告） |
| 插件 bundle patch | `cordis.patch.yml` |

## 对象定位（高频简表）

| 对象 | 位置/版本 | 部署位置 |
|---|---|---|
| 插件包 | 本仓库，v0.1.15 | `~/.dsh/profiles/desktop` |
| 构建产物 | `lib/`（`pnpm build` 生成，已 gitignore） | 随 Release 附件分发 |
| Cordis patch | `cordis.patch.yml`，entry id `thinking-guard` | profile bundle patch |
| 能力分层状态文件 | `~/.dsh/profiles/desktop/capability-menu-policy.json` | 本机 profile，**文件名不可改**（改名等于清空用户配置） |
| 源码模块 | `src/`（43 个 ts/tsx） | 不直接部署，须构建 |
| 测试 | `tests/`（33 文件 / 563 项） | CI `ubuntu-latest` + `windows-latest` |

## 本地文档（不在仓库内）

以下文档在开发机上保留，不随仓库发布：

- 架构与模块方案、宿主集成边界、运行时审计、验收报告、各版本发布材料、需求书归档
- 安装升级卸载的完整排错细节（README 已收录主干）

开发机上用 `../PROJECT_INDEX.md` 或 `../04_Docs/02_history/README.md` 定位这些文档。
