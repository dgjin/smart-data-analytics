---
description: "智能问数据分析系统（Smart Data Analytics Engine）：基于 React + Express + MySQL 的企业级数据源接入、NL2SQL 智能问数、决策报表生成与异常巡检订阅的一体化数据分析平台。"
module_id: "atlas:ad0fe97aa25030ab37b541c094d109b1"
updated_at: "2026-09-12T14:59:53Z"
---

# 智能问数据分析系统（Smart Data Analytics Engine）

## 概述 <!-- category:overview -->
基于 React + Express + MySQL 的企业级数据源接入、NL2SQL 智能问数、决策报表生成与异常巡检订阅的一体化数据分析平台。

## 架构设计 <!-- category:architecture_design -->
单体全栈应用，前后端同仓：前端以 `src/` 为根（React 19 + Vite + Tailwind），通过 `server.ts` 启动的 Express 服务提供 REST API；生产构建由 `vite build` 产出静态资源并由 esbuild 将 `server.ts` 打包为 CJS 单文件 `dist/server.cjs`。

- 服务端分层：`server/routes/*` 按业务域拆分路由（auth/admin/datasources/query/report/patrol/analytics/agent 等），统一挂载于 `server.ts`；核心领域逻辑位于 `server/{query,llm,knowledge,report,analytics,infra}` 等目录，`server/infra` 集中数据库连接池、任务队列、限流、审计日志、健康检查等横切能力。
- 调度与后台任务：内置轻量调度器（如 `anomalyPatrol.startPatrolScheduler`、`taskQueue`、`startSseReplaySweeper`、`startDriftSweeper`），通过内存定时器 + MySQL 原子抢占 (`UPDATE ... WHERE next_run_at <= NOW()`) 实现多实例安全执行，不依赖外部 cron。
- 前端架构：`App.tsx` 作为根路由容器，通过 `activeTab` 切换 QueryChat / ReportGenerator / DataSourceManager / AdminPanel / CustomDashboard / FlexQueryBuilder 等页面；AdminPanel 采用「左侧三域七分类导航 + 右侧独立滚动内容区」的双栏控制台，各分类内再使用 `SectionTabs` 做二级 Tab（规则治理五类资产、质量监控四面板、权限审批双面板、AI 审核双面板）。
- 鉴权与 RBAC：`server/auth/auth.ts` 提供 `authMiddleware` 与 `requireRole('ADMIN'|'ANALYST'|'VIEWER')`，前端 `App.tsx` 在 tab 切换时做角色守卫（VIEWER 不可访问 query/flexquery/datasources/admin）。
- 可观测性：全局中间件注入 requestId、Prometheus 指标直方图、CSP/X-Frame-Options 安全头；`/api/health/live` 与 `/api/health/ready` 区分存活与就绪探测。
- 部署形态：支持 Dockerfile、docker-compose.multi-instance.yml、nginx 多实例配置，`.env.local/.env` 多级加载，生产强制要求 JWT_SECRET 否则 fail-fast 拒绝启动。

## 技术栈 <!-- category:tech_stack -->
React 19 + Vite + TypeScript（前端）；Express 4 + TypeScript（后端）；MySQL（mysql2）持久化；Redis（ioredis）用于多实例状态共享与限流缓存；recharts 图表；Zustand 状态管理；Playwright 端到端测试；Vitest + jsdom 单元测试；esbuild 打包 CJS 产物；Tailwind CSS v4 样式。

## 编码规范 <!-- category:coding_conventions -->
- 路由模块按业务域拆分为独立文件并通过 `app.use('/api/<prefix>', router)` 集中挂载，每个路由文件顶部用注释声明 HTTP 方法与路径契约。
- 所有写操作路由统一调用 `writeAudit` 记录审计日志（userId/username/endpoint/question/status/detail），读操作仅对管理员或创建人开放并配合 `loadOwnedXxx` 越权 404 伪装。
- 错误响应统一使用 `ERROR_CODES.*` 常量 + `{ code, error }` 结构，避免直接暴露堆栈；全局错误中间件兜底返回 JSON。
- 调度器采用「内存定时器 + 数据库原子抢占 UPDATE WHERE next_run_at <= NOW()」模式，并通过闭包 `ticking` 标志防止同一 tick 并发重入，多实例天然防抖。
- 前端 AdminPanel 通过 `SECTION_GROUPS` 配置数组驱动左侧三域七分类导航，子分类再使用 `SectionTabs` + `SectionTabItem` 类型化枚举进行二级 Tab 渲染，新增功能只需追加配置项。
- 环境变量加载遵循 `.env.local` → `.env` → `process.env` 优先级，并在 `server.ts` 中通过 `ENV_SEARCH_DIRS` 兼容开发/打包两种 `__dirname` 场景。

## 配置与命令 <!-- category:unique_setup_and_commands -->
开发：`npm run dev`（tsx 热重载 server.ts）；构建：`npm run build`（vite build + esbundle server.ts → dist/server.cjs）；启动：`node dist/server.cjs`；测试：`npm test`（vitest）、`npm run test:e2e`（playwright）；初始化数据资源库：`npm run init:data-resource`；评估/压测：`npm run eval`、`npm run loadtest`。生产需设置 `JWT_SECRET`，可选 `METRICS_TOKEN` 保护 `/metrics`。
