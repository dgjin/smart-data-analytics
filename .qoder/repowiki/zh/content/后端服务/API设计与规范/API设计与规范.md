# API设计与规范

<cite>
**本文引用的文件**
- [server.ts](file://server.ts)
- [package.json](file://package.json)
- [server/auth/auth.ts](file://server/auth/auth.ts)
- [server/routes/auth.ts](file://server/routes/auth.ts)
- [server/infra/rateLimiter.ts](file://server/infra/rateLimiter.ts)
- [server/infra/errorCodes.ts](file://server/infra/errorCodes.ts)
- [server/infra/requestLogger.ts](file://server/infra/requestLogger.ts)
- [server/infra/monitoring.ts](file://server/infra/monitoring.ts)
- [server/routes/query.ts](file://server/routes/query.ts)
- [server/routes/abTest.ts](file://server/routes/abTest.ts)
- [server/routes/accessRequests.ts](file://server/routes/accessRequests.ts)
- [server/routes/export.ts](file://server/routes/export.ts)
- [server/routes/fallbackApproval.ts](file://server/routes/fallbackApproval.ts)
- [server/routes/opsMetrics.ts](file://server/routes/opsMetrics.ts)
- [server/routes/opsDrift.ts](file://server/routes/opsDrift.ts)
- [server/routes/help.ts](file://server/routes/help.ts)
- [server/routes/queryContext.ts](file://server/routes/queryContext.ts)
- [server/routes/savedReports.ts](file://server/routes/savedReports.ts)
- [docs/openapi.json](file://docs/openapi.json)
- [scripts/checkOpenapi.mjs](file://scripts/checkOpenapi.mjs)
- [scripts/sync-openapi.py](file://scripts/sync-openapi.py)
</cite>

## 更新摘要
**变更内容**
- 路由数量从19个扩展至27个，新增A/B测试分析、权限申请审批流、DLP导出通道、回退样本审核、运维指标看板、知识库漂移检测等核心功能模块
- OpenAPI契约端点从基础接口扩展至112个完整端点，覆盖系统管理、数据源、问数、报告、知识、运维等全业务域
- 新增多个专业领域路由：AB测试分析（/api/admin/ab-test）、权限申请（/api/access-requests）、DLP导出（/api/export）、运维监控（/api/ops）等
- 强化安全与合规能力：引入数据防泄漏机制、访问控制审批流、审计日志追踪
- 完善可观测性体系：北极星指标聚合、知识库漂移检测、在线准确率度量

## 目录
1. [简介](#简介)
2. [项目结构](#项目结构)
3. [核心组件](#核心组件)
4. [架构总览](#架构总览)
5. [详细组件分析](#详细组件分析)
6. [依赖关系分析](#依赖关系分析)
7. [性能考量](#性能考量)
8. [故障排查指南](#故障排查指南)
9. [结论](#结论)
10. [附录](#附录)

## 简介
本文件面向"智能问数据分析系统"的后端API，基于Express.js构建RESTful服务，系统化说明路由组织、中间件机制、错误处理策略；统一API版本与请求响应格式、状态码与错误码体系；认证授权（JWT、RBAC）、请求限流、CORS与安全头；OpenAPI文档生成与同步校验；接口测试策略；并给出最佳实践、性能优化与安全加固建议。

**更新** 本次更新反映系统API成熟度的显著提升，路由数量从19个增长到27个，OpenAPI契约端点从基础接口扩展到112个完整端点，涵盖完整的企业管理级功能。

## 项目结构
后端以单入口 server.ts 启动 Express 应用，集中注册全局中间件与安全头，挂载各业务路由模块；认证与鉴权集中在 server/auth；通用基础设施（日志、监控、限流、错误码）在 server/infra；业务路由按领域拆分至 server/routes；OpenAPI 规范位于 docs/openapi.json，并提供脚本进行同步校验与补齐。

```mermaid
graph TB
A["server.ts<br/>应用启动与中间件"] --> B["认证与鉴权<br/>server/auth/auth.ts"]
A --> C["请求日志<br/>server/infra/requestLogger.ts"]
A --> D["Prometheus监控<br/>server/infra/monitoring.ts"]
A --> E["限流器<br/>server/infra/rateLimiter.ts"]
A --> F["路由集合<br/>server/routes/*"]
F --> F1["认证路由<br/>server/routes/auth.ts"]
F --> F2["问数主链路<br/>server/routes/query.ts"]
F --> F3["A/B测试分析<br/>server/routes/abTest.ts"]
F --> F4["权限申请审批<br/>server/routes/accessRequests.ts"]
F --> F5["DLP导出通道<br/>server/routes/export.ts"]
F --> F6["运维指标看板<br/>server/routes/opsMetrics.ts"]
F --> F7["知识库漂移检测<br/>server/routes/opsDrift.ts"]
F --> F8["其他业务路由..."]
A --> G["OpenAPI规范<br/>docs/openapi.json"]
A --> H["OpenAPI校验脚本<br/>scripts/checkOpenapi.mjs"]
```

**图表来源**
- [server.ts:82-296](file://server.ts#L82-L296)
- [server/auth/auth.ts:66-127](file://server/auth/auth.ts#L66-L127)
- [server/infra/requestLogger.ts:19-35](file://server/infra/requestLogger.ts#L19-L35)
- [server/infra/monitoring.ts:80-88](file://server/infra/monitoring.ts#L80-L88)
- [server/infra/rateLimiter.ts:14-42](file://server/infra/rateLimiter.ts#L14-L42)
- [server/routes/abTest.ts:1-130](file://server/routes/abTest.ts#L1-L130)
- [server/routes/accessRequests.ts:1-141](file://server/routes/accessRequests.ts#L1-L141)
- [server/routes/export.ts:1-226](file://server/routes/export.ts#L1-L226)
- [server/routes/opsMetrics.ts:1-327](file://server/routes/opsMetrics.ts#L1-L327)
- [server/routes/opsDrift.ts:1-80](file://server/routes/opsDrift.ts#L1-L80)

**章节来源**
- [server.ts:82-296](file://server.ts#L82-L296)
- [package.json:1-76](file://package.json#L1-L76)

## 核心组件
- 应用启动与中间件管线：JSON解析大小控制、安全响应头、请求日志、Prometheus指标采集、健康检查与系统信息接口、统一404与全局错误兜底。
- 认证与授权：JWT签发/校验、用户回查、强制改密拦截、角色守卫（ADMIN/ANALYST/VIEWER）。
- 请求限流：按IP滑动窗口或Redis固定分钟窗口，支持多实例共享计数。
- 错误处理：统一错误响应体与错误码体系，便于前端精准分支。
- 可观测性：结构化访问日志、Prometheus指标（HTTP耗时、LLM调用、SQL执行等）。
- OpenAPI：规范文档与同步校验脚本，保障代码与文档一致。

**更新** 新增企业级功能组件：A/B测试分析引擎、权限申请审批工作流、数据防泄漏(DLP)机制、运维指标聚合分析、知识库漂移检测等。

**章节来源**
- [server.ts:133-280](file://server.ts#L133-L280)
- [server/auth/auth.ts:60-127](file://server/auth/auth.ts#L60-L127)
- [server/infra/rateLimiter.ts:14-42](file://server/infra/rateLimiter.ts#L14-L42)
- [server/infra/errorCodes.ts:1-36](file://server/infra/errorCodes.ts#L1-L36)
- [server/infra/requestLogger.ts:19-35](file://server/infra/requestLogger.ts#L19-L35)
- [server/infra/monitoring.ts:80-153](file://server/infra/monitoring.ts#L80-L153)
- [scripts/checkOpenapi.mjs:1-75](file://scripts/checkOpenapi.mjs#L1-L75)

## 架构总览
下图展示一次受保护的问数请求从进入服务器到返回结果的完整流程，包括鉴权、限流、权限校验、SSE流式输出与监控埋点。

```mermaid
sequenceDiagram
participant C as "客户端"
participant S as "Express应用(server.ts)"
participant RL as "限流器(rateLimiter)"
participant AU as "认证中间件(authMiddleware)"
participant RB as "角色守卫(requireRole)"
participant Q as "问数路由(query.ts)"
participant M as "监控(monitoring)"
participant L as "日志(requestLogger)"
C->>S : POST /api/query/natural-language
S->>L : 记录请求ID与耗时
S->>RL : 校验频率限制
RL-->>S : 通过/拒绝(429)
S->>AU : 校验Bearer JWT并回查用户
AU-->>S : 注入req.user/强制改密拦截
S->>RB : 校验角色(ADMIN/ANALYST)
RB-->>S : 通过/拒绝(403)
S->>Q : 执行业务逻辑(SSE/JSON)
Q->>M : 埋点(审计/耗时/缓存/LLM/SQL)
Q-->>C : 返回结果或事件流
```

**图表来源**
- [server.ts:169-183](file://server.ts#L169-L183)
- [server/infra/rateLimiter.ts:14-42](file://server/infra/rateLimiter.ts#L14-L42)
- [server/auth/auth.ts:66-127](file://server/auth/auth.ts#L66-L127)
- [server/routes/query.ts:46-200](file://server/routes/query.ts#L46-L200)
- [server/infra/monitoring.ts:92-133](file://server/infra/monitoring.ts#L92-L133)
- [server/infra/requestLogger.ts:19-35](file://server/infra/requestLogger.ts#L19-L35)

## 详细组件分析

### 认证与授权（JWT + RBAC）
- JWT签发与校验：使用环境变量密钥或进程级临时密钥（开发），令牌包含用户标识、用户名与角色；校验失败返回401。
- 用户回查：每次鉴权回查数据库，确保禁用/角色变更立即生效；首次登录或被重置密码时强制改密，仅放行 /api/auth/*。
- 角色守卫：requireRole 用于细粒度资源访问控制，未命中返回403。

```mermaid
classDiagram
class AuthUser {
+number id
+string username
+string displayName
+UserRole role
+string department
+boolean mustChangePassword
}
class AuthModule {
+signToken(user) string
+authMiddleware(req,res,next) void
+requireRole(...roles) middleware
}
class UserRole {
<<enum>>
ADMIN
ANALYST
VIEWER
}
AuthModule --> AuthUser : "签发/注入"
AuthModule --> UserRole : "校验"
```

**图表来源**
- [server/auth/auth.ts:13-33](file://server/auth/auth.ts#L13-L33)
- [server/auth/auth.ts:60-127](file://server/auth/auth.ts#L60-L127)

**章节来源**
- [server/auth/auth.ts:60-127](file://server/auth/auth.ts#L60-L127)
- [server/routes/auth.ts:41-156](file://server/routes/auth.ts#L41-L156)

### 请求限流（Rate Limiting）
- 内存模式：按IP维护最近60秒的请求时间戳列表，超过阈值返回429。
- Redis模式：固定分钟窗口原子计数，支持多实例共享；存储异常fail-closed直接拒绝。
- 配置项：RATE_LIMIT_MAX 默认30次/分钟；可通过环境变量调整。

```mermaid
flowchart TD
Start(["进入限流器"]) --> Mode{"是否启用Redis?"}
Mode --> |是| Incr["INCR 窗口键<br/>rl:{ip}:{bucket}"]
Incr --> Check{"计数 > 阈值?"}
Check --> |是| Deny["返回429"]
Check --> |否| Next["继续处理"]
Mode --> |否| List["维护内存时间戳列表"]
List --> Count{"窗口内次数 >= 阈值?"}
Count --> |是| Deny
Count --> |否| Next
```

**图表来源**
- [server/infra/rateLimiter.ts:14-42](file://server/infra/rateLimiter.ts#L14-L42)

**章节来源**
- [server/infra/rateLimiter.ts:14-42](file://server/infra/rateLimiter.ts#L14-L42)

### 错误处理与错误码体系
- 全局错误兜底：捕获未处理异常，统一返回JSON，避免HTML错误页。
- 统一错误码：ERROR_CODES 提供标准化错误码（如 INVALID_INPUT、FORBIDDEN、DS_ACCESS_DENIED、RATE_LIMITED、QUERY_IN_FLIGHT、PLAN_INVALID、PLAN_MISMATCH、NOT_FOUND、CONFLICT、SQL_REJECTED、LLM_UNAVAILABLE、INTERNAL_ERROR）。
- 路由层结合业务语义返回对应code与HTTP状态码，便于前端精准分支。

**章节来源**
- [server.ts:267-280](file://server.ts#L267-L280)
- [server/infra/errorCodes.ts:1-36](file://server/infra/errorCodes.ts#L1-L36)
- [server/routes/query.ts:58-109](file://server/routes/query.ts#L58-L109)

### 请求与响应规范
- 内容类型：JSON为主；SSE流式响应使用 text/event-stream。
- 请求体大小：默认2MB；报告导出、知识库导入、文件数据源导入放宽至10MB。
- 响应体：成功返回业务对象；错误返回 { error, code? }。
- 状态码：遵循REST约定（200/201/400/401/403/404/409/429/500等）。

**章节来源**
- [server.ts:133-143](file://server.ts#L133-L143)
- [docs/openapi.json:92-182](file://docs/openapi.json#L92-L182)

### 安全与CORS
- 安全响应头：X-Content-Type-Options、X-Frame-Options、Referrer-Policy；生产环境启用HSTS与严格CSP。
- CORS：当前未显式启用CORS中间件；跨域需由反向代理或网关统一处理。
- 生产安全检查：缺失JWT_SECRET时拒绝启动，防止弱密钥导致伪造token。

**章节来源**
- [server.ts:145-167](file://server.ts#L145-L167)
- [server.ts:91-96](file://server.ts#L91-L96)

### OpenAPI规范与文档同步
- 规范位置：docs/openapi.json，定义所有路径、标签、参数、响应与公共组件。
- 同步校验：scripts/checkOpenapi.mjs 扫描 server.ts 与各路由文件，比对代码端点与文档端点，CI中运行 npm run docs:check。
- 补齐脚本：scripts/sync-openapi.py 一次性补齐缺失的端点与标签，保持文档与实现一致。

```mermaid
flowchart LR
Code["代码路由(server.ts + routes/*)"] --> Parse["解析import与app.use/router.*"]
Doc["docs/openapi.json"] --> Compare["双向比对"]
Parse --> Compare
Compare --> |差异| Report["输出缺失/过期端点并退出非零"]
Compare --> |一致| Pass["校验通过"]
```

**图表来源**
- [scripts/checkOpenapi.mjs:15-75](file://scripts/checkOpenapi.mjs#L15-L75)
- [scripts/sync-openapi.py:1-251](file://scripts/sync-openapi.py#L1-L251)
- [docs/openapi.json:1-84](file://docs/openapi.json#L1-L84)

**章节来源**
- [scripts/checkOpenapi.mjs:1-75](file://scripts/checkOpenapi.mjs#L1-L75)
- [scripts/sync-openapi.py:1-251](file://scripts/sync-openapi.py#L1-L251)
- [docs/openapi.json:1-84](file://docs/openapi.json#L1-L84)

### 问数主链路（SSE与双链路）
- 输入防护：L1输入过滤与注入拒绝、长度截断。
- 权限与ACL：角色白名单 + 数据源访问控制（部门/个人）。
- 并发与限流：用户级并发槽（串行化昂贵LLM调用）+ 用户级频率限制。
- 双链路：真实执行（liveQuery）与模拟执行（simulatedQuery）；计划模式（planId）校验后执行。
- SSE与断线续传：事件入缓冲，客户端断开后可凭traceId重放。

```mermaid
sequenceDiagram
participant U as "用户"
participant R as "路由(query.ts)"
participant P as "权限/ACL"
participant L as "限流/并发"
participant Q as "查询引擎"
U->>R : POST /natural-language
R->>P : 校验角色与数据源ACL
R->>L : 频率/并发检查
alt 真实执行
R->>Q : liveQuery(planId可选)
else 模拟执行
R->>Q : simulatedQuery
end
Q-->>R : 结果/事件流
R-->>U : JSON或SSE事件
```

**图表来源**
- [server/routes/query.ts:46-200](file://server/routes/query.ts#L46-L200)

**章节来源**
- [server/routes/query.ts:46-200](file://server/routes/query.ts#L46-L200)

### A/B测试分析模块
- 实验统计：获取A/B测试统计数据，支持按天数范围查询。
- 历史记录：查询历史实验记录，支持分页限制。
- 快速概览：提供最近24小时的关键指标对比，包括成功率差距和延迟改进。

**章节来源**
- [server/routes/abTest.ts:1-130](file://server/routes/abTest.ts#L1-L130)

### 权限申请审批流
- 申请提交：登录用户可申请特定数据源的访问权限，支持理由说明。
- 审批管理：管理员可查看待审批申请，支持通过/驳回操作。
- 自动授权：审批通过后自动授予用户相应数据源访问权限。

**章节来源**
- [server/routes/accessRequests.ts:1-141](file://server/routes/accessRequests.ts#L1-L141)

### DLP数据防泄漏通道
- CSV导出：统一CSV导出接口，支持水印嵌入和行数限制。
- 审批机制：超过阈值的导出需要管理员审批，支持一次性授权。
- 审计追踪：所有导出操作记录审计日志，支持溯源分析。

**章节来源**
- [server/routes/export.ts:1-226](file://server/routes/export.ts#L1-L226)

### 运维指标看板
- 北极星指标：聚合点赞/点踩/澄清/拒答/自纠错触发/缓存命中率等关键指标。
- 趋势分析：支持日级和周级趋势分析，可筛选特定数据源。
- 实时统计：近N天统计数据，支持动态天数查询。

**章节来源**
- [server/routes/opsMetrics.ts:1-327](file://server/routes/opsMetrics.ts#L1-L327)

### 知识库漂移检测
- 事件监控：检测知识库表结构的变更事件，支持观察列登记。
- 手动扫描：支持对指定或全部数据源进行漂移扫描。
- 事件确认：管理员可确认漂移事件，跟踪处理状态。

**章节来源**
- [server/routes/opsDrift.ts:1-80](file://server/routes/opsDrift.ts#L1-L80)

### 回退样本审核
- 困难样本：识别和处理问数系统中的困难样本，支持优先级排序。
- 批量操作：支持批量批准/拒绝样本，自动注入Few-Shot学习库。
- 人工标注：管理员可为样本标注期望SQL，提升模型准确性。

**章节来源**
- [server/routes/fallbackApproval.ts:1-200](file://server/routes/fallbackApproval.ts#L1-L200)

## 依赖关系分析
- 外部依赖：express、jsonwebtoken、mysql2、prom-client、ioredis等。
- 内部依赖：server.ts 聚合各路由与中间件；auth 模块被多个路由复用；infra 提供通用能力。
- 潜在循环依赖：通过 infra 抽象避免循环；限流器独立于路由模块。

```mermaid
graph LR
ST["server.ts"] --> AR["routes/auth.ts"]
ST --> QR["routes/query.ts"]
ST --> ABT["routes/abTest.ts"]
ST --> ARQ["routes/accessRequests.ts"]
ST --> EXP["routes/export.ts"]
ST --> OPS["routes/opsMetrics.ts"]
ST --> DRIFT["routes/opsDrift.ts"]
ST --> IR["infra/*"]
AR --> AU["auth/auth.ts"]
QR --> AU
ABT --> AU
ARQ --> AU
EXP --> AU
OPS --> AU
DRIFT --> AU
```

**图表来源**
- [server.ts:22-64](file://server.ts#L22-L64)
- [server/routes/abTest.ts:1-10](file://server/routes/abTest.ts#L1-L10)
- [server/routes/accessRequests.ts:1-15](file://server/routes/accessRequests.ts#L1-L15)
- [server/routes/export.ts:1-17](file://server/routes/export.ts#L1-L17)
- [server/routes/opsMetrics.ts:1-11](file://server/routes/opsMetrics.ts#L1-L11)
- [server/routes/opsDrift.ts:1-21](file://server/routes/opsDrift.ts#L1-L21)

**章节来源**
- [server.ts:22-64](file://server.ts#L22-L64)
- [server/routes/auth.ts:1-20](file://server/routes/auth.ts#L1-L20)
- [server/routes/query.ts:17-43](file://server/routes/query.ts#L17-L43)

## 性能考量
- 请求体大小分层控制：默认2MB，特定接口放宽至10MB，避免大报文阻塞。
- Prometheus直方图：HTTP、LLM、SQL执行耗时分桶合理，便于定位瓶颈。
- 缓存与会话：查询缓存（精确/语义）、SSE重放缓冲减少重复计算。
- 并发控制：用户级并发槽串行化昂贵操作，降低抖动。
- 多实例：Redis限流与状态外置，消除冷启动抖动与计数不一致。

**更新** 新增企业级性能优化：A/B测试统计分析采用异步处理、权限申请审批流支持批量操作、DLP导出支持流式处理、运维指标聚合优化查询性能。

## 故障排查指南
- 登录失败/令牌无效：检查JWT_SECRET配置与过期时间；确认用户状态ACTIVE且未被禁用。
- 401/403：确认携带正确Bearer Token；检查角色与数据源ACL；若must_change_password为真，仅允许访问 /api/auth/*。
- 429限流：检查RATE_LIMIT_MAX与客户端重试策略；Redis模式下关注连接稳定性。
- 404/500：查看全局错误兜底日志；确认路由挂载与OpenAPI同步校验通过。
- 监控与日志：通过 /metrics 抓取指标；利用 X-Request-Id 关联请求日志。

**更新** 新增故障排查要点：A/B测试结果异常检查、权限申请审批状态跟踪、DLP导出审批流程监控、运维指标数据完整性验证。

**章节来源**
- [server/auth/auth.ts:66-127](file://server/auth/auth.ts#L66-L127)
- [server/infra/rateLimiter.ts:14-42](file://server/infra/rateLimiter.ts#L14-L42)
- [server.ts:267-280](file://server.ts#L267-L280)
- [server/infra/requestLogger.ts:19-35](file://server/infra/requestLogger.ts#L19-L35)
- [server/infra/monitoring.ts:135-153](file://server/infra/monitoring.ts#L135-L153)

## 结论
本系统采用清晰的Express中间件链路与模块化路由设计，配合JWT+RBAC、统一错误码、限流与可观测性，形成高可用、可运维、可扩展的API体系。通过OpenAPI规范与自动化校验，确保接口契约稳定可靠。

**更新** 经过大幅扩展，系统现已具备完整的企业级API能力，涵盖19个基础路由扩展至27个专业路由，OpenAPI契约端点达到112个，支持A/B测试分析、权限审批、数据防泄漏、运维监控等企业核心需求。建议在后续迭代中持续完善CORS策略、细化限流维度、增强审计与合规能力。

## 附录

### API版本管理
- 当前版本：package.json 中 version 为 0.9.43。
- 版本策略：建议通过URL前缀（/api/v1/...）或请求头（Accept-Version）进行版本控制；当前实现以功能演进为主，OpenAPI描述中保留版本字段以便对外发布。

**章节来源**
- [package.json:1-10](file://package.json#L1-L10)
- [docs/openapi.json:1-7](file://docs/openapi.json#L1-L7)

### 请求响应格式规范
- 成功响应：业务对象或数组；SSE流式事件以 event/data 形式推送。
- 错误响应：{ error: string, code?: ErrorCode }；HTTP状态码与业务错误码配合使用。
- 分页与排序：按业务接口定义；建议在OpenAPI中明确limit/offset或cursor。

**章节来源**
- [server/infra/errorCodes.ts:1-36](file://server/infra/errorCodes.ts#L1-L36)
- [docs/openapi.json:92-182](file://docs/openapi.json#L92-L182)

### 状态码定义
- 200/201：成功
- 400：参数非法或输入被拒
- 401：未登录或令牌无效
- 403：无权限或强制改密
- 404：资源不存在
- 409：冲突（幂等场景可忽略）
- 429：限流
- 500：服务器内部错误

**章节来源**
- [server/routes/query.ts:58-109](file://server/routes/query.ts#L58-L109)
- [server/routes/auth.ts:41-156](file://server/routes/auth.ts#L41-L156)

### 安全加固措施
- 生产环境强制JWT_SECRET；缺失则拒绝启动。
- 安全响应头：禁止嗅探、禁止嵌套、严格CSP。
- 输入净化与注入拒绝；金额单位白名单校验。
- 数据源ACL与部门维度授权；敏感列自动剔除。

**更新** 新增安全能力：DLP数据防泄漏机制、权限申请审批流程、审计日志追踪、知识库漂移检测等企业级安全措施。

**章节来源**
- [server.ts:91-96](file://server.ts#L91-L96)
- [server.ts:145-167](file://server.ts#L145-L167)
- [server/routes/query.ts:70-94](file://server/routes/query.ts#L70-94)

### 接口测试策略
- 单元测试：针对关键函数与工具模块（如queryGuard、sqlExecutor等）编写用例。
- 端到端测试：使用Playwright对关键用户流程进行冒烟测试。
- OpenAPI校验：CI中运行 npm run docs:check 保证文档与代码一致。

**更新** 新增测试覆盖：A/B测试分析、权限审批流程、DLP导出、运维指标等新增功能的测试用例。

**章节来源**
- [package.json:15-24](file://package.json#L15-L24)
- [scripts/checkOpenapi.mjs:1-75](file://scripts/checkOpenapi.mjs#L1-L75)

### 新增路由模块概览
系统现已支持以下专业领域路由模块：

- **A/B测试分析** (`/api/admin/ab-test`)：实验统计、历史记录、快速概览
- **权限申请审批** (`/api/access-requests`)：申请提交、审批管理、自动授权
- **DLP导出通道** (`/api/export`)：CSV导出、水印嵌入、审批机制
- **运维指标看板** (`/api/ops/metrics`)：北极星指标、趋势分析、实时监控
- **知识库漂移检测** (`/api/ops/drift`)：事件监控、手动扫描、事件确认
- **回退样本审核** (`/api/admin/fallback-approval`)：困难样本、批量操作、人工标注
- **帮助文档** (`/api/help`)：使用指南、更新日志、文档管理
- **问数上下文** (`/api/query/context`)：Schema上下文、权限控制、表范围管理
- **保存报表** (`/api/saved-reports`)：报表持久化、协同批注、版本管理

这些新增模块体现了系统从基础问数工具向企业级数据分析平台的演进，提供了完整的权限管理、数据安全、运维监控和企业协作能力。