#!/usr/bin/env python3
"""Generate 完整系统架构图 SVG using Python list method (fireworks-tech-graph Style 1)."""
import os

OUT = os.path.join(os.path.dirname(__file__), "完整系统架构图.svg")
W, H = 1200, 1830

L = []
def s(t): L.append(t)

s(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')
s('  <style>text { font-family: "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif; }</style>')
s('  <defs>')
s('    <marker id="ab" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#2563eb"/></marker>')
s('    <marker id="ag" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#16a34a"/></marker>')
s('    <marker id="ap" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#9333ea"/></marker>')
s('    <marker id="agray" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#6b7280"/></marker>')
s('    <marker id="ao" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ea580c"/></marker>')
s('  </defs>')
s(f'  <rect width="{W}" height="{H}" fill="#ffffff"/>')

def box(x, y, w, h, t1, t2, t3=None, fill="#ffffff", stroke="#d1d5db", fs1=12.5, fs2=10.5):
    cx = x + w // 2
    s(f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y + 20}" font-size="{fs1}" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    if t2:
        s(f'  <text x="{cx}" y="{y + 38}" font-size="{fs2}" fill="#6b7280" text-anchor="middle">{t2}</text>')
    if t3:
        s(f'  <text x="{cx}" y="{y + 52}" font-size="{fs2}" fill="#6b7280" text-anchor="middle">{t3}</text>')

# Title
s(f'  <text x="40" y="36" font-size="20" font-weight="700" fill="#111827">智能问数分析系统 · 完整系统架构图</text>')
s(f'  <text x="40" y="56" font-size="12" fill="#6b7280">v0.9.46 · NL2SQL Pro · React 19 + Vite + Express 4 · 大小模型分工 AI · 90 测试文件 / 1035 用例 · 112 REST 端点 OpenAPI 契约 · 2026-09-10</text>')

# ============ Layer 1: Client ============
s(f'  <rect x="36" y="72" width="1128" height="56" rx="10" fill="#f0f9ff" stroke="#bae6fd" stroke-width="1.5"/>')
s(f'  <text x="52" y="92" font-size="13" font-weight="600" fill="#0c4a6e">客户端 / 用户终端</text>')
s(f'  <text x="52" y="110" font-size="11" fill="#6b7280">Web 浏览器 · HTTP + SSE 流式（断线重连续传） · JWT Token · localStorage 偏好持久化（主题 / 金额单位 / 侧边栏 / 模型选择）</text>')
s(f'  <text x="900" y="110" font-size="11" fill="#0c4a6e" text-anchor="middle">→ http://127.0.0.1:3000 · Docker 容器（生产）</text>')
s(f'  <line x1="600" y1="128" x2="600" y2="152" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ============ Layer 2: Frontend ============
s(f'  <rect x="36" y="156" width="1128" height="290" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="52" y="176" font-size="13" font-weight="600" fill="#374151">前端应用层（React 19 + Vite + TypeScript + Tailwind CSS 4 + Zustand + Recharts + motion）· 左侧导航七大入口</text>')
mods1 = [
    (48, 186, "智能问数 QueryChat", "SSE 流式 · 推导回放 AnalysisTracePanel", "专家角色 · 结果全屏深读 (v0.9.38)"),
    (326, 186, "灵活查询 FlexQueryBuilder", "拖拽构建 · 高级筛选双入口 (v0.9.37)", "跨表 JOIN · 透视 · 1万/5万行"),
    (604, 186, "可视化决策报表", "ExecutiveReportCard · 同环比对比", "下钻 DrillModal · 批注 ChartComment"),
    (882, 186, "问数报告中心", "QueryReportCenter · 服务端保存", "详情复用 · PDF/PPT 导出 (v0.9.24)"),
]
for x, y, t1, t2, t3 in mods1:
    box(x, y, 262, 62, t1, t2, t3, "#eff6ff", "#bfdbfe")
mods2 = [
    (48, 258, "决策数据看板", "CustomDashboard · 图表固化", "DataVersionWatcher 60s 自主更新", "#ea580c"),
    (326, 258, "数据源与 Schema 管理", "DataSourceManager · 文件导入落库 (v0.9.34)", "SchemaViewer · DataLineageView · 行级权限", "#6b7280"),
    (604, 258, "知识 · 技能 · 样例 · 铁律 · 指标", "KnowledgeBasePanel · SkillLibraryModal", "IronRules · Metrics · ExpertPersonas", "#9333ea"),
    (882, 258, "系统管理（六大区块）", "基础管理 · 质量监控 · 规则治理", "权限审批 · AI 审核 · 系统配置", "#9333ea"),
]
for x, y, t1, t2, t3, tc in mods2:
    cx = x + 131
    s(f'  <rect x="{x}" y="{y}" width="262" height="62" rx="8" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+22}" font-size="12.5" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+40}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+54}" font-size="10.5" fill="{tc}" text-anchor="middle">{t3}</text>')
s(f'  <rect x="48" y="330" width="1096" height="36" rx="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1.2"/>')
s(f'  <text x="596" y="353" font-size="11" fill="#6b7280" text-anchor="middle">Hooks（useAnalyticsStore · useAuthStore · useEngineInfo · useDataVersion · useAmountUnitStore） · Utils（sseStream · queryResultNormalizer · flexQueryBuilder · reportRegen） · lazy 懒加载</text>')
s(f'  <rect x="48" y="374" width="1096" height="32" rx="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1.2"/>')
s(f'  <text x="596" y="395" font-size="11" fill="#6b7280" text-anchor="middle">ChatHistoryPanel · SQLPreviewModal · ChartCustomizer · KPIStats · DataTable · DynamicChart（9 种图表） · Login/ForceChangePassword · Header/Sidebar · AiReviewPanel · OpsMetricsPanel · IronRulesPanel · ExpertPersonaPanel</text>')
s(f'  <rect x="48" y="414" width="1096" height="24" rx="8" fill="#f0fdfa" stroke="#99f6e4" stroke-width="1"/>')
s(f'  <text x="596" y="430" font-size="10.5" fill="#115e59" text-anchor="middle">Vite Dev Server 中间件一体化（开发 tsx 直跑 · 生产 esbuild 打包 dist/server.cjs）</text>')
s(f'  <line x1="600" y1="446" x2="600" y2="472" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ============ Layer 3: API Gateway ============
s(f'  <rect x="36" y="476" width="1128" height="68" rx="10" fill="#fff7ed" stroke="#fdba74" stroke-width="1.5"/>')
s(f'  <text x="52" y="496" font-size="13" font-weight="600" fill="#9a3412">API 安全网关（Express 中间件链 · 112 REST 端点 OpenAPI 契约）</text>')
gw = [(48, 160, "L1 输入防护"), (216, 150, "L2 RBAC 鉴权"), (374, 190, "L3 Scope/敏感列/行级"), (572, 160, "L4 SELECT-only"), (740, 170, "L5 限流（速率+配额+并发）"), (918, 180, "L6 审计落账（八态）+ DLP")]
for x, w, t in gw:
    s(f'  <rect x="{x}" y="504" width="{w}" height="30" rx="6" fill="#fef3c7" stroke="#fde68a"/>')
    s(f'  <text x="{x + w//2}" y="524" font-size="10.5" fill="#92400e" text-anchor="middle">{t}</text>')
s(f'  <text x="600" y="540" font-size="10" fill="#9a3412" text-anchor="middle">requestLogger · 安全响应头（HSTS/CSP） · DLP 数据下载审计 (v0.9.26) · 生产 JWT_SECRET fail-fast · 默认回环 127.0.0.1</text>')
s(f'  <line x1="600" y1="544" x2="600" y2="570" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ============ Layer 4: Business Logic ============
s(f'  <rect x="36" y="574" width="1128" height="576" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="52" y="594" font-size="13" font-weight="600" fill="#374151">业务逻辑层（Express 4 · server/ 目录 · 27 路由模块 + 40 核心服务）</text>')

# Row 1: orchestrators
box(48, 604, 350, 62, "问数编排引擎 liveQuery.ts", "双阶段流水线 · SSE 流式进度 · 四契约", "铁律优先 · 专家角色 · 报告模式 · 深度分析")
box(410, 604, 350, 62, "报表双阶段编排 liveReport.ts", "查询计划 → 真实执行 → 摘要撰写 · 并行生成 (v0.9.11)", "金额单位口径 · 服务端保存 savedReports (v0.9.19-24)")
box(772, 604, 372, 62, "异步任务 taskQueue.ts + taskHandlers.ts", "报告 / 重算 / 导出入队异步执行 (v0.9.2-5)", "Redis 状态 · 断线重连 SSE 续传 (v0.9.6)", "#fff7ed", "#fed7aa")

# Row 2: query pipeline
box(48, 676, 260, 56, "Schema 圈表 schemaLinking.ts", "关键词粗排 + embedding 精排", "selectRelevantTablesAsync")
box(320, 676, 260, 56, "Schema 上下文 schemaContext.ts", "Scope 白名单 · 敏感列过滤", "5min 缓存 · 方言感知")
box(592, 676, 260, 56, "SQL 执行层 sqlExecutor.ts", "SELECT-only · AST 双校验", "连接池 · 行级权限注入 · 超时 10s")
box(864, 676, 280, 56, "Fallback 对抗训练 (v0.9.44-46)", "三层自救：规则修正→精简 schema→复用审核样例", "失败样本采集 → 人工审核 → Few-Shot 注入", "#fff7ed", "#fed7aa")

# Row 3: knowledge
box(48, 742, 260, 56, "知识库 knowledgeBase.ts", "切块+embedding+混合检索", "token 预算 · 漂移检测 (v0.9.7)")
box(320, 742, 260, 56, "外部知识库 externalKnowledge.ts", "POST 检索 · Bearer 认证", "AES-256-GCM · 四容器容错", "#faf5ff", "#ddd6fe")
box(592, 742, 260, 56, "反馈闭环 queryFeedback.ts", "点赞 → auto_train 沉淀", "点踩 → 反面教材注入")
box(864, 742, 280, 56, "对话历史 conversationHistory.ts", "服务端落库 · 跨设备共享", "个人 few-shot · 数据源隔离")

# Row 4: rules and personas
box(48, 808, 200, 56, "语义缓存 queryCache.ts", "等价归一化 · 10min", "模型/单位缓存键隔离")
box(260, 808, 200, 56, "语义指标 metrics.ts", "同义词匹配 · 口径注入", "指标直查 + filters")
box(472, 808, 200, 56, "铁律规则 ironRules.ts", "业务红线约束 (v0.9.35)", "强制注入 · 优先级最高", "#fff7ed", "#fed7aa")
box(684, 808, 200, 56, "专家角色 expertPersona.ts", "5 内置角色库化 (v0.9.40/43)", "角色提示词 + few-shot")
box(896, 808, 248, 56, "推导留痕 queryTrace.ts", "全链路步骤埋点", "traceId 回放 · 本人/ADMIN")

# Row 5: supporting
box(48, 874, 200, 48, "queryPlan.ts 计划模式", "planId 10min 一次性消费")
box(260, 874, 200, 48, "promptBudget.ts 预算", "知识 1200 · 历史截断")
box(472, 874, 200, 48, "drill.ts 图表下钻", "AST 提取 → SELECT *")
box(684, 874, 200, 48, "fileDataSource.ts 文件落库", "CSV/Excel/JSON 真实入库 (v0.9.34)")
box(896, 874, 248, 48, "driftDetector.ts 漂移检测", "口径漂移识别 → 运营告警 (v0.9.7-8)")

# Row 6: ops and resilience
box(48, 930, 260, 48, "fallbackStrategies 三层降级", "ruleBased → simplerPrompt → 样例复用", fill="#fff7ed", stroke="#fed7aa", fs1=11.5, fs2=10)
box(320, 930, 260, 48, "serverFallbacks.ts 服务端兜底", "中文强制兜底 · 派生列中文化 (v0.9.39-42)", fill="#fff7ed", stroke="#fed7aa", fs1=11.5, fs2=10)
box(592, 930, 260, 48, "monitoring.ts 运行监控", "可用性/成功率/耗时/缓存命中 (v0.9.14-16)")
box(864, 930, 280, 48, "abTest.ts A/B 实验 (v0.9.46)", "降级策略对比看板 · 数据决策去留")

# Infra strip 1
s(f'  <rect x="48" y="986" width="1096" height="32" rx="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1.2"/>')
s(f'  <text x="596" y="1007" font-size="10.5" fill="#6b7280" text-anchor="middle">auth.ts · oidc.ts · passwords.ts · accessControl.ts · db.ts · secretsCrypto.ts · rateLimiter.ts · auditLog.ts · requestLogger.ts · scope.ts · schemaGuidance.ts · queryGuard.ts · queryHooks.ts · llmUsage.ts</text>')
# Infra strip 2
s(f'  <rect x="48" y="1026" width="1096" height="32" rx="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1.2"/>')
s(f'  <text x="596" y="1047" font-size="10.5" fill="#6b7280" text-anchor="middle">stateStore.ts · errorCodes.ts · userQueryLimit.ts · dataVersion.ts · skills.ts · skillLibrary.ts · seedData.ts · defaultWidgets.ts · sqlTemplates.ts · liveQueryParsers.ts · liveQueryPrompts.ts · dlp.ts · introspection.ts · refusal.ts · clarification.ts</text>')
# Infra strip 3: evaluation
s(f'  <rect x="48" y="1066" width="1096" height="28" rx="8" fill="#f0fdf4" stroke="#bbf7d0" stroke-width="1"/>')
s(f'  <text x="596" y="1085" font-size="10.5" fill="#166534" text-anchor="middle">知识注入优先级链（v0.9.35+）：铁律规则 > 语义指标 > 专家角色 > few-shot 样例 > 知识库 RAG · JSON 备份导入导出（指标/样例/知识 v0.9.33）</text>')

# LLM arrows
s(f'  <line x1="400" y1="1150" x2="400" y2="1186" stroke="#9333ea" stroke-width="1.5" marker-start="url(#ap)" marker-end="url(#ap)"/>')
s(f'  <line x1="800" y1="1150" x2="800" y2="1186" stroke="#9333ea" stroke-width="1.5" marker-start="url(#ap)" marker-end="url(#ap)"/>')
s(f'  <text x="410" y="1174" font-size="10.5" fill="#9333ea">LLM 调用 / 向量</text>')

# ============ Layer 5: AI Engine ============
s(f'  <rect x="36" y="1190" width="1128" height="146" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="52" y="1210" font-size="13" font-weight="600" fill="#374151">AI 引擎层（llmClient.ts · 大小模型分工 v0.8 · 引擎选择：用户自选 > AI_ENGINE > 密钥自动 > Ollama）</text>')
box(48, 1220, 210, 76, "通义千问 Qwen（大模型）", "百炼兼容端点 · SQL 生成主力", "复杂推理 · 深度分析", "#faf5ff", "#ddd6fe")
box(270, 1220, 210, 76, "Ollama 本地（小模型）", "快速任务 · 解读 · 兜底", "本地私有化 · keep_alive=30m", "#f0fdfa", "#99f6e4")
box(492, 1220, 160, 76, "Gemini API", "备用引擎", None, "#faf5ff", "#ddd6fe")
box(664, 1220, 200, 76, "Embedding 向量", "nomic-embed-text（本地）", "text-embedding-v4（云）", "#fff7ed", "#fed7aa")
box(876, 1220, 268, 76, "Python ReportLab 子进程", "spawn python3 · stdin JSON 管道", "stdout PDF · CID 中文字体", "#fef2f2", "#fecaca")
s(f'  <text x="596" y="1322" font-size="10.5" fill="#374151" text-anchor="middle">大小模型分工：SQL 生成走大模型保准确率，解读 / 澄清 / 兜底走小模型保响应速度；主引擎失败自动切换备用引擎（llmResilience.ts）</text>')

# Storage arrows
s(f'  <line x1="300" y1="1336" x2="300" y2="1368" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <line x1="600" y1="1336" x2="600" y2="1368" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <line x1="900" y1="1336" x2="900" y2="1368" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <text x="310" y="1360" font-size="10.5" fill="#16a34a">元数据/留痕</text>')
s(f'  <text x="610" y="1360" font-size="10.5" fill="#16a34a">真实 SQL</text>')
s(f'  <text x="910" y="1360" font-size="10.5" fill="#16a34a">状态/外部</text>')

# ============ Layer 6: Storage ============
s(f'  <rect x="36" y="1372" width="1128" height="210" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="52" y="1392" font-size="13" font-weight="600" fill="#374151">数据与存储层</text>')

def cylinder(x, w, title, lines, fill, stroke, top_fill):
    cx = x + w // 2
    s(f'  <path d="M {x},1408 A {w//2},10 0 0 1 {x+w},1408 L {x+w},1494 A {w//2},10 0 0 1 {x},1494 Z" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <ellipse cx="{cx}" cy="1408" rx="{w//2}" ry="10" fill="{top_fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="1432" font-size="12" font-weight="600" fill="#111827" text-anchor="middle">{title}</text>')
    for i, ln in enumerate(lines):
        s(f'  <text x="{cx}" y="{1448 + i*14}" font-size="10" fill="#6b7280" text-anchor="middle">{ln}</text>')

cylinder(48, 240, "应用库 MySQL smart_analytics", ["users/datasources/scope/knowledge_chunks", "sql_examples/metrics/skills/audit_log", "iron_rules (v0.9.35) · expert_personas", "fallback_samples · ab_experiments", "saved_reports · tasks · query_trace", "conversation_history/report_templates"], "#f0fdf4", "#86efac", "#dcfce7")
cylinder(320, 220, "用户源数据库", ["MySQL / PostgreSQL / Greenplum", "业务宽表 127万行 · 财务 1139万行", "CSV / Excel / JSON 文件落库 (v0.9.34)", "20个月末快照 · API 数据源"], "#f0fdf4", "#86efac", "#dcfce7")
cylinder(568, 160, "Redis / StateStore", ["限流计数 / 配额 / 并发槽位", "planId 消费 · 任务队列状态", "SSE 续传缓冲 (v0.9.6)", "未配 → 进程内"], "#f0fdf4", "#86efac", "#dcfce7")
cylinder(756, 180, "外部知识库服务", ["Dify / RAGFlow / 自建 RAG", "POST {query, topK} · Bearer 认证", "API Key AES-256-GCM 加密"], "#faf5ff", "#ddd6fe", "#ede9fe")
s(f'  <rect x="960" y="1408" width="184" height="96" rx="8" fill="#fffbeb" stroke="#fde68a" stroke-width="1.2"/>')
s(f'  <text x="1052" y="1430" font-size="11" font-weight="600" fill="#111827" text-anchor="middle">评测集 server/eval</text>')
s(f'  <text x="1052" y="1448" font-size="10" fill="#6b7280" text-anchor="middle">NL2SQL 准确率评测</text>')
s(f'  <text x="1052" y="1462" font-size="10" fill="#6b7280" text-anchor="middle">差评回流 · evalCases.json</text>')
s(f'  <text x="1052" y="1476" font-size="10" fill="#6b7280" text-anchor="middle">主动学习排序 (v0.9.45.2)</text>')
s(f'  <text x="1052" y="1490" font-size="10" fill="#6b7280" text-anchor="middle">频次/复杂度/影响用户</text>')
s(f'  <text x="596" y="1530" font-size="10.5" fill="#9ca3af" text-anchor="middle">对话历史服务端落库（跨设备共享） · JSON 备份导入导出（知识/指标/样例 v0.9.33） · 数据源隔离</text>')

s(f'  <line x1="600" y1="1582" x2="600" y2="1608" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#agray)"/>')

# ============ Layer 7: Infrastructure ============
s(f'  <rect x="36" y="1612" width="1128" height="136" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="52" y="1632" font-size="13" font-weight="600" fill="#374151">基础设施 / 部署 / 质量</text>')
infra = [
    (48, "Node.js 运行时", ["tsx 开发 · esbuild 打包", "dist/server.cjs 生产产物", "PORT 3000 · HOST 127.0.0.1", "Vite dev 中间件一体化"]),
    (260, "Docker 容器", ["多阶段构建 · 非 root", "HEALTHCHECK 探活", "docker-compose 单/多实例", "Prometheus/Grafana 监控栈"]),
    (472, "测试与门禁", ["Vitest 90 文件 1035 用例", "tsc 三档编译 0 错误", "Playwright E2E 10 用例", "pre-push 7 道自动化门禁"]),
    (684, "Git 双远程", ["origin: GitHub (HTTPS)", "gitee: Gitee (SSH)", "main 分支 · 禁止 force", "修改前 pull · 完成后双推"]),
    (896, "文档即产品", ["系统功能说明书（单一事实源）", "系统内帮助实时读取", "变更记录 v0.1→v0.9.46", "OpenAPI · 培训 PPT · 架构图"]),
]
for x, t1, lines in infra:
    s(f'  <rect x="{x}" y="1642" width="200" height="90" rx="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1.2"/>')
    cx = x + 100
    s(f'  <text x="{cx}" y="1660" font-size="12" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    for i, ln in enumerate(lines):
        s(f'  <text x="{cx}" y="{1678 + i*14}" font-size="10" fill="#6b7280" text-anchor="middle">{ln}</text>')

# ============ Legend ============
ly = 1772
s(f'  <text x="52" y="{ly}" font-size="12" font-weight="600" fill="#374151">图例</text>')
s(f'  <line x1="52" y1="{ly+18}" x2="82" y2="{ly+18}" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')
s(f'  <text x="90" y="{ly+22}" font-size="10.5" fill="#6b7280">主流程 / 请求</text>')
s(f'  <line x1="180" y1="{ly+18}" x2="210" y2="{ly+18}" stroke="#16a34a" stroke-width="1.5" marker-end="url(#ag)"/>')
s(f'  <text x="218" y="{ly+22}" font-size="10.5" fill="#6b7280">数据读写</text>')
s(f'  <line x1="290" y1="{ly+18}" x2="320" y2="{ly+18}" stroke="#9333ea" stroke-width="1.5" marker-end="url(#ap)"/>')
s(f'  <text x="328" y="{ly+22}" font-size="10.5" fill="#6b7280">LLM 调用 / 向量</text>')
s(f'  <line x1="430" y1="{ly+18}" x2="460" y2="{ly+18}" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#agray)"/>')
s(f'  <text x="468" y="{ly+22}" font-size="10.5" fill="#6b7280">基础设施</text>')
s(f'  <line x1="540" y1="{ly+18}" x2="570" y2="{ly+18}" stroke="#ea580c" stroke-width="1.5" marker-end="url(#ao)"/>')
s(f'  <text x="578" y="{ly+22}" font-size="10.5" fill="#6b7280">橙色 = v0.6+ 新增能力</text>')
s(f'  <text x="52" y="{ly+44}" font-size="10.5" fill="#9ca3af">架构分层：客户端 → 前端应用层（七大导航） → API 安全网关（6 层纵深 + DLP） → 业务逻辑层（27 路由 + 40 服务） → AI 引擎层（大小模型分工） → 数据与存储层 → 基础设施</text>')
s(f'  <text x="52" y="{ly+60}" font-size="10.5" fill="#9ca3af">v0.6→v0.9.46 新增：异步任务 · SSE 断线续传 · 漂移检测 · 并行生成 · 运行监控 · 报表口径与服务端保存 · JSON 备份 · 文件数据源落库 · 铁律规则库 · 高级筛选双入口 · 结果全屏 · 中文强制兜底 · 专家角色库化 · Fallback 对抗训练（三层自救/审核队列/Few-Shot 注入/主动学习/A-B 实验）</text>')

s('</svg>')

with open(OUT, 'w') as f:
    f.write('\n'.join(L))
print(f"OK Generated: {OUT} ({len(L)} lines)")
