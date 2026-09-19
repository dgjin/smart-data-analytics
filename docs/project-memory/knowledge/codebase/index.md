---
layout_version: "agent/v1"
store_schema_version: "v1alpha1"
title: "智能问数据分析系统 代码库知识（codebase）"
description: "智能问数据分析系统 @ main 的代码库知识；单向只读，自动重生。"
repo: "智能问数据分析系统"
branch: "main"
locale: "zh-CN"
workspace_path: "/Users/dgjin/dgjinapp/智能问数据分析系统"
commit: "8397060964fcccb854aed95f85302acd4d681d51"
partition_id: "d6a6596e7979e29a"
source: "codebase"
generated_at: "2026-09-13T15:42:51Z"
module_count: 2
---

# 智能问数据分析系统 代码库知识（codebase）
_只读投影 · 自动重生（改动会被覆盖） · 权威源在知识卡 DB · 仅供参考、非强制规则_

## 格式说明
- **目录层级 = 模块树**：子目录即子模块。含子模块的模块写成目录，其自身内容在该目录的 `README.md`；无子模块的模块是平铺的 `<名>.md`。
- **模块文件 frontmatter**：`description`（一句话摘要）、`module_id`（稳定身份，文件可改名而 id 不变）、`source_files`（该模块对应的仓库源文件，grep 用；无则省略）、`updated_at`（该模块最近更新）。partition 级公共信息（layout_version/store_schema_version/repo/branch/locale/commit/partition_id/source）见本文件顶部 frontmatter，不在每个模块文件重复。
- **正文**：`## 标题 <!-- category:x -->` 每段是一个知识维度；`## 关系` 段按 **依赖 / 被依赖 / 相关** 三向各一行列出邻居模块（父子关系不列，由目录层级表达），链接是指向其它模块文件的相对路径。

## 层级总览
- [智能问数据分析系统（Smart Data Analytics Engine）](<智能问数据分析系统（Smart Data Analytics Engine）.md>) — 智能问数据分析系统（Smart Data Analytics Engine）：基于 React + Express + MySQL 的企业级数据源接入、NL2SQL 智能问数、决策报表生成与异常巡检订阅的一体化数据分析平台。
- [智能问数据分析系统（Smart Data Analytics Engine）](<智能问数据分析系统（Smart Data Analytics Engine）_2.md>) — 智能问数据分析系统（Smart Data Analytics Engine）：基于 Express + React 的企业级 NL2SQL 数据问答与可视化报表平台，提供数据源管理、自然语言查询、报告导出、异常巡检、权限审批与系统管理等能力。
