# API参考

<cite>
**本文引用的文件**
- [server.ts](file://server.ts)
- [openapi.json](file://docs/openapi.json)
- [auth.ts](file://server/auth/auth.ts)
- [client.ts](file://src/api/client.ts)
- [routes/auth.ts](file://server/routes/auth.ts)
- [routes/query.ts](file://server/routes/query.ts)
- [routes/report.ts](file://server/routes/report.ts)
- [routes/conversation.ts](file://server/routes/conversation.ts)
- [routes/admin.ts](file://server/routes/admin.ts)
- [routes/datasources.ts](file://server/routes/datasources.ts)
- [routes/knowledge.ts](file://server/routes/knowledge.ts)
- [routes/skills.ts](file://server/routes/skills.ts)
- [routes/agent.ts](file://server/routes/agent.ts)
- [orchestrator.ts](file://server/agent/orchestrator.ts)
- [analytics.ts](file://src/types/analytics.ts)
- [errorCodes.ts](file://server/infra/errorCodes.ts)
</cite>

## 更新摘要
**变更内容**
- 新增Agent编排API章节，涵盖P1-7多能力编排功能
- 增强规划策略说明，包含query/forecast/attribution三种能力
- 完善参数可视化响应格式文档
- 更新数据模型定义以支持Agent编排数据结构

## 目录
1. [简介](#简介)
2. [项目结构](#项目结构)
3. [核心组件](#核心组件)
4. [架构总览](#架构总览)
5. [详细组件分析](#详细组件分析)
6. [依赖关系分析](#依赖关系分析)
7. [性能与可用性](#性能与可用性)
8. [故障排查指南](#故障排查指南)
9. [结论](#结论)
10. [附录：API清单与示例](#附录api清单与示例)

## 简介
本参考文档面向"智能问数据分析系统"的后端 RESTful API，覆盖认证授权、数据源管理、自然语言问数、对话历史、报告生成与导出、知识库、技能库、Agent编排、运维指标等能力。文档基于 OpenAPI 规范与服务端路由实现，提供接口路径、HTTP方法、请求参数、响应格式、错误码、鉴权要求与调用时序说明，并给出前端 SDK 集成要点与测试建议。

**更新** 新增Agent编排功能，支持多能力协作的规划执行模式，包括查询、时序预测和多维归因能力的自动编排。

## 项目结构
后端采用 Express 应用，按功能拆分路由模块；全局中间件负责安全头、日志、限流、鉴权与统一错误处理。OpenAPI 定义位于 docs/openapi.json，作为前后端契约与版本依据。

```mermaid
graph TB
A["Express 应用(server.ts)"] --> B["鉴权中间件(auth.ts)"]
A --> C["路由分组(routes/*)"]
C --> C1["认证: /api/auth/*"]
C --> C2["管理员: /api/admin/*"]
C --> C3["数据源: /api/datasources/*"]
C --> C4["问数: /api/query/*"]
C --> C5["对话: /api/conversations/*"]
C --> C6["报告: /api/report/*"]
C --> C7["知识库: /api/knowledge/*"]
C --> C8["技能: /api/skills/*"]
C --> C9["Agent编排: /api/agent/*"]
A --> D["基础设施: 日志/限流/监控/任务队列"]
```

**图表来源**
- [server.ts:82-265](file://server.ts#L82-L265)
- [server.ts:310-311](file://server.ts#L310-L311)
- [routes/auth.ts:39-156](file://server/routes/auth.ts#L39-L156)
- [routes/query.ts:44-47](file://server/routes/query.ts#L44-L47)

## 核心组件
- 认证与授权
  - JWT 签发与校验、角色守卫（ADMIN/ANALYST/VIEWER）、强制改密流程、OIDC 登录重定向与回调。
- 路由层
  - 按业务域拆分的 Express Router，统一挂载到 /api 前缀下。
- Agent编排引擎
  - Planner：基于LLM的智能规划器，根据Schema和用户问题生成多能力执行计划
  - Executor：顺序执行器，支持query/forecast/attribution三种能力步骤
  - 计划存储：内存Map+Redis支持，10分钟TTL，一次性消费防重放
- 基础设施
  - 请求日志、Prometheus 指标、限流器、审计日志、任务队列、SSE 断线续传缓冲。
- 前端 SDK
  - 统一 fetch 封装，自动注入 Authorization，处理 401/403 强制改密分支。

**章节来源**
- [auth.ts:1-127](file://server/auth/auth.ts#L1-L127)
- [routes/auth.ts:1-156](file://server/routes/auth.ts#L1-L156)
- [orchestrator.ts:1-500](file://server/agent/orchestrator.ts#L1-L500)
- [client.ts:1-74](file://src/api/client.ts#L1-L74)
- [server.ts:133-183](file://server.ts#L133-L183)

## 架构总览
整体请求链路：客户端 → Express → 中间件（日志/限流/安全头）→ 鉴权中间件 → 路由处理器 → 服务层（LLM/SQL/缓存/审计）→ 响应。

```mermaid
sequenceDiagram
participant C as "客户端"
participant E as "Express(server.ts)"
participant M as "鉴权中间件(auth.ts)"
participant R as "路由处理器(routes/*)"
participant A as "Agent编排(orchestrator.ts)"
participant S as "服务层(查询/报告/知识...)"
C->>E : HTTP 请求
E->>E : 日志/限流/安全头
E->>M : 校验JWT/角色
M-->>E : req.user 或 401/403
E->>R : 匹配路由
alt Agent编排请求
R->>A : generateAgentPlan/runAgentPlan
A->>S : 执行query/forecast/attribution步骤
S-->>A : 各步骤执行结果
A-->>R : 编排执行结果
else 其他业务请求
R->>S : 执行业务逻辑
S-->>R : 结果/错误
end
R-->>C : JSON/SSE/文件
```

**图表来源**
- [server.ts:133-183](file://server.ts#L133-L183)
- [auth.ts:66-113](file://server/auth/auth.ts#L66-L113)
- [routes/query.ts:47-164](file://server/routes/query.ts#L47-L164)
- [orchestrator.ts:317-352](file://server/agent/orchestrator.ts#L317-L352)

## 详细组件分析

### 认证与授权（Auth）
- 登录获取 JWT
  - POST /api/auth/login（公开），限流保护，失败锁定策略由限流器控制。
  - 成功返回 token 与用户信息；首次登录或被重置密码时标记 mustChangePassword。
- 当前用户
  - GET /api/auth/me（需登录），返回当前用户详情。
- 修改密码
  - POST /api/auth/change-password（需登录），强度校验，旧密码验证。
- OIDC 企业登录
  - GET /api/auth/oidc/status（公开）
  - GET /api/auth/oidc/login（公开，302 跳转 IdP）
  - GET /api/auth/oidc/callback（公开，完成授权码流程后重定向携带本地 JWT）

```mermaid
sequenceDiagram
participant U as "用户"
participant A as "/api/auth/login"
participant DB as "数据库"
participant J as "JWT签发"
U->>A : {username,password}
A->>DB : 校验用户/状态
DB-->>A : 用户信息
A->>J : 签发token
J-->>A : token
A-->>U : {success,token,user}
```

**图表来源**
- [routes/auth.ts:41-77](file://server/routes/auth.ts#L41-L77)
- [auth.ts:60-64](file://server/auth/auth.ts#L60-L64)

**章节来源**
- [routes/auth.ts:1-156](file://server/routes/auth.ts#L1-L156)
- [auth.ts:1-127](file://server/auth/auth.ts#L1-L127)
- [openapi.json:383-486](file://docs/openapi.json#L383-L486)

### 管理员与RBAC（Admin）
- 用户管理（仅 ADMIN）
  - GET /api/admin/users
  - POST /api/admin/users
  - PUT /api/admin/users/:id
  - DELETE /api/admin/users/:id
  - POST /api/admin/users/:id/reset-password
- 角色与权限
  - 通过 requireRole('ADMIN'|'ANALYST'|'VIEWER') 在路由级进行访问控制。
  - 部分接口在服务层再次校验（如问数/报告）。

**章节来源**
- [routes/admin.ts:1-200](file://server/routes/admin.ts#L1-L200)
- [auth.ts:115-127](file://server/auth/auth.ts#L115-L127)
- [openapi.json:487-668](file://docs/openapi.json#L487-L668)

### 数据源管理（DataSources）
- 列表与创建（ADMIN 写操作）
  - GET /api/datasources
  - POST /api/datasources
- 导入文件型数据源
  - POST /api/datasources/import-file（ADMIN，支持 csv/xlsx/json，base64 上传）
- 连通性测试
  - POST /api/datasources/test-connection（ADMIN，不落库）
- 元数据映射
  - 自动推导列类型与角色（数值→指标，日期/枚举/布尔→维度，短文本→维度等）

**章节来源**
- [routes/datasources.ts:1-200](file://server/routes/datasources.ts#L1-L200)
- [openapi.json:669-800](file://docs/openapi.json#L669-L800)

### 自然语言问数（Query）
- 主链路
  - POST /api/query/natural-language（需 ADMIN/ANALYST）
  - 输入：query、history、schema、dataSourceId、model、amountUnit、stream、planId
  - 输出：JSON 或 SSE 事件流（含 traceId）
  - 防护：输入清洗、注入检测、金额单位白名单、频率限制、并发槽互斥、ACL 检查、计划模式校验
- 辅助端点
  - GET /api/query/stream-replay/:traceId（SSE 断线续传）
  - GET /api/query/trace/:traceId（推导过程回放）
  - POST /api/query/plan（先出计划再执行）
  - POST /api/query/feedback（反馈沉淀）
  - POST /api/query/execute-sql（SELECT-only 安全执行）
  - POST /api/query/sql-assist（AI 助手）
  - POST /api/query/drill（图表下钻）

```mermaid
flowchart TD
Start(["进入 /natural-language"]) --> Auth["鉴权+角色校验"]
Auth --> ACL{"是否指定数据源?"}
ACL -- 是 --> CheckACL["检查数据源访问权限"]
ACL -- 否 --> Next1["继续"]
CheckACL --> Next1
Next1 --> Guard["输入清洗/注入检测/单位白名单"]
Guard --> Rate["限流+并发槽"]
Rate --> Context["加载Schema上下文(落库schema/敏感过滤)"]
Context --> Live{"是否可真实执行?"}
Live -- 是 --> Plan{"是否携带已批准planId?"}
Plan -- 是 --> ConsumePlan["消费计划并校验"]
Plan -- 否 --> Exec["执行SQL/LLM分析"]
ConsumePlan --> Exec
Live -- 否 --> Sim["模拟模式生成"]
Exec --> Stream{"是否流式?"}
Sim --> Stream
Stream -- 是 --> SSE["SSE推送事件(traceId)"]
Stream -- 否 --> JSON["返回JSON"]
SSE --> End(["结束"])
JSON --> End
```

**图表来源**
- [routes/query.ts:47-200](file://server/routes/query.ts#L47-L200)
- [server.ts:187-221](file://server.ts#L187-L221)

**章节来源**
- [routes/query.ts:1-200](file://server/routes/query.ts#L1-L200)
- [openapi.json:183-382](file://docs/openapi.json#L183-L382)

### Agent编排（Agent Orchestration）
**新增** P1-7 Agent编排功能，支持多能力协作的智能分析与执行。

#### 规划阶段（Planning）
- 生成编排计划
  - POST /api/agent/plan（需 ADMIN/ANALYST）
  - 输入：question（分析问题，≤500字）、dataSourceId
  - 输出：AgentPlan（包含understanding理解、steps步骤序列）
  - 特性：只规划不执行，计划10分钟有效、一次性消费

#### 执行阶段（Execution）
- 执行编排计划
  - POST /api/agent/run（需 ADMIN/ANALYST）
  - 输入：planId（计划ID）、dataSourceId
  - 输出：AgentRunOutcome（包含steps执行结果、finalSummary总结）
  - 特性：顺序执行，单步失败不中断，整体ok取决于全步成功

#### 支持的能力类型
- **query**：数据查询能力，生成并执行SQL查询
- **forecast**：时序预测能力，对上游数据进行趋势预测
- **attribution**：多维归因能力，对上游数据进行贡献度拆解

#### 编排策略
- 智能识别分析诉求：
  - 含"预测/未来/下期/接下来" → 必须编排forecast步
  - 含"为什么/为何/原因/归因/贡献" → 必须编排attribution步
  - 同时涉及预测与归因 → 编排query + forecast + attribution三步
- query步为后续统计步准备数据：
  - forecast步：按时间/期聚合指标（输出时间列 + 指标列）
  - attribution步：按"维度 × 时期"聚合指标（输出维度列 + 时期列 + 指标列）

```mermaid
sequenceDiagram
participant C as "客户端"
participant A as "Agent编排"
participant L as "LLM规划器"
participant Q as "查询执行器"
participant F as "预测执行器"
participant T as "归因执行器"
C->>A : POST /api/agent/plan
A->>L : 生成编排计划
L-->>A : AgentPlan (understanding + steps)
A-->>C : {ok : true, plan}
C->>A : POST /api/agent/run
A->>Q : 执行query步骤
Q-->>A : 查询结果
A->>F : 执行forecast步骤如有
F-->>A : 预测结果
A->>T : 执行attribution步骤如有
T-->>A : 归因结果
A-->>C : {ok, steps[], finalSummary}
```

**图表来源**
- [routes/agent.ts:19-61](file://server/routes/agent.ts#L19-L61)
- [routes/agent.ts:63-114](file://server/routes/agent.ts#L63-L114)
- [orchestrator.ts:230-267](file://server/agent/orchestrator.ts#L230-L267)
- [orchestrator.ts:317-352](file://server/agent/orchestrator.ts#L317-L352)

**章节来源**
- [routes/agent.ts:1-117](file://server/routes/agent.ts#L1-L117)
- [orchestrator.ts:1-500](file://server/agent/orchestrator.ts#L1-L500)
- [openapi.json:4811-4914](file://docs/openapi.json#L4811-L4914)

### 对话历史（Conversations）
- 检索本人对话
  - GET /api/conversations?dataSourceId=&q=（需 ADMIN/ANALYST）
- 删除单条对话
  - DELETE /api/conversations/:id（需 ADMIN/ANALYST）

**章节来源**
- [routes/conversation.ts:1-44](file://server/routes/conversation.ts#L1-L44)
- [openapi.json:427-443](file://docs/openapi.json#L427-L443)

### 报告生成与导出（Reports）
- 生成报告
  - POST /api/report/generate（需 ADMIN/ANALYST）
  - 支持模板类型、自定义提示、金额单位、计划模式（reportPlanId）
  - 真实执行或模拟模式，返回 dataProvenance 标识数据来源
- 报告计划
  - POST /api/report/plan（需 ADMIN/ANALYST）
- 导出 PPTX
  - POST /api/report/export（body 含 base64 图表，服务端放宽解析大小）

**章节来源**
- [routes/report.ts:1-200](file://server/routes/report.ts#L1-L200)
- [openapi.json:153-229](file://docs/openapi.json#L153-L229)

### 知识库（Knowledge）
- 文档 CRUD（读对所有登录开放，写需 ADMIN）
  - GET /api/knowledge?dataSourceId=
  - POST /api/knowledge（登记文档，切块入库）
  - GET /api/knowledge/:docId
  - PUT /api/knowledge/:docId
  - DELETE /api/knowledge/:docId
- 导入/导出
  - GET /api/knowledge/export?dataSourceId=（ADMIN）
  - POST /api/knowledge/import（ADMIN，JSON 备份恢复，支持 dryRun）
- 种子条目
  - GET /api/knowledge/seed-entries

**章节来源**
- [routes/knowledge.ts:1-200](file://server/routes/knowledge.ts#L1-L200)
- [openapi.json:230-382](file://docs/openapi.json#L230-L382)

### 技能库（Skills）
- 可见技能与管理视图
  - GET /api/skills
  - GET /api/skills/manage
- 个人技能维护
  - POST /api/skills
  - PUT /api/skills/:id
  - DELETE /api/skills/:id
- 分享审批流
  - POST /api/skills/:id/share
  - POST /api/skills/:id/share/cancel
  - POST /api/skills/:id/share/approve（ADMIN）
  - POST /api/skills/:id/share/reject（ADMIN）
- 详情
  - GET /api/skills/:id

**章节来源**
- [routes/skills.ts:1-145](file://server/routes/skills.ts#L1-L145)

### 系统与运维
- 健康检查
  - GET /api/health（公开）
- 引擎与模型
  - GET /api/system/engine（需登录）
  - GET /api/system/models（需登录）
- LLM 用量统计（仅 ADMIN）
  - GET /api/system/llm-usage?days=
- 在线准确率度量看板（仅 ADMIN）
  - GET /api/ops/metrics?days=
- 知识库漂移检测（仅 ADMIN）
  - GET /api/ops/drift
  - POST /api/ops/drift/scan
  - POST /api/ops/drift/watch
  - DELETE /api/ops/drift/watch
  - POST /api/ops/drift/{id}/ack

**章节来源**
- [server.ts:187-221](file://server.ts#L187-L221)
- [openapi.json:92-229](file://docs/openapi.json#L92-L229)

## 依赖关系分析
- 路由对中间件的依赖
  - 所有写操作与业务接口普遍使用 rateLimiter + authMiddleware + requireRole 组合。
- 服务层依赖
  - 问数/报告依赖 schemaContext、sqlExecutor、liveQuery/simulatedQuery、queryCache、auditLog、taskQueue。
  - Agent编排依赖 LLM客户端、查询执行器、预测算法、归因算法、追踪记录。
- 外部依赖
  - LLM 多后端（Ollama/Gemini）、数据库连接池、Redis（可选，用于限流/缓存/任务队列）。

```mermaid
graph LR
Q["/api/query/*"] --> AC["authMiddleware"]
Q --> RL["rateLimiter"]
Q --> SC["schemaContext"]
Q --> SQ["sqlExecutor"]
Q --> LQ["liveQuery/simulatedQuery"]
Q --> AU["auditLog"]
Q --> TQ["taskQueue"]
AG["/api/agent/*"] --> AC
AG --> RL
AG --> OC["orchestrator"]
OC --> LL["LLM客户端"]
OC --> FA["forecastSeries"]
OC --> AT["attributeDelta"]
OC --> QT["queryTrace"]
```

**图表来源**
- [routes/query.ts:17-42](file://server/routes/query.ts#L17-L42)
- [server.ts:22-64](file://server.ts#L22-L64)
- [orchestrator.ts:7-16](file://server/agent/orchestrator.ts#L7-L16)

**章节来源**
- [routes/query.ts:1-200](file://server/routes/query.ts#L1-L200)
- [server.ts:22-64](file://server.ts#L22-L64)

## 性能与可用性
- 限流与并发
  - 登录接口限流；问数/报告共享用户级频率限制与并发槽互斥（同用户串行）。
  - Agent编排计划存储支持内存Map和Redis两种模式，Redis模式下自动TTL过期。
- 流式与断线续传
  - 问数支持 SSE 流式输出与基于 traceId 的重放缓冲，网络中断后可续传。
  - Agent编排每步执行都记录追踪信息，支持逐步回放查看。
- 资源限制
  - JSON body 默认 2MB；报告导出/知识库导入/文件数据源导入放宽至 10MB 或 20MB。
  - Agent编排最大支持4步计划，查询结果截断返回最多50行。
- 可观测性
  - Prometheus 指标（/metrics）记录 /api/* 耗时直方图；请求日志包含 requestId。
  - Agent编排每步执行都有详细的追踪记录，包含SQL、行数、耗时等信息。

**章节来源**
- [server.ts:133-183](file://server.ts#L133-L183)
- [routes/query.ts:118-153](file://server/routes/query.ts#L118-L153)
- [orchestrator.ts:51-79](file://server/agent/orchestrator.ts#L51-L79)
- [orchestrator.ts:314-352](file://server/agent/orchestrator.ts#L314-L352)

## 故障排查指南
- 常见错误码
  - INVALID_INPUT：参数非法或输入被拒绝
  - FORBIDDEN：角色或权限不足
  - DS_ACCESS_DENIED：无数据源访问权限
  - AI_SWITCHED_OFF：数据源停用问数功能
  - RATE_LIMITED：触发限流
  - QUERY_IN_FLIGHT：存在进行中的查询
  - PLAN_INVALID/PLAN_MISMATCH：计划无效或不匹配
  - SQL_REJECTED：SQL 未通过安全校验
  - LLM_UNAVAILABLE：LLM 服务不可用
  - INTERNAL_ERROR：内部错误
- Agent编排特定错误
  - 计划不存在或已过期：10分钟有效期的编排计划
  - 无权执行他人计划：用户身份验证失败
  - 数据源不匹配：计划与当前数据源不一致
  - 上游数据缺失：query步骤未取得数据导致后续步骤无法执行
- 定位步骤
  - 查看请求日志与 Prometheus 指标，确认路由与耗时
  - 检查鉴权与角色（401/403）
  - 核对限流与并发槽（429）
  - 关注计划模式（409）
  - 检查 LLM 与数据库连接状态
  - 查看Agent编排追踪记录，定位具体失败的步骤

**章节来源**
- [errorCodes.ts:1-36](file://server/infra/errorCodes.ts#L1-L36)
- [server.ts:267-280](file://server.ts#L267-L280)
- [orchestrator.ts:92-119](file://server/agent/orchestrator.ts#L92-L119)

## 结论
本系统以模块化路由与强中间件链构建高内聚、低耦合的 API 体系，围绕"自然语言问数"与"报告生成"两大主线，新增"Agent编排"多能力协作能力，提供完善的鉴权、限流、审计、可观测性与容错机制。通过 OpenAPI 契约与前端 SDK 解耦，便于版本演进与跨端集成。

**更新** 新增的Agent编排功能显著提升了系统的智能化水平，能够自动规划和执行复杂的多步骤分析任务，为用户提供更强大的数据分析能力。

## 附录：API清单与示例

### 认证与用户
- 登录
  - POST /api/auth/login
  - 请求体：{ username, password }
  - 响应：{ success, token, user }
  - 错误：400/401/429
- 当前用户
  - GET /api/auth/me
  - 响应：{ success, user }
- 修改密码
  - POST /api/auth/change-password
  - 请求体：{ oldPassword, newPassword }
  - 响应：{ success }
- OIDC
  - GET /api/auth/oidc/status
  - GET /api/auth/oidc/login
  - GET /api/auth/oidc/callback

**章节来源**
- [routes/auth.ts:41-156](file://server/routes/auth.ts#L41-L156)
- [openapi.json:383-486](file://docs/openapi.json#L383-L486)

### 管理员
- 用户管理
  - GET /api/admin/users
  - POST /api/admin/users
  - PUT /api/admin/users/:id
  - DELETE /api/admin/users/:id
  - POST /api/admin/users/:id/reset-password

**章节来源**
- [routes/admin.ts:26-200](file://server/routes/admin.ts#L26-L200)
- [openapi.json:487-668](file://docs/openapi.json#L487-L668)

### 数据源
- 列表/创建/导入/测试
  - GET /api/datasources
  - POST /api/datasources
  - POST /api/datasources/import-file
  - POST /api/datasources/test-connection

**章节来源**
- [routes/datasources.ts:1-200](file://server/routes/datasources.ts#L1-L200)
- [openapi.json:669-800](file://docs/openapi.json#L669-L800)

### 问数
- 主链路
  - POST /api/query/natural-language
  - 请求体关键字段：query、history、schema、dataSourceId、model、amountUnit、stream、planId
  - 响应：JSON 或 SSE（text/event-stream）
- 辅助
  - GET /api/query/stream-replay/:traceId
  - GET /api/query/trace/:traceId
  - POST /api/query/plan
  - POST /api/query/feedback
  - POST /api/query/execute-sql
  - POST /api/query/sql-assist
  - POST /api/query/drill

**章节来源**
- [routes/query.ts:47-200](file://server/routes/query.ts#L47-L200)
- [openapi.json:183-382](file://docs/openapi.json#L183-L382)

### Agent编排
**新增** 多能力编排API，支持智能规划与顺序执行。

#### 规划API
- 生成编排计划
  - POST /api/agent/plan
  - 请求体：{ question, dataSourceId }
  - 响应：{ ok: true, plan: AgentPlan }
  - AgentPlan结构：
    - planId: string - 计划唯一标识
    - question: string - 原始问题
    - understanding: string - 理解分析思路
    - steps: AgentPlanStep[] - 执行步骤数组

#### 执行API
- 执行编排计划
  - POST /api/agent/run
  - 请求体：{ planId, dataSourceId }
  - 响应：{ ok: boolean, traceId: string, steps: AgentRunStepData[], finalSummary: string }

#### 步骤类型与参数
- **query步骤**：数据查询
  - 无特殊参数，goal描述查询目标
- **forecast步骤**：时序预测
  - params: { xKey?: string, yKey?: string, periods?: number, model?: string }
  - xKey: 时间/期列名
  - yKey: 数值指标列名
  - periods: 预测期数（1-24，默认3）
  - model: 预测模型（ma/lr/seasonal/auto）
- **attribution步骤**：多维归因
  - params: { dimKey?: string, periodKey?: string, metricKey?: string }
  - dimKey: 维度列名
  - periodKey: 时期列名
  - metricKey: 指标列名

#### 执行结果结构
- AgentRunStepData：
  - id: number - 步骤序号
  - capability: string - 能力类型
  - goal: string - 步骤目标
  - ok: boolean - 执行成功标志
  - summary: string - 中文执行摘要
  - sql?: string - query步骤的SQL
  - columns?: string[] - 数据列名
  - rows?: Record<string, any>[] - 数据行（最多50行）
  - rowCount?: number - 数据行数
  - forecast?: ForecastResult - 预测结果
  - attribution?: AttributionResult - 归因结果
  - error?: string - 错误信息

**章节来源**
- [routes/agent.ts:19-114](file://server/routes/agent.ts#L19-L114)
- [orchestrator.ts:18-49](file://server/agent/orchestrator.ts#L18-L49)
- [orchestrator.ts:286-312](file://server/agent/orchestrator.ts#L286-L312)
- [openapi.json:4811-4914](file://docs/openapi.json#L4811-L4914)

### 对话历史
- 检索/删除
  - GET /api/conversations?dataSourceId=&q=
  - DELETE /api/conversations/:id

**章节来源**
- [routes/conversation.ts:15-41](file://server/routes/conversation.ts#L15-L41)

### 报告
- 生成/计划/导出
  - POST /api/report/generate
  - POST /api/report/plan
  - POST /api/report/export

**章节来源**
- [routes/report.ts:31-200](file://server/routes/report.ts#L31-L200)

### 知识库
- 文档CRUD/导入导出/种子
  - GET /api/knowledge?dataSourceId=
  - POST /api/knowledge
  - GET /api/knowledge/:docId
  - PUT /api/knowledge/:docId
  - DELETE /api/knowledge/:docId
  - GET /api/knowledge/export?dataSourceId=
  - POST /api/knowledge/import
  - GET /api/knowledge/seed-entries

**章节来源**
- [routes/knowledge.ts:58-200](file://server/routes/knowledge.ts#L58-L200)

### 技能库
- 列表/管理/维护/分享审批
  - GET /api/skills
  - GET /api/skills/manage
  - POST /api/skills
  - PUT /api/skills/:id
  - DELETE /api/skills/:id
  - POST /api/skills/:id/share
  - POST /api/skills/:id/share/cancel
  - POST /api/skills/:id/share/approve
  - POST /api/skills/:id/share/reject
  - GET /api/skills/:id

**章节来源**
- [routes/skills.ts:51-145](file://server/routes/skills.ts#L51-L145)

### 系统与运维
- 健康/引擎/模型/用量
  - GET /api/health
  - GET /api/system/engine
  - GET /api/system/models
  - GET /api/system/llm-usage?days=
- 在线指标/漂移
  - GET /api/ops/metrics?days=
  - GET /api/ops/drift
  - POST /api/ops/drift/scan
  - POST /api/ops/drift/watch
  - DELETE /api/ops/drift/watch
  - POST /api/ops/drift/{id}/ack

**章节来源**
- [server.ts:187-221](file://server.ts#L187-L221)
- [openapi.json:92-229](file://docs/openapi.json#L92-L229)

### 认证与授权机制
- JWT 令牌获取
  - 通过 /api/auth/login 或 OIDC 回调获得 Bearer Token。
- 权限验证
  - 鉴权中间件校验 Token 并回查用户状态，附加 req.user。
  - 路由级 requireRole 控制角色访问。
- 访问控制
  - 数据源访问控制（ACL）在服务层二次校验，非 ADMIN 需命中部门/个人授权清单。
- 强制改密
  - must_change_password 为真时，除 /api/auth/* 外均返回 403 并附带 code。

**章节来源**
- [auth.ts:66-113](file://server/auth/auth.ts#L66-L113)
- [routes/auth.ts:41-77](file://server/routes/auth.ts#L41-L77)
- [routes/query.ts:58-68](file://server/routes/query.ts#L58-L68)

### 数据模型与约束（摘要）
- 用户
  - 字段：id、username、display_name、department、role、status、must_change_password、created_at、last_login_at
  - 约束：用户名唯一；至少保留一个 ACTIVE 管理员；密码强度校验
- 数据源
  - 字段：id、name、type、status、config_json、schema_json、scope_json、acl_json、quick_questions_json、allow_introspection、updated_at
  - 约束：类型白名单；凭据加密存储；ACL 仅 ADMIN 下发
- 知识文档
  - 字段：doc_id、title、chunk_text、created_by、created_at
  - 约束：切块重叠拼接还原原文；导入支持 dryRun 预检
- **Agent编排数据模型**
  - AgentPlan：包含planId、question、understanding、steps
  - AgentPlanStep：包含capability、goal、params
  - AgentRunStepData：包含执行结果、SQL、数据、预测结果、归因结果
  - 约束：计划10分钟有效期、一次性消费、用户和数据源绑定

**章节来源**
- [routes/admin.ts:26-76](file://server/routes/admin.ts#L26-L76)
- [routes/datasources.ts:30-90](file://server/routes/datasources.ts#L30-L90)
- [routes/knowledge.ts:60-107](file://server/routes/knowledge.ts#L60-L107)
- [orchestrator.ts:18-49](file://server/agent/orchestrator.ts#L18-L49)
- [analytics.ts:199-241](file://src/types/analytics.ts#L199-L241)

### 请求/响应示例（摘要）
- 登录成功
  - 响应：{ success: true, token: "...", user: {...} }
- 登录失败
  - 响应：{ error: "用户名或密码错误" }
- 权限不足
  - 响应：{ code: "FORBIDDEN", error: "没有权限执行此操作" }
- 限流
  - 响应：{ code: "RATE_LIMITED", error: "..." }
- 计划无效
  - 响应：{ code: "PLAN_INVALID", error: "..." }
- 404 未匹配
  - 响应：{ error: "API endpoint not found" }
- **Agent编排示例**
  - 规划成功：{ ok: true, plan: { planId: "agent_xxx", understanding: "分析思路", steps: [...] } }
  - 执行成功：{ ok: true, traceId: "tr_agent_xxx", steps: [...], finalSummary: "总结信息" }
  - 计划过期：{ code: "NOT_FOUND", error: "编排计划不存在或已过期，请重新生成" }

**章节来源**
- [routes/auth.ts:41-77](file://server/routes/auth.ts#L41-L77)
- [errorCodes.ts:1-36](file://server/infra/errorCodes.ts#L1-L36)
- [server.ts:267-280](file://server.ts#L267-L280)
- [routes/agent.ts:20-61](file://server/routes/agent.ts#L20-L61)

### API 版本管理与兼容性
- 版本依据
  - OpenAPI 文档位于 docs/openapi.json，描述标题与版本号，作为前后端契约。
- 向后兼容
  - 提供遗留别名（如 /api/datasource/* → /api/datasources/*）。
- 废弃策略
  - 新增路由优先使用新路径；旧路径保留一段时间并提供迁移指引。

**章节来源**
- [openapi.json:1-12](file://docs/openapi.json#L1-L12)
- [openapi.json:85-90](file://docs/openapi.json#L85-L90)

### 前端 SDK 与集成
- 统一 fetch 封装
  - 自动注入 Authorization 头；401 清空会话；403 且 code 为 PASSWORD_CHANGE_REQUIRED 时触发强制改密流程。
- 配置方式
  - 在应用启动时调用 configureApiAuth 注入 getToken/onUnauthorized/onMustChangePassword。
- 错误处理
  - ApiError 携带 code，便于前端精准分支处理。
- **Agent编排集成**
  - 支持AgentPlan和AgentRunData类型的消息卡片展示
  - 提供agentPlan和agentRun字段用于编排计划和执行结果的UI展示

**章节来源**
- [client.ts:1-74](file://src/api/client.ts#L1-L74)
- [analytics.ts:277-280](file://src/types/analytics.ts#L277-L280)

### 集成示例代码（概念性）
- 登录并保存 Token
  - 调用 /api/auth/login，成功后将 token 存入本地存储。
- 发起问数请求
  - 调用 /api/query/natural-language，设置 stream=true 接收 SSE 事件。
- 处理强制改密
  - 捕获 403 且 code 为 PASSWORD_CHANGE_REQUIRED，跳转到改密页面。
- **Agent编排集成示例**
  - 生成编排计划：POST /api/agent/plan，获取planId
  - 执行编排计划：POST /api/agent/run，传入planId获取执行结果
  - 展示执行步骤：遍历steps数组，根据capability类型渲染不同UI组件

[本节为概念性说明，不直接引用具体代码片段]