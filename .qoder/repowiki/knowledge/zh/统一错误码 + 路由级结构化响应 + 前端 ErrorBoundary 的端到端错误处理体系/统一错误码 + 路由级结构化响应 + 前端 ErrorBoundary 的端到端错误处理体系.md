---
kind: error_handling
name: 统一错误码 + 路由级结构化响应 + 前端 ErrorBoundary 的端到端错误处理体系
category: error_handling
scope:
    - '**'
source_files:
    - server/infra/errorCodes.ts
    - server/infra/errorCodes.test.ts
    - server/infra/logger.ts
    - server/routes/query.ts
    - server/routes/auth.ts
    - server/routes/conversation.ts
    - server/routes/dashboardWidgets.ts
    - server/routes/export.ts
    - src/components/ErrorBoundary.tsx
---

## 1. 采用的系统/方法

后端采用「集中式错误码 + 路由层结构化 JSON 响应」模式，前端通过 React `ErrorBoundary` 捕获渲染期崩溃。日志通过统一的 `logger` 封装输出，测试环境静默 warn/info。

- **错误码定义**：`server/infra/errorCodes.ts` 中的 `ERROR_CODES` 常量对象，键名与值一致（如 `INVALID_INPUT: 'INVALID_INPUT'`），命名约定为全大写蛇形（SCREAMING_SNAKE_CASE），按「失败原因」而非 HTTP 状态分类。
- **响应格式**：业务路由在出错时返回 `{ code, error }` 结构的 JSON，HTTP 状态码与业务 code 解耦（例如限流用 429 + `RATE_LIMITED`，权限不足用 403 + `FORBIDDEN`）。
- **前端兜底**：`src/components/ErrorBoundary.tsx` 是全局 React 错误边界，捕获子树渲染异常并展示友好提示与刷新按钮，避免单组件崩溃导致整页白屏。
- **日志**：`server/infra/logger.ts` 提供 `debug/info/warn/error` 四级统一出口，级别由 `LOG_LEVEL` 控制；test 环境下仅保留 error 级，避免单测噪音。

## 2. 关键文件与位置

| 文件 | 作用 |
|---|---|
| `server/infra/errorCodes.ts` | 集中定义全部业务错误码及类型 `ErrorCode` |
| `server/infra/errorCodes.test.ts` | 强制校验：码值为非空 SCREAMING_SNAKE_CASE、全局唯一、覆盖关键失败场景、三个核心路由不得出现裸 `error` 响应 |
| `server/infra/logger.ts` | 统一日志封装，受 `LOG_LEVEL` / `NODE_ENV=test` 控制 |
| `server/routes/query.ts` | 主问数链路，集中使用 `ERROR_CODES.*` 返回结构化错误 |
| `server/routes/auth.ts` | 认证路由（登录/OIDC/改密），部分仍返回裸 `error` 字段（未走 ERROR_CODES） |
| `server/routes/conversation.ts`、`dashboardWidgets.ts`、`export.ts`、`flexQueries.ts` 等 | 各业务路由统一以 `ERROR_CODES.*` 返回结构化错误 |
| `src/components/ErrorBoundary.tsx` | 前端全局渲染错误边界 |
| `src/utils/sseStream.ts`、`src/utils/queryResultNormalizer.ts` 等 | 前端工具层对 API 响应的错误分支处理（基于 `code`） |

## 3. 架构与约定

### 3.1 服务端错误传播路径

1. **输入校验**：参数非法 → 直接 `res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '...' })`，不抛异常。
2. **鉴权/ACL**：角色不足或无数据源访问权限 → `403` + `FORBIDDEN` / `DS_ACCESS_DENIED`。
3. **限流/并发**：用户级滑动窗口限流 → `429` + `RATE_LIMITED`；同用户并发槽占用 → `429` + `QUERY_IN_FLIGHT`。
4. **业务规则**：计划无效/不匹配 → `409` + `PLAN_INVALID` / `PLAN_MISMATCH`；资源不存在 → `404` + `NOT_FOUND`；SQL 被安全层拒绝 → `SQL_REJECTED`。
5. **外部依赖失败**：LLM 超时/配额/网络 → `LLM_UNAVAILABLE`；数据库/Redis 异常 → `INTERNAL_ERROR`。
6. **兜底**：未归类的内部错误统一返回 `INTERNAL_ERROR`。

所有错误响应均附带 `code` 字段，前端可按 code 做精准分支（提示分级 / 静默降级 / 引导操作），而不是解析中文文案。

### 3.2 审计与可观测性

每个错误路径都伴随 `writeAudit(...)` 记录审计日志（含 userId、username、endpoint、dataSourceId、status、detail、durationMs），便于追踪失败原因与耗时。

### 3.3 前端错误处理

- 渲染期崩溃由 `ErrorBoundary` 拦截，显示友好 UI 并提供「刷新页面」按钮。
- 运行时 API 调用错误由前端工具层根据后端返回的 `code` 分支处理（如 `INVALID_INPUT`、`RATE_LIMITED`、`LLM_UNAVAILABLE` 等）。

## 4. 约定与约束

- **错误码命名**：必须为 SCREAMING_SNAKE_CASE，且键名与值相等（由 `errorCodes.test.ts` 断言保证）。
- **全局唯一**：不同失败原因不得使用相同 code（测试中用 `Set(values).size === values.length` 校验）。
- **必填覆盖**：测试显式断言 `INVALID_INPUT`、`FORBIDDEN`、`AI_SWITCHED_OFF`、`RATE_LIMITED`、`QUERY_IN_FLIGHT`、`PLAN_INVALID`、`PLAN_MISMATCH`、`NOT_FOUND`、`SQL_REJECTED`、`LLM_UNAVAILABLE`、`INTERNAL_ERROR` 必须存在。
- **禁止裸 error 响应**：`query.ts`、`report.ts`、`conversation.ts` 三个核心路由中不允许出现 `res.status(...).json({ error:` 这种不带 `code` 的响应（正则扫描 + 断言）。
- **日志级别**：生产默认 `info`，test 环境仅 `error`；`LOG_LEVEL` 环境变量控制，进程启动时读取一次。
- **中间件链**：问数主链路通过 `rateLimiter → authMiddleware → requireRole` 前置过滤，错误在中间件层尽早返回，避免进入业务逻辑。
- **并发槽释放**：请求 close 时释放并发槽，finally 中 token 比对防止误删新请求的槽，确保异常路径也能正确释放资源。

## 5. 不一致之处（待改进）

`server/routes/auth.ts` 中登录、改密、OIDC 回调等接口仍返回裸 `{ error: '...' }` 结构，未使用 `ERROR_CODES`，与核心路由的约定不一致，但未被测试覆盖（测试只检查 query/report/conversation 三个文件）。这是当前体系中尚未完全收敛的部分。