---
kind: logging_system
name: 统一日志与审计系统（logger/requestLogger/auditLog）
category: logging_system
scope:
    - '**'
source_files:
    - server/infra/logger.ts
    - server/infra/requestLogger.ts
    - server/infra/auditLog.ts
    - server/infra/monitoring.ts
    - deploy/prometheus.yml
    - deploy/grafana/dashboards/nl2sql-overview.json
    - deploy/grafana/dashboards/nl2sql-business.json
    - deploy/grafana/dashboards/nl2sql-infra.json
    - deploy/grafana/dashboards/nl2sql-llm.json
---

## 1. 使用的系统与框架

- **运行期日志**：基于 Node.js 内置 `console` 的零依赖封装，位于 `server/infra/logger.ts`。通过 `LOG_LEVEL` 环境变量控制级别（`debug/info/warn/error`，默认 `info`），进程启动时解析一次。
- **请求级日志**：`server/infra/requestLogger.ts` 作为 Express 中间件，为每个 `/api/*` 请求生成 `requestId`（6 字节随机 hex），写入响应头 `X-Request-Id`，并在 `finish` 事件上输出结构化访问日志。
- **审计日志**：`server/infra/auditLog.ts` 提供 `writeAudit(entry)`，将问数全链路状态（成功、缓存命中、降级、错误、拒绝等）持久化到 MySQL 表 `query_audit_log`，并调用 `observeAudit` 做 Prometheus 旁路埋点。
- **监控指标**：`server/infra/monitoring.ts` 使用 `prom-client` 定义业务指标（`nl2sql_requests_total`、`nl2sql_duration_seconds`、`llm_call_duration_seconds`、`sql_execute_duration_seconds`、`http_request_duration_seconds` 等），所有埋点函数均为 fail-open（try/catch 静默）。
- **部署侧采集**：`deploy/prometheus.yml`、`deploy/grafana/dashboards/` 下预置了 `nl2sql-overview.json`、`nl2sql-business.json`、`nl2sql-infra.json`、`nl2sql-llm.json` 看板。

## 2. 关键文件

| 文件 | 职责 |
|---|---|
| `server/infra/logger.ts` | 统一日志出口，替代散落的 `console.*` |
| `server/infra/requestLogger.ts` | 请求级 requestId + HTTP 访问日志 |
| `server/infra/auditLog.ts` | 审计日志落库（MySQL `query_audit_log`） |
| `server/infra/monitoring.ts` | Prometheus 指标定义与 `/metrics` 端点 |
| `deploy/prometheus.yml` | Prometheus 抓取配置 |
| `deploy/grafana/provisioning/` | Grafana 仪表盘与数据源自动注入 |
| `logs/` | 容器标准输出重定向目录（app.log、performance-test.log 等） |

## 3. 架构与设计约定

- **单一入口原则**：服务端运行时代码一律经 `logger` 输出；`eval/` 下的 CLI 脚本刻意保留原生 `console`（命令行输出即用户界面），不走封装。
- **级别策略**：
  - `LOG_LEVEL` 决定阈值，仅 ≥ 阈值的级别被输出。
  - 测试环境（`VITEST` 或 `NODE_ENV=test`）仅保留 `error`，避免单测噪音。
  - `error` 级恒输出。
- **可观测性分层**：
  - 运行时日志 → `logger`（stdout）
  - 请求追踪 → `requestLogger`（`requestId` + `X-Request-Id`）
  - 审计落账 → `auditLog.writeAudit`（MySQL 持久化）
  - 指标埋点 → `monitoring.observe*`（Prometheus，fail-open）
- **低基数标签约束**：`monitoring.ts` 明确禁止将 `question` / `userId` / `dataSourceId` 放入 label，仅使用低基数枚举（`status`、`endpoint`、`channel`、`model` 等），防止指标爆炸。
- **非阻塞审计**：`writeAudit` 写入失败仅 `logger.warn` 不抛错，保证审计不影响主流程可用性。
- **安全裁剪**：审计字段在入库前截断（`dataSourceId` ≤ 64、`question` ≤ 500、`detail` ≤ 255、`executedSql` ≤ 2000），防止恶意输入撑爆存储。

## 4. 约定与约束

- **日志级别由环境变量驱动**：`LOG_LEVEL` 仅在进程启动时读取一次，修改需重启生效（见 `logger.ts` 注释及模块级 `resolveThreshold()`）。
- **测试环境静默**：`isTest` 判断下 `warn`/`info`/`debug` 全部丢弃，仅 `error` 可见（`logger.ts` 第 18–23 行）。
- **审计状态枚举受控**：`AuditStatus` 限定为 `SUCCESS | CACHE | FALLBACK | ERROR | CLARIFY | REFUSED | QUEUED | DENIED_INPUT | DENIED_AUTH | DENIED_RATE | DENIED_SWITCH`，新增状态需显式扩展类型。
- **审计端点枚举受控**：`endpoint` 限定为 `query | report | query_report | saved_report | report_template | export | dashboard_widget | flex_query`。
- **监控埋点必须 fail-open**：`monitoring.ts` 中所有 `observe*` 函数均包裹 try/catch，异常不得影响业务路径。
- **HTTP 日志仅覆盖 `/api/*`**：`requestLogger` 跳过静态资源，避免 Vite 开发服务器噪音。
- **指标端点保护**：`/metrics` 可通过 `METRICS_TOKEN` 启用 Bearer 认证（见 `monitoring.ts` 第 137–145 行）。
- **审计写入失败不阻塞**：`auditLog.ts` 中 `.catch` 仅记录警告，确保审计不可用不会中断业务（第 58–60 行）。

## 5. 使用范围

该日志体系覆盖服务端所有核心模块：认证（`auth/`）、LLM 客户端（`llm/`）、查询编排（`query/`）、报表（`report/`）、路由（`routes/`）、知识检索（`knowledge/`）、任务队列（`taskQueue.ts`）、数据库连接（`db.ts`）等，均通过 `import { logger } from '../infra/logger'` 接入统一日志出口。