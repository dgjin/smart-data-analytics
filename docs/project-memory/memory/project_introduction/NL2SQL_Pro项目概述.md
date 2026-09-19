---
title: "NL2SQL Pro项目概述"
usage_scenario:
    - "了解项目整体定位、核心功能模块和业务价值"
keywords:
    - "NL2SQL"
    - "自然语言查询"
    - "企业级分析"
    - "数据安全"
    - "可视化报表"
source: "init"
---

项目定位: 智能问数分析系统 (NL2SQL Pro)，企业级自然语言数据分析平台。

核心能力:
- NL2SQL: 中文提问生成SQL，双阶段生成（SQL生成+解读），SSE流式进度，歧义澄清，数据自省，语义缓存，few-shot注入，自学习闭环。
- 多源数据接入: MySQL, PostgreSQL, Greenplum, CSV, API, JSON。
- 安全治理: RBAC三角色，八层纵深防御，Scope白名单，敏感列过滤，行级权限，数据源凭据加密。
- 分析与呈现: 可视化决策报表，报告模式，PPT/PDF导出，深浅色主题。
- 知识库: 业务术语检索，外部RAG接入。

目录结构特点:
- server/: 后端逻辑 (liveQuery, schemaLinking, sqlExecutor等)
- src/: 前端组件 (query, charts, reports等)
- docs/: 功能说明书
