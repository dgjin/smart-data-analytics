# Qoder Quest 记忆与记录归档

本目录是「智能问数据分析系统」项目在 Qoder 中积累的**项目记忆、知识库条目、会话记录与画布**的快照归档,于 **2026-09-19** 从本机 Qoder 数据目录同步至仓库,便于随代码一起留存与查阅。

## 来源

| 类型 | 原始路径 |
|---|---|
| 记忆 | `~/.qoder/memories/01a01e63/projects/Users-dgjin-dgjinapp-智能问数据分析系统/` |
| 知识库 | `~/.qoder/knowledges/智能问数据分析系统/main__zh-CN/` |
| 会话记录 | `~/.qoder/projects/-Users-dgjin-dgjinapp-智能问数据分析系统/transcript/` |
| 画布 | `~/.qoder/projects/-Users-dgjin-dgjinapp-智能问数据分析系统/canvases/` |

归档为**静态快照**,不会自动跟进上游更新;需要重新同步时重复一次 rsync 即可。

## 目录内容

### `memory/` — 项目记忆(6 篇)

| 分类 | 文件 | 内容 |
|---|---|---|
| 项目介绍 | `project_introduction/NL2SQL_Pro项目概述.md` | 项目定位、核心能力、目录结构 |
| 技术栈 | `project_tech_stack/全栈技术选型.md` | 全栈技术选型 |
| 运行环境 | `project_environment_configuration/运行环境与关键配置.md` | 运行环境与关键配置 |
| 构建配置 | `project_build_configuration/项目构建与打包配置.md` | 构建与打包配置 |
| 依赖管理 | `project_dependency_configuration/NPM依赖管理配置.md` | NPM 依赖管理 |
| SCM | `project_scm_configuration/Git协作与提交规范.md` | Git 协作与提交规范 |

上游记录时间为 2026-08-21,描述的是项目早期状态,与当前代码可能有出入。

### `knowledge/` — 仓库级与代码库知识

- `knowledge/codebase/` — 代码库知识投影,`index.md` 给出模块树总览(2 个顶层模块)。生成于 2026-09-13,对应 commit `8397060`。
- `knowledge/repo-knowledge/` — 仓库级知识条目,覆盖配置系统、依赖管理、日志系统、异常处理、构建系统、前端风格六类,`index.md` 为索引。
- `knowledge/.export-hash` — 上游导出哈希,用于判断是否已过期。

知识库文件带 `只读投影 · 自动重生` 标记,**仅供参考、非强制规则**,权威源在 Qoder 知识卡 DB。

### `transcript/` — 会话记录(100 个 JSONL)

Qoder 中本项目的历史会话流水,`task-*.session.execution.jsonl` 为长任务/Quest 模式的执行记录,其余 `*.jsonl` 为普通会话。单文件为逐行 JSON,可用 `jq`、`less` 或编辑器直接查看。

> **注意**:3 个 `*.session.execution.jsonl` 合计约 146MB(单个最大 130MB),已通过 `.gitignore` 排除,**仅本机存在、不入库**。如需随仓库留存,先压缩为 `.jsonl.gz`(实测 130MB → 约 3.2MB)再提交。

### `canvases/` — 画布产物(34 个文件)

Qoder 画布导出的 `.canvas.tsx`、`.canvas.status.json` 及配套验证截图,对应历次评估/优化报告(如 `quality-optimization-completion-report`、`nl2sql-bi-expert-assessment`、`enterprise-evolution-final-report` 等)。已排除上游 `node_modules/`。

## 隐私提示

会话记录与画布截图中可能包含查询过的业务数据片段、数据库结构或界面截图。提交到公共远端前请先确认内容的敏感度。
