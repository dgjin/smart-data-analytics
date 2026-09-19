---
description: "智能问数据分析系统（Smart Data Analytics Engine）：基于 Express + React 的企业级 NL2SQL 数据问答与可视化报表平台，提供数据源管理、自然语言查询、报告导出、异常巡检、权限审批与系统管理等能力。"
module_id: "atlas:be50f0b9c84b92f416738c7c76ab31cc"
updated_at: "2026-09-13T15:41:49Z"
---

# 智能问数据分析系统（Smart Data Analytics Engine）

## 概述 <!-- category:overview -->
基于 Express + React 的企业级 NL2SQL 数据问答与可视化报表平台，提供数据源管理、自然语言查询、报告导出、异常巡检、权限审批与系统管理等能力。

## 架构设计 <!-- category:architecture_design -->
单体 Node.js 应用，Express 作为统一入口（server.ts），通过模块化路由挂载到 /api/* 前缀下：auth/admin/datasources/knowledge/query/report/analytics/agent/patrol 等各自独立 router，集中注册于 server.ts；前端为 Vite + React SPA，由 App.tsx 根据 activeTab 与用户角色（ADMIN/ANALYST/VIEWER）动态渲染 QueryChat、ReportGenerator、DataSourceManager、AdminPanel 等页面。

后端按业务域划分为 server/{auth,query,llm,knowledge,report,analytics,agent,infra,routes,utils} 子目录，infra 层提供 db、taskQueue、stateStore、rateLimiter、monitoring、shutdown、health 等共享基础设施；调度类能力（任务队列、LLM 健康检查、SSE 重放缓冲清扫、漂移检测、异常巡检调度器 startPatrolScheduler）在启动时统一初始化。

异常巡检（P0-1）以 server/anomalyPatrol.ts 为核心，维护 anomaly_patrols / anomaly_patrol_runs 两张表，采用数据库 next_run_at 原子抢占实现多实例防重入，内置 setInterval 低频调度器替代外部 cron；routes/patrols.ts 暴露 CRUD 与立即执行接口，并复用 src/utils/anomalyDetector 的 Z-Score/阈值规则扫描 saved_reports 中的 live 决策报表。

AdminPanel（src/components/admin/AdminPanel.tsx）重构为左侧三域七分类导航（账号与权限 / 治理与审核 / 运维与系统）+ 右侧独立滚动内容区的双栏控制台，各分类内再使用 SectionTabs 做二级 Tab（如规则治理含语义指标/铁律规则/业务知识库/SQL 样例库/专家角色），仅前端布局调整，不改动服务端与权限逻辑。

## 技术栈 <!-- category:tech_stack -->
Express 4 + TypeScript (ESM) 后端；React 19 + Tailwind CSS v4 + Recharts + Zustand 前端；MySQL (mysql2) 持久化；可选 Redis (ioredis) 用于多实例状态共享与限流缓存；Prometheus (prom-client) 指标采集；Vite 开发服务器 + esbuild 打包 CJS 产物；Playwright 端到端测试，Vitest 单元测试。

## 编码规范 <!-- category:coding_conventions -->
- Express 路由文件统一使用 Router() 创建模块级路由并在顶部挂载 authMiddleware，需要管理员的接口追加 requireRole('ADMIN') 守卫。
- 所有写操作（用户管理、环境配置、巡检计划等）通过 writeAudit 记录审计日志，敏感字段一律脱敏输出。
- 数据库访问统一经 getPool() 获取连接池，SQL 使用参数化查询避免拼接，错误路径统一 logger.error 后返回结构化 JSON 响应。
- 前端 AdminPanel 通过 SECTION_GROUPS 常量声明式定义左侧分类导航，每个分类内的子面板用独立的 SectionTabs 数组描述，新增功能只需扩展配置而非修改渲染逻辑。
- 调度器类组件（任务队列、异常巡检、SSE 重放清扫、漂移检测）均以 startXxx() 函数形式在 server.ts 启动阶段调用，内部使用闭包 ticking 标志防止同一 tick 并发重入。
- API 响应体统一包含 { ok/success: boolean } 与 error/message 字段，客户端通过 apiFetch 封装统一处理成功/失败分支。

## 配置与命令 <!-- category:unique_setup_and_commands -->
生产环境必须设置 JWT_SECRET 否则直接拒绝启动；可通过 PATROL_SCHEDULER_INTERVAL_MS、PATROL_TICK_BATCH 环境变量调节异常巡检调度频率与批量大小；构建流程 `npm run build` 同时产出 Vite 前端与 esbuild 打包的 dist/server.cjs，启动用 `node dist/server.cjs`；开发模式 `tsx server.ts` 自动注入 Vite dev middleware。
