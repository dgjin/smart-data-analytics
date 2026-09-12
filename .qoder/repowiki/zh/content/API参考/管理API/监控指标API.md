# 监控指标API

<cite>
**本文引用的文件**
- [server.ts](file://server.ts)
- [server/infra/health.ts](file://server/infra/health.ts)
- [server/infra/shutdown.ts](file://server/infra/shutdown.ts)
- [server/infra/monitoring.ts](file://server/infra/monitoring.ts)
- [server/routes/opsMetrics.ts](file://server/routes/opsMetrics.ts)
- [server/query/metrics.ts](file://server/query/metrics.ts)
- [server/routes/metrics.ts](file://server/routes/metrics.ts)
- [deploy/prometheus.yml](file://deploy/prometheus.yml)
- [deploy/prometheus-alerts.yml](file://deploy/prometheus-alerts.yml)
- [deploy/alertmanager.yml](file://deploy/alertmanager.yml)
- [deploy/grafana/provisioning/datasources/prometheus.yml](file://deploy/grafana/provisioning/datasources/prometheus.yml)
- [deploy/grafana/provisioning/dashboards/dashboards.yml](file://deploy/grafana/provisioning/dashboards/dashboards.yml)
</cite>

## 更新摘要
**变更内容**
- 新增Kubernetes风格健康检查端点（/api/health/live 和 /api/health/ready）
- 增强依赖服务检查（MySQL和Redis连接性检测）
- 实现并行探测执行与超时控制机制
- 集成优雅停机功能，支持drain期间503状态响应
- 完善健康检查报告结构和错误处理

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
本文件面向"监控指标API"，覆盖系统健康检查、服务可用性探测、性能与业务指标采集、运维资源监控、告警与可视化展示，以及指标数据的存储策略、查询优化与聚合计算。文档以代码级为依据，提供端到端的数据流、调用序列与配置说明，帮助读者快速理解并正确使用该系统的监控能力。

**更新** 新增了Kubernetes风格的健康检查分级机制，支持liveness和readiness探针，增强了依赖服务检查和优雅停机集成。

## 项目结构
本项目采用 Express 作为 HTTP 服务入口，通过中间件对 /api/* 请求进行耗时统计；应用暴露 /metrics 供 Prometheus 抓取；Prometheus 负责规则评估与告警触发，Alertmanager 负责通知；Grafana 自动加载数据源与仪表盘 JSON，用于可视化展示。

```mermaid
graph TB
A["客户端/监控系统"] --> B["Express 服务器<br/>server.ts"]
B --> C["HTTP 耗时中间件<br/>httpRequestDuration"]
B --> D["健康检查 /api/health/live"]
B --> E["就绪检查 /api/health/ready"]
B --> F["指标导出 /metrics<br/>metricsHandler"]
F --> G["Prometheus 抓取"]
G --> H["PromQL 规则<br/>prometheus-alerts.yml"]
H --> I["Alertmanager<br/>alertmanager.yml"]
G --> J["Grafana<br/>datasource + dashboards"]
E --> K["依赖检查<br/>MySQL/Redis"]
D --> L["进程存活检测"]
```

**图表来源**
- [server.ts:194-211](file://server.ts#L194-L211)
- [server/infra/health.ts:1-87](file://server/infra/health.ts#L1-L87)
- [server/infra/monitoring.ts:135-161](file://server/infra/monitoring.ts#L135-L161)
- [deploy/prometheus.yml:16-38](file://deploy/prometheus.yml#L16-L38)
- [deploy/prometheus-alerts.yml:1-144](file://deploy/prometheus-alerts.yml#L1-L144)
- [deploy/alertmanager.yml:1-43](file://deploy/alertmanager.yml#L1-L43)
- [deploy/grafana/provisioning/datasources/prometheus.yml:1-11](file://deploy/grafana/provisioning/datasources/prometheus.yml#L1-L11)
- [deploy/grafana/provisioning/dashboards/dashboards.yml:1-14](file://deploy/grafana/provisioning/dashboards/dashboards.yml#L1-L14)

**章节来源**
- [server.ts:194-211](file://server.ts#L194-L211)
- [deploy/prometheus.yml:16-38](file://deploy/prometheus.yml#L16-L38)

## 核心组件
- **Kubernetes健康检查接口**：/api/health/live（存活探针）和/api/health/ready（就绪探针），分别用于进程存活检测和依赖服务可用性检查。
- **健康检查分级机制**：liveness探针仅检查进程是否响应，readiness探针并行检查MySQL和Redis等关键依赖，支持超时控制和优雅停机集成。
- **指标采集与导出**：/metrics，暴露 Prometheus 格式指标（可选 METRICS_TOKEN 保护），包含默认运行时指标与业务埋点。
- **运维指标聚合 API**：/api/ops/metrics，仅管理员可访问，聚合问数链路十态、反馈点赞/点踩、自纠错触发与平均耗时，输出北极星指标、日趋势与周趋势。
- **语义指标层管理**：/api/metrics 系列接口，支持指标定义 CRUD、审批流程、版本回溯、统一指标查询（POST /api/metrics/query）与导入导出。

**章节来源**
- [server.ts:194-211](file://server.ts#L194-L211)
- [server/infra/health.ts:1-87](file://server/infra/health.ts#L1-L87)
- [server/infra/monitoring.ts:135-161](file://server/infra/monitoring.ts#L135-L161)
- [server/routes/opsMetrics.ts:257-324](file://server/routes/opsMetrics.ts#L257-L324)
- [server/routes/metrics.ts:38-301](file://server/routes/metrics.ts#L38-L301)

## 架构总览
系统通过三层实现"采集—聚合—可视/告警"的闭环：
- **采集层**：Express 中间件记录 HTTP 耗时；业务关键路径旁路埋点（审计、缓存命中、LLM 调用、SQL 执行）。
- **健康检查层**：Kubernetes风格的liveness和readiness探针，支持并行依赖检查和优雅停机集成。
- **聚合层**：Prometheus 定时抓取 /metrics，按规则计算比率与时延分位；/api/ops/metrics 从数据库聚合十态与反馈，计算北极星指标与趋势。
- **展示与告警**：Grafana 自动加载 Prometheus 数据源与仪表盘；Prometheus 规则触发告警，经 Alertmanager 推送至 Webhook。

```mermaid
sequenceDiagram
participant Client as "客户端"
participant Server as "Express server.ts"
participant Health as "health.ts"
participant Mon as "monitoring.ts"
participant Prom as "Prometheus"
participant AM as "Alertmanager"
participant Graf as "Grafana"
Client->>Server : GET /api/health/live
Server-->>Client : {status : 'ok', timestamp}
Client->>Server : GET /api/health/ready
Server->>Health : runReadiness(buildDefaultProbes())
Health->>Health : 并行检查 MySQL/Redis
Health-->>Server : ReadinessReport
Server-->>Client : 200/503 + Report
Client->>Server : GET /metrics (可选 token)
Server->>Mon : metricsHandler()
Mon-->>Client : Prometheus 文本指标
Prom->>Server : 定期抓取 /metrics
Prom->>Prom : 计算规则/阈值
Prom-->>AM : 触发告警事件
AM-->>Client : 通知(Webhook/邮件等)
Graf->>Prom : 查询指标/仪表盘
Prom-->>Graf : 时序数据
```

**图表来源**
- [server.ts:194-211](file://server.ts#L194-L211)
- [server/infra/health.ts:49-65](file://server/infra/health.ts#L49-L65)
- [server/infra/monitoring.ts:135-161](file://server/infra/monitoring.ts#L135-L161)
- [deploy/prometheus.yml:16-38](file://deploy/prometheus.yml#L16-L38)
- [deploy/prometheus-alerts.yml:1-144](file://deploy/prometheus-alerts.yml#L1-L144)
- [deploy/alertmanager.yml:1-43](file://deploy/alertmanager.yml#L1-L43)
- [deploy/grafana/provisioning/datasources/prometheus.yml:1-11](file://deploy/grafana/provisioning/datasources/prometheus.yml#L1-L11)

## 详细组件分析

### Kubernetes风格健康检查系统
**新增功能** 实现了完整的Kubernetes健康检查机制，包括liveness和readiness探针：

- **Liveness探针**（/api/health/live）：浅层探测，进程能响应即返回200，供编排系统判断是否需要重启容器。
- **Readiness探针**（/api/health/ready）：深层探测，并行检查关键依赖（MySQL必检，Redis仅在配置时检查），任一失败返回503让上游摘除流量。
- **优雅停机集成**：在drain期间直接返回503状态码，确保流量正确路由。

```mermaid
flowchart TD
Start(["探针/监控发起"]) --> Type{"探针类型"}
Type --> |Liveness| Live["GET /api/health/live"]
Type --> |Readiness| Ready["GET /api/health/ready"]
Live --> LiveResp["返回 {status: 'ok', timestamp}"]
Ready --> DrainCheck{"是否draining?"}
DrainCheck --> |是| DrainResp["返回 503 {status: 'draining'}"]
DrainCheck --> |否| DepChecks["并行检查依赖"]
DepChecks --> MySQLCheck["检查MySQL连接"]
DepChecks --> RedisCheck["检查Redis连接(如配置)"]
MySQLCheck --> CheckResult{"所有检查通过?"}
RedisCheck --> CheckResult
CheckResult --> |是| ReadyOk["返回 200 {status: 'ok'}"]
CheckResult --> |否| ReadyDown["返回 503 {status: 'down'}"]
```

**图表来源**
- [server.ts:199-211](file://server.ts#L199-L211)
- [server/infra/health.ts:49-65](file://server/infra/health.ts#L49-L65)
- [server/infra/shutdown.ts:100-107](file://server/infra/shutdown.ts#L100-L107)

**章节来源**
- [server.ts:199-211](file://server.ts#L199-L211)
- [server/infra/health.ts:1-87](file://server/infra/health.ts#L1-L87)
- [server/infra/shutdown.ts:100-107](file://server/infra/shutdown.ts#L100-L107)

### 依赖服务检查机制
**新增功能** 实现了健壮的依赖服务检查系统：

- **并行执行**：使用Promise.all并行检查多个依赖，避免慢依赖互相拖累。
- **超时控制**：每个探测都有独立的超时限制（默认2秒），防止单个依赖阻塞整个检查过程。
- **错误收敛**：统一的错误处理机制，将超时和异常转换为标准化的错误信息。
- **条件检查**：Redis检查仅在配置了REDIS_URL时执行，避免不必要的依赖。

```mermaid
classDiagram
class HealthProbe {
+name : string
+run() : Promise~unknown~
}
class ReadinessCheck {
+ok : boolean
+ms : number
+error? : string
}
class ReadinessReport {
+ok : boolean
+status : 'ok' | 'down'
+checks : Record~string, ReadinessCheck~
+timestamp : string
}
class HealthChecker {
+withTimeout(promise, ms, name) : Promise
+runReadiness(probes, timeoutMs) : Promise~ReadinessReport~
+buildDefaultProbes() : HealthProbe[]
}
HealthChecker --> HealthProbe
HealthChecker --> ReadinessCheck
HealthChecker --> ReadinessReport
```

**图表来源**
- [server/infra/health.ts:13-30](file://server/infra/health.ts#L13-L30)
- [server/infra/health.ts:32-65](file://server/infra/health.ts#L32-L65)
- [server/infra/health.ts:67-87](file://server/infra/health.ts#L67-L87)

**章节来源**
- [server/infra/health.ts:32-87](file://server/infra/health.ts#L32-L87)

### 优雅停机集成
**新增功能** 实现了完整的优雅停机机制：

- **信号处理**：监听SIGTERM/SIGINT信号，启动优雅停机流程。
- **drain状态**：在停机过程中设置isDraining标志，健康检查据此返回503。
- **资源清理**：按顺序停止任务worker、关闭连接池、释放资源。
- **超时保护**：防止停机过程无限期挂起，支持强制退出。

```mermaid
sequenceDiagram
participant Signal as "操作系统信号"
participant Shutdown as "shutdown.ts"
participant Health as "health.ts"
participant Server as "Express Server"
Signal->>Shutdown : SIGTERM/SIGINT
Shutdown->>Shutdown : trigger(signal)
Shutdown->>Server : beforeClose()
Shutdown->>Server : close()
Shutdown->>Server : closeIdleConnections()
Shutdown->>Server : 等待在途请求结束
Note over Shutdown,Server : drain期间 isDraining = true
Health->>Shutdown : isDraining()
Shutdown-->>Health : true
Health-->>Health : 返回503状态
Shutdown->>Server : closeAllConnections() (超时后)
Shutdown->>Server : closeResources()
Shutdown-->>Signal : exit(0)
```

**图表来源**
- [server/infra/shutdown.ts:65-98](file://server/infra/shutdown.ts#L65-L98)
- [server/infra/shutdown.ts:100-107](file://server/infra/shutdown.ts#L100-L107)
- [server.ts:332-339](file://server.ts#L332-L339)

**章节来源**
- [server/infra/shutdown.ts:65-107](file://server/infra/shutdown.ts#L65-L107)
- [server.ts:332-339](file://server.ts#L332-L339)

### 性能指标收集接口
- HTTP 接口耗时：中间件对 /api/* 记录 method/route/status 直方图，便于定位慢接口。
- 问数端到端耗时：nl2sql_duration_seconds，按 status 分桶，覆盖毫秒到分钟级。
- LLM 调用耗时与 Token：llm_call_duration_seconds、llm_tokens_total，区分 channel/engine/model/ok。
- SQL 执行耗时：sql_execute_duration_seconds，区分 ok/error。
- 缓存命中：nl2sql_cache_hits_total，区分 l1/l2。

```mermaid
classDiagram
class Monitoring {
+httpRequestDuration
+nl2sqlRequests
+nl2sqlDuration
+nl2sqlCacheHits
+llmCallDuration
+llmTokens
+sqlExecDuration
+metricsHandler(req,res)
}
class Express {
+中间件记录耗时
}
Express --> Monitoring : "调用埋点"
```

**图表来源**
- [server/infra/monitoring.ts:16-88](file://server/infra/monitoring.ts#L16-L88)
- [server.ts:172-183](file://server.ts#L172-L183)

**章节来源**
- [server/infra/monitoring.ts:16-88](file://server/infra/monitoring.ts#L16-L88)
- [server.ts:172-183](file://server.ts#L172-L183)

### 业务指标统计（北极星指标与趋势）
- 数据来源：query_audit_log（十态）、query_feedback（UP/DOWN）、query_trace（自纠错触发）。
- 聚合函数：computeNorthStar、buildDailyTrend、toWeeklyTrend，纯函数便于单测与复用。
- 输出：northStar（成功率、缓存命中率、澄清率、拒绝率、降级率、错误率、被拒率、反馈率、自纠错率、平均耗时）、daily（按日）、weekly（按周）。

```mermaid
sequenceDiagram
participant Admin as "管理员/前端"
participant Ops as "/api/ops/metrics"
participant DB as "MySQL"
participant Calc as "computeNorthStar/buildDailyTrend/toWeeklyTrend"
Admin->>Ops : GET /api/ops/metrics?days=N&dataSourceId=?
Ops->>DB : 查询 audit/feedback/trace 与 avg(duration_ms)
DB-->>Ops : 原始计数行
Ops->>Calc : 传入 rows 与 days
Calc-->>Ops : northStar, daily, weekly
Ops-->>Admin : {success, days, dataSourceId, northStar, daily, weekly}
```

**图表来源**
- [server/routes/opsMetrics.ts:257-324](file://server/routes/opsMetrics.ts#L257-L324)
- [server/routes/opsMetrics.ts:100-250](file://server/routes/opsMetrics.ts#L100-L250)

**章节来源**
- [server/routes/opsMetrics.ts:100-250](file://server/routes/opsMetrics.ts#L100-L250)
- [server/routes/opsMetrics.ts:257-324](file://server/routes/opsMetrics.ts#L257-L324)

### 运维指标监控（系统资源、网络I/O、磁盘空间、进程状态）
- 抓取目标：node-exporter（CPU/内存/磁盘）、mysql-exporter（数据库）、redis-exporter（缓存）、alertmanager（自监控）。
- 告警规则：应用宕机、MySQL/Redis 不可达、内存高、磁盘低、Prometheus/Alertmanager 异常等。
- 抑制规则：应用宕机时抑制下游业务类告警，避免风暴。

```mermaid
graph LR
Node["Node Exporter"] --> Prom["Prometheus"]
MySQL["MySQL Exporter"] --> Prom
Redis["Redis Exporter"] --> Prom
App["应用 /metrics"] --> Prom
Prom --> Rules["规则评估"]
Rules --> AM["Alertmanager"]
AM --> Notify["Webhook/邮件"]
```

**图表来源**
- [deploy/prometheus.yml:16-43](file://deploy/prometheus.yml#L16-L43)
- [deploy/prometheus-alerts.yml:86-144](file://deploy/prometheus-alerts.yml#L86-L144)
- [deploy/alertmanager.yml:16-43](file://deploy/alertmanager.yml#L16-L43)

**章节来源**
- [deploy/prometheus.yml:16-43](file://deploy/prometheus.yml#L16-L43)
- [deploy/prometheus-alerts.yml:86-144](file://deploy/prometheus-alerts.yml#L86-L144)
- [deploy/alertmanager.yml:16-43](file://deploy/alertmanager.yml#L16-L43)

### 语义指标层管理与统一查询
- 指标定义：名称、同义词、口径表达式、归属表、固定过滤、可切分维度白名单、治理状态与版本。
- 统一查询：POST /api/metrics/query，按白名单维度生成 GROUP BY 查询，走安全执行层，结果按角色脱敏，支持金额单位换算标注。
- 治理流程：提议(PENDING)→审批(ACTIVE/REJECTED)→版本化快照，支持回溯与导入导出。

```mermaid
flowchart TD
Q["POST /api/metrics/query"] --> V["校验 metricId/维度白名单/ACL/限流"]
V --> Build["buildMetricQuerySql(含金额单位换算)"]
Build --> Exec["executeSafeSql(白名单/敏感列/行级过滤)"]
Exec --> Mask["DLP 脱敏"]
Mask --> Resp["返回 rows/rowCount/sql/amountUnit/executionTimeMs"]
```

**图表来源**
- [server/routes/metrics.ts:65-134](file://server/routes/metrics.ts#L65-L134)
- [server/query/metrics.ts:133-162](file://server/query/metrics.ts#L133-L162)

**章节来源**
- [server/routes/metrics.ts:65-134](file://server/routes/metrics.ts#L65-L134)
- [server/query/metrics.ts:133-162](file://server/query/metrics.ts#L133-L162)

## 依赖关系分析
- 服务启动与路由挂载：server.ts 注册健康检查、/metrics、各业务路由（含 opsMetrics、metrics）。
- 健康检查依赖：health.ts 依赖 db.ts（MySQL连接池）和 stateStore.ts（Redis状态存储）。
- 优雅停机依赖：shutdown.ts 提供统一的停机控制器，被server.ts集成。
- 指标采集：monitoring.ts 注册 prom-client 指标与 /metrics 处理器；Express 中间件记录 HTTP 耗时。
- 抓取与告警：prometheus.yml 配置抓取目标与规则文件；prometheus-alerts.yml 定义可用性、业务、资源三类告警；alertmanager.yml 配置通知渠道与抑制规则。
- 可视化：Grafana 自动加载 Prometheus 数据源与仪表盘 JSON。

```mermaid
graph TB
S["server.ts"] --> H["health.ts"]
S --> SH["shutdown.ts"]
S --> M["monitoring.ts"]
S --> R1["routes/opsMetrics.ts"]
S --> R2["routes/metrics.ts"]
H --> DB["db.ts"]
H --> SS["stateStore.ts"]
M --> P["prom-client Registry"]
P --> PM["Prometheus"]
PM --> RA["prometheus-alerts.yml"]
RA --> AM["alertmanager.yml"]
PM --> GF["Grafana datasources/dashboards"]
```

**图表来源**
- [server.ts:194-211](file://server.ts#L194-L211)
- [server/infra/health.ts:10-11](file://server/infra/health.ts#L10-L11)
- [server/infra/shutdown.ts:14](file://server/infra/shutdown.ts#L14)
- [server/infra/monitoring.ts:16-88](file://server/infra/monitoring.ts#L16-L88)
- [deploy/prometheus.yml:16-43](file://deploy/prometheus.yml#L16-L43)
- [deploy/prometheus-alerts.yml:1-144](file://deploy/prometheus-alerts.yml#L1-L144)
- [deploy/alertmanager.yml:1-43](file://deploy/alertmanager.yml#L1-L43)
- [deploy/grafana/provisioning/datasources/prometheus.yml:1-11](file://deploy/grafana/provisioning/datasources/prometheus.yml#L1-L11)
- [deploy/grafana/provisioning/dashboards/dashboards.yml:1-14](file://deploy/grafana/provisioning/dashboards/dashboards.yml#L1-L14)

**章节来源**
- [server.ts:194-211](file://server.ts#L194-L211)
- [server/infra/health.ts:10-11](file://server/infra/health.ts#L10-L11)
- [server/infra/shutdown.ts:14](file://server/infra/shutdown.ts#L14)
- [server/infra/monitoring.ts:16-88](file://server/infra/monitoring.ts#L16-L88)
- [deploy/prometheus.yml:16-43](file://deploy/prometheus.yml#L16-L43)

## 性能考量
- **低基数标签**：所有埋点严格避免 question/userId/dataSourceId 等高基数字段进入 label，防止时序膨胀。
- **直方图分桶**：针对成功/失败/降级等不同状态设置合理分桶，覆盖 ms 到分钟级，确保 P95/P99 估算准确。
- **旁路埋点**：审计、缓存、LLM、SQL 执行均通过 try/catch 静默失败，保证 fail-open，不影响主链路。
- **并行探测**：健康检查使用Promise.all并行执行，避免慢依赖阻塞整体检查。
- **超时控制**：每个探测都有独立超时，防止单个依赖影响整体响应时间。
- **查询优化**：/api/ops/metrics 使用按日分组与聚合函数，限制 days≤90，减少扫描范围；必要时可按 dataSourceId 下钻。
- **多实例兼容**：Prometheus 通过 instance label 区分多实例，仪表盘使用 sum() 聚合，口径一致。

## 故障排查指南
- **应用不可达**：检查 up{job="nl2sql-app"}，确认 /metrics 可抓取；若为 0，查看 Nl2sqlAppDown 告警。
- **健康检查失败**：检查 /api/health/ready 返回的 checks 字段，定位具体失败的依赖（mysql/redis）。
- **优雅停机问题**：检查 shutdown 日志，确认是否正确处理SIGTERM信号，验证drain期间是否返回503。
- **成功率下降**：观察 QuerySuccessRateLow，结合 nl2sql_duration_seconds 与 sql_execute_duration_seconds 定位瓶颈。
- **缓存命中率低**：关注 CacheHitRateLow，检查数据源变更后的失效联动与 TTL 配置。
- **延迟升高**：查看 QueryLatencyP95High，结合 llm_call_duration_seconds 与 sql_execute_duration_seconds 占比定位。
- **资源问题**：AppMemoryHigh 提示内存占用过高；DiskSpaceLow 提示磁盘不足；ScrapeDurationSlow 提示抓取变慢。
- **告警通道**：AlertmanagerDown 表示通知中断；抑制规则生效时，上游应用宕机会抑制下游业务告警。

**章节来源**
- [deploy/prometheus-alerts.yml:8-144](file://deploy/prometheus-alerts.yml#L8-L144)
- [deploy/alertmanager.yml:16-43](file://deploy/alertmanager.yml#L16-L43)

## 结论
本系统通过标准化的指标采集、严格的低基数约束、旁路埋点与 fail-open 设计，实现了稳定可靠的监控能力。**新增的Kubernetes风格健康检查系统**提供了完善的liveness和readiness探针支持，增强了依赖服务检查和优雅停机集成。Prometheus 负责规则评估与告警，Alertmanager 负责通知，Grafana 提供可视化。运维侧可通过 /api/ops/metrics 获取北极星指标与趋势，业务侧可通过 /api/metrics 管理指标定义与统一查询。整体架构兼顾可扩展性、可观测性与安全性。

## 附录

### 接口清单与示例（基于仓库实现）
- **健康检查**
  - 方法/路径：GET /api/health
  - 鉴权：无
  - 响应：包含状态与时间戳
  - 参考：[server.ts:194-197](file://server.ts#L194-L197)

- **Liveness探针**
  - 方法/路径：GET /api/health/live
  - 鉴权：无
  - 响应：{ status: 'ok', timestamp }
  - 用途：容器编排系统判断是否需要重启
  - 参考：[server.ts:199-203](file://server.ts#L199-L203)

- **Readiness探针**
  - 方法/路径：GET /api/health/ready
  - 鉴权：无
  - 响应：{ ok, status, checks, timestamp }
  - 用途：容器编排系统判断是否可以接收流量
  - 参考：[server.ts:204-211](file://server.ts#L204-L211)

- **指标导出**
  - 方法/路径：GET /metrics
  - 鉴权：可选 METRICS_TOKEN（Authorization: Bearer <token> 或 query token）
  - 响应：Prometheus 文本格式
  - 参考：[server/infra/monitoring.ts:135-161](file://server/infra/monitoring.ts#L135-L161)

- **运维指标聚合**
  - 方法/路径：GET /api/ops/metrics?days=7&dataSourceId=xxx
  - 鉴权：ADMIN
  - 响应：{ success, days, dataSourceId, northStar, daily, weekly }
  - 参考：[server/routes/opsMetrics.ts:257-324](file://server/routes/opsMetrics.ts#L257-L324)

- **语义指标查询**
  - 方法/路径：POST /api/metrics/query
  - 鉴权：ADMIN/ANALYST
  - 请求体：metricId、dimensions[]、limit、amountUnit
  - 响应：{ ok, metric, groupBy, sql, rows, rowCount, truncated, amountUnit, executionTimeMs, dlp? }
  - 参考：[server/routes/metrics.ts:65-134](file://server/routes/metrics.ts#L65-L134)

- **指标库导入/导出**
  - 导出：GET /api/metrics/export?dataSourceId=xxx（ADMIN）
  - 导入：POST /api/metrics/import（ADMIN），支持 mergeStrategy 与 dryRun
  - 参考：[server/routes/metrics.ts:136-206](file://server/routes/metrics.ts#L136-L206)

### 存储策略与查询优化
- 指标定义与版本：metric_definitions 与 metric_versions 表，支持创建/更新/审批/回溯留痕。
- 审计与反馈：query_audit_log、query_feedback、query_trace 支撑北极星指标与趋势计算。
- 查询优化：按日期范围过滤、GROUP BY 聚合、限制 days≤90、可选 dataSourceId 下钻；指标查询走白名单维度与安全执行层。
- 参考：
  - [server/query/metrics.ts:199-214](file://server/query/metrics.ts#L199-L214)
  - [server/query/metrics.ts:234-279](file://server/query/metrics.ts#L234-L279)
  - [server/query/metrics.ts:335-377](file://server/query/metrics.ts#L335-L377)
  - [server/routes/opsMetrics.ts:268-313](file://server/routes/opsMetrics.ts#L268-L313)

### 可视化与告警通知机制
- 可视化：Grafana 自动加载 Prometheus 数据源与仪表盘 JSON，文件夹"智能问数"。
- 告警：Prometheus 规则评估后推送到 Alertmanager，按 severity 与 group_by 分组，支持抑制规则避免风暴。
- 通知：Webhook（企业微信/钉钉/自研网关）或邮件（模板已预留）。
- 参考：
  - [deploy/grafana/provisioning/datasources/prometheus.yml:1-11](file://deploy/grafana/provisioning/datasources/prometheus.yml#L1-L11)
  - [deploy/grafana/provisioning/dashboards/dashboards.yml:1-14](file://deploy/grafana/provisioning/dashboards/dashboards.yml#L1-L14)
  - [deploy/prometheus-alerts.yml:1-144](file://deploy/prometheus-alerts.yml#L1-L144)
  - [deploy/alertmanager.yml:1-43](file://deploy/alertmanager.yml#L1-L43)

### 健康检查配置示例
- **Kubernetes Liveness Probe**
  ```yaml
  livenessProbe:
    httpGet:
      path: /api/health/live
      port: 3000
    initialDelaySeconds: 5
    periodSeconds: 10
  ```

- **Kubernetes Readiness Probe**
  ```yaml
  readinessProbe:
    httpGet:
      path: /api/health/ready
      port: 3000
    initialDelaySeconds: 10
    periodSeconds: 5
  ```

- **Prometheus ServiceMonitor**
  ```yaml
  apiVersion: monitoring.coreos.com/v1
  kind: ServiceMonitor
  metadata:
    name: smartaq-monitor
  spec:
    selector:
      matchLabels:
        app: smartaq
    endpoints:
    - port: http
      path: /metrics
      interval: 15s
  ```

**章节来源**
- [server.ts:194-211](file://server.ts#L194-L211)
- [server/infra/health.ts:1-87](file://server/infra/health.ts#L1-L87)
- [server/infra/shutdown.ts:100-107](file://server/infra/shutdown.ts#L100-L107)
- [server/infra/monitoring.ts:135-161](file://server/infra/monitoring.ts#L135-L161)