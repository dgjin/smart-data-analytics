#!/usr/bin/env python3
"""Generate 完整系统架构图 SVG using Python list method (fireworks-tech-graph Style 1)."""
import os

OUT = os.path.join(os.path.dirname(__file__), "完整系统架构图.svg")
W, H = 1200, 1640

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

s(f'  <text x="40" y="36" font-size="20" font-weight="700" fill="#111827">智能问数分析系统 · 完整系统架构图</text>')
s(f'  <text x="40" y="56" font-size="12" fill="#6b7280">v0.5.3 · NL2SQL Pro · React 19 + Vite + Express 4 + 三引擎 AI · 54 测试文件 / 569 用例 · 2026-08-21</text>')

# ===== Layer 1: Client =====
s(f'  <rect x="36" y="72" width="1128" height="56" rx="10" fill="#f0f9ff" stroke="#bae6fd" stroke-width="1.5"/>')
s(f'  <text x="52" y="92" font-size="13" font-weight="600" fill="#0c4a6e">客户端 / 用户终端</text>')
s(f'  <text x="52" y="110" font-size="11" fill="#6b7280">Web 浏览器 · HTTP + SSE · JWT Token · localStorage 偏好持久化（主题 / 金额单位 / 侧边栏 / 模型选择）</text>')
s(f'  <text x="900" y="110" font-size="11" fill="#0c4a6e" text-anchor="middle">→ http://127.0.0.1:3000 · Docker 容器（生产）</text>')
s(f'  <line x1="600" y1="128" x2="600" y2="152" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ===== Layer 2: Frontend =====
s(f'  <rect x="36" y="156" width="1128" height="290" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="52" y="176" font-size="13" font-weight="600" fill="#374151">前端应用层（React 19 + Vite + TypeScript + Tailwind CSS 4 + Zustand + Recharts + motion）</text>')

# Frontend Row 1
frow1 = [
    (48, 186, "智能问数 QueryChat", "SSE 流式 · 推导回放 AnalysisTracePanel", "计划/报告/深度分析 · 模型下拉"),
    (326, 186, "灵活查询 FlexQueryBuilder", "拖拽构建 · 多表 JOIN · 透视/CSV", "全屏 · 固化看板 · 查询历史"),
    (604, 186, "可视化决策报表", "ExecutiveReportCard · 同环比对比", "下钻 DrillModal · 批注 ChartComment"),
    (882, 186, "问数报告中心", "QueryReportCenter · 报告列表", "详情复用 · PDF/PPT 导出"),
]
for x, y, t1, t2, t3 in frow1:
    cx = x + 131
    s(f'  <rect x="{x}" y="{y}" width="262" height="62" rx="8" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+22}" font-size="12.5" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+40}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+54}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')

# Frontend Row 2
frow2 = [
    (48, 258, "决策数据看板", "CustomDashboard · 图表固化", "DataVersionWatcher 60s 自主更新"),
    (326, 258, "数据源与 Schema 管理", "DataSourceManager · SchemaViewer", "DataLineageView · 行级权限"),
    (604, 258, "知识 · 技能 · 样例", "KnowledgeBasePanel · SkillLibraryModal", "ExternalKnowledgeCard · SqlExamples"),
    (882, 258, "系统管理 + 报告模板", "AdminPanel · LlmUsagePanel", "ReportTemplateManager · HelpModal"),
]
for x, y, t1, t2, t3 in frow2:
    cx = x + 131
    t3c = "#ea580c" if "自主更新" in t3 else "#6b7280"
    s(f'  <rect x="{x}" y="{y}" width="262" height="62" rx="8" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+22}" font-size="12.5" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+40}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+54}" font-size="10.5" fill="{t3c}" text-anchor="middle">{t3}</text>')

# Frontend infra
s(f'  <rect x="48" y="330" width="1096" height="36" rx="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1.2"/>')
s(f'  <text x="596" y="353" font-size="11" fill="#6b7280" text-anchor="middle">Hooks（useAnalyticsStore · useAuthStore · useEngineInfo · useDataVersion） · Utils（sseStream · queryResultNormalizer · flexQueryBuilder） · Types（analytics.ts AppTab） · lazy 懒加载</text>')
s(f'  <rect x="48" y="374" width="1096" height="32" rx="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1.2"/>')
s(f'  <text x="596" y="395" font-size="11" fill="#6b7280" text-anchor="middle">ChatHistoryPanel · SQLPreviewModal · ChartCustomizer · KPIStats · DataTable · DynamicChart（9 种图表） · Login/ForceChangePassword · Header/Sidebar</text>')
s(f'  <rect x="48" y="414" width="1096" height="24" rx="8" fill="#f0fdfa" stroke="#99f6e4" stroke-width="1"/>')
s(f'  <text x="596" y="430" font-size="10.5" fill="#115e59" text-anchor="middle">Vite Dev Server 中间件一体化（开发 tsx 直跑 · 生产 esbuild 打包 dist/server.cjs）</text>')

s(f'  <line x1="600" y1="446" x2="600" y2="472" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ===== Layer 3: API Gateway =====
s(f'  <rect x="36" y="476" width="1128" height="68" rx="10" fill="#fff7ed" stroke="#fdba74" stroke-width="1.5"/>')
s(f'  <text x="52" y="496" font-size="13" font-weight="600" fill="#9a3412">API 安全网关（Express 中间件链）</text>')
gw_items = [
    (48, "L1 输入防护", 160), (216, "L2 RBAC 鉴权", 150),
    (374, "L3 Scope/敏感列/行级权限", 190), (572, "L4 SELECT-only", 160),
    (740, "L5 限流（速率+配额+并发）", 170), (918, "L6 审计落账（八态）", 180),
]
for x, label, w in gw_items:
    s(f'  <rect x="{x}" y="504" width="{w}" height="30" rx="6" fill="#fef3c7" stroke="#fde68a"/>')
    s(f'  <text x="{x + w//2}" y="524" font-size="10.5" fill="#92400e" text-anchor="middle">{label}</text>')
s(f'  <text x="600" y="540" font-size="10" fill="#9a3412" text-anchor="middle">requestLogger · 安全响应头（HSTS/CSP） · 生产 JWT_SECRET fail-fast · 默认回环 127.0.0.1</text>')

s(f'  <line x1="600" y1="544" x2="600" y2="570" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ===== Layer 4: Business Logic =====
s(f'  <rect x="36" y="574" width="1128" height="400" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="52" y="594" font-size="13" font-weight="600" fill="#374151">业务逻辑层（Express 4 · server/ 目录 · 19 个路由模块 + 核心服务）</text>')

# BL Row 1
blrow1 = [
    (48, 604, 350, "问数编排引擎 liveQuery.ts", "双阶段流水线 · SSE 流式进度 · 四契约", "计划模式 · 报告模式 · 金额单位 · 专家角色"),
    (410, 604, 350, "报表双阶段编排 liveReport.ts", "查询计划 → 真实执行 → 摘要撰写 · 报告计划", "金额单位口径对齐 · 数据变化自动重生成"),
    (772, 604, 372, "导出服务", "pptxgenjs → PPTX（封面/KPI/图表/结论）", "ReportLab → PDF（矢量排版 · stdin JSON 管道）"),
]
for x, y, w, t1, t2, t3 in blrow1:
    cx = x + w // 2
    s(f'  <rect x="{x}" y="{y}" width="{w}" height="62" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+22}" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+40}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+54}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')

# BL Row 2
blrow2 = [
    (48, 676, 260, "Schema 圈表 schemaLinking.ts", "关键词粗排 + embedding 精排", "selectRelevantTablesAsync"),
    (320, 676, 260, "Schema 上下文 schemaContext.ts", "Scope 白名单 · 敏感列过滤", "5min 缓存 · 方言感知"),
    (592, 676, 260, "SQL 执行层 sqlExecutor.ts", "SELECT-only · node-sql-parser AST", "行级权限注入 · 超时 10s"),
    (864, 676, 280, "分析链 analysisChain.ts", "复杂度评估 · 启发式预门控", "中间表 ait_* 物化 · TTL 24h"),
]
for x, y, w, t1, t2, t3 in blrow2:
    cx = x + w // 2
    s(f'  <rect x="{x}" y="{y}" width="{w}" height="56" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+20}" font-size="12" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+38}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+50}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')

# BL Row 3
blrow3 = [
    (48, 742, 260, "知识库 knowledgeBase.ts", "切块+embedding+混合检索", "token 预算 · 口径/指南槽位", "#ffffff", "#d1d5db"),
    (320, 742, 260, "外部知识库 externalKnowledge.ts", "POST 检索 · Bearer 认证", "AES-256-GCM · 四容器容错", "#faf5ff", "#ddd6fe"),
    (592, 742, 260, "反馈闭环 queryFeedback.ts", "点赞 → auto_train 沉淀", "点踩 → 反面教材注入", "#ffffff", "#d1d5db"),
    (864, 742, 280, "对话历史 conversationHistory.ts", "服务端落库 · 跨设备共享", "个人 few-shot · 数据源隔离", "#ffffff", "#d1d5db"),
]
for x, y, w, t1, t2, t3, fill, stroke in blrow3:
    cx = x + w // 2
    s(f'  <rect x="{x}" y="{y}" width="{w}" height="56" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+20}" font-size="12" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+38}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+50}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')

# BL Row 4
blrow4 = [
    (48, 808, 200, "语义缓存 queryCache.ts", "等价归一化 · 10min", "模型/单位缓存键隔离"),
    (260, 808, 200, "语义指标 metrics.ts", "同义词匹配 · 口径注入", "filters 固定过滤"),
    (472, 808, 200, "技能库 skillLibrary.ts", "系统/个人 · 分享审核流", "占位符模板注入"),
    (684, 808, 200, "数据版本 dataVersion.ts", "指纹 sha1 · 10s 缓存", "自主更新触发 (v0.4.8+)"),
    (896, 808, 248, "推导留痕 queryTrace.ts", "全链路步骤埋点", "traceId 回放 · 本人/ADMIN"),
]
for x, y, w, t1, t2, t3 in blrow4:
    cx = x + w // 2
    t3c = "#ea580c" if "v0.4.8" in t3 else "#6b7280"
    s(f'  <rect x="{x}" y="{y}" width="{w}" height="56" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+20}" font-size="12" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+38}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+50}" font-size="10.5" fill="{t3c}" text-anchor="middle">{t3}</text>')

# BL Row 5
blrow5 = [
    (48, 874, 260, "queryPlan.ts 计划模式", "planId 10min 消费 · 一次性 · 409"),
    (320, 874, 260, "promptBudget.ts Token 预算", "知识 1200 · 历史 token 截断"),
    (592, 874, 260, "expertPersona.ts 专家角色", "财务/客户/风险/不良 → 金融分析师"),
    (864, 874, 280, "drill.ts 图表下钻", "AST 提取 FROM/JOIN/WHERE → SELECT *"),
]
for x, y, w, t1, t2 in blrow5:
    cx = x + w // 2
    s(f'  <rect x="{x}" y="{y}" width="{w}" height="48" rx="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1.2"/>')
    s(f'  <text x="{cx}" y="{y+19}" font-size="11.5" font-weight="500" fill="#374151" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+36}" font-size="10" fill="#6b7280" text-anchor="middle">{t2}</text>')

# BL bottom bar
s(f'  <rect x="48" y="930" width="1096" height="32" rx="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1.2"/>')
s(f'  <text x="596" y="950" font-size="10.5" fill="#6b7280" text-anchor="middle">auth.ts · db.ts · passwords.ts · secretsCrypto.ts · rateLimiter.ts · auditLog.ts · requestLogger.ts · scope.ts · schemaGuidance.ts · queryGuard.ts · queryHooks.ts · llmUsage.ts · seedData.ts · simulatedQuery.ts · simulatedReport.ts</text>')

# BL → AI arrows
s(f'  <line x1="400" y1="974" x2="400" y2="1000" stroke="#9333ea" stroke-width="1.5" marker-start="url(#ap)" marker-end="url(#ap)"/>')
s(f'  <line x1="800" y1="974" x2="800" y2="1000" stroke="#9333ea" stroke-width="1.5" marker-start="url(#ap)" marker-end="url(#ap)"/>')
s(f'  <text x="410" y="990" font-size="10.5" fill="#9333ea">LLM 调用 / 向量</text>')

# ===== Layer 5: AI Engine =====
s(f'  <rect x="36" y="1004" width="1128" height="120" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="52" y="1024" font-size="13" font-weight="600" fill="#374151">AI 引擎层（llmClient.ts · 引擎选择：用户自选 > AI_ENGINE > 密钥自动 > Ollama）</text>')

ai_items = [
    (48, 1034, 210, 76, "通义千问 Qwen", "百炼兼容端点 · qwen3.8-max", "Coding Plan 专属端点", "embedding: text-embedding-v4", "#faf5ff", "#ddd6fe"),
    (270, 1034, 210, 76, "Ollama 本地", "SQL: qwen3.8:27b / r1:32b", "解读: deepseek-r1:8b", "keep_alive=30m · 300s 超时", "#f0fdfa", "#99f6e4"),
    (492, 1034, 160, 76, "Gemini API", "备用引擎", "", "", "#faf5ff", "#ddd6fe"),
    (664, 1034, 200, 76, "Embedding 向量", "nomic-embed-text（本地）", "短 TTL 缓存 10min/256 条", "圈表 + 知识检索复用", "#fff7ed", "#fed7aa"),
    (876, 1034, 268, 76, "Python ReportLab 子进程", "spawn python3 · stdin JSON 管道", "stdout PDF · 60s 超时 SIGKILL", "A4 竖/横版 · CID 中文字体", "#fef2f2", "#fecaca"),
]
for x, y, w, h, t1, t2, t3, t4, fill, stroke in ai_items:
    cx = x + w // 2
    s(f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+22}" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+40}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    if t3: s(f'  <text x="{cx}" y="{y+54}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')
    if t4: s(f'  <text x="{cx}" y="{y+68}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t4}</text>')

# AI → Data arrows
s(f'  <line x1="300" y1="1124" x2="300" y2="1156" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <line x1="600" y1="1124" x2="600" y2="1156" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <line x1="900" y1="1124" x2="900" y2="1156" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <text x="310" y="1148" font-size="10.5" fill="#16a34a">元数据/留痕</text>')
s(f'  <text x="610" y="1148" font-size="10.5" fill="#16a34a">真实 SQL</text>')
s(f'  <text x="910" y="1148" font-size="10.5" fill="#16a34a">状态/外部</text>')

# ===== Layer 6: Data & Storage =====
s(f'  <rect x="36" y="1160" width="1128" height="200" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="52" y="1180" font-size="13" font-weight="600" fill="#374151">数据与存储层</text>')

def cyl(x, w, title, lines, fill, stroke, top_fill):
    cx = x + w // 2
    s(f'  <path d="M {x},1196 A {w//2},10 0 0 1 {x+w},1196 L {x+w},1280 A {w//2},10 0 0 1 {x},1280 Z" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <ellipse cx="{cx}" cy="1196" rx="{w//2}" ry="10" fill="{top_fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="1222" font-size="12" font-weight="600" fill="#111827" text-anchor="middle">{title}</text>')
    for i, ln in enumerate(lines):
        s(f'  <text x="{cx}" y="{1238 + i*14}" font-size="10" fill="#6b7280" text-anchor="middle">{ln}</text>')

cyl(48, 230, "应用库 MySQL smart_analytics", ["users/datasources/scope", "knowledge_chunks/sql_examples", "metrics/skills/audit_log", "query_trace/conversation_history", "report_templates/query_reports", "external_kb_sources/ait_*"], "#f0fdf4", "#86efac", "#dcfce7")
cyl(330, 220, "用户源数据库", ["MySQL 8 / PostgreSQL / Greenplum", "业务宽表 127万行 (94列)", "财务宽表 1139万行 (204列)", "20个月末快照", "CSV / API / JSON"], "#f0fdf4", "#86efac", "#dcfce7")
cyl(610, 160, "Redis / StateStore", ["限流计数 / 配额", "并发槽位互斥", "planId 消费", "多实例状态同步", "未配 → 进程内"], "#f0fdf4", "#86efac", "#dcfce7")
cyl(820, 200, "外部知识库服务", ["Dify / RAGFlow", "自建 RAG 网关", "POST {query, topK}", "Bearer Token 认证", "四容器响应容错"], "#faf5ff", "#ddd6fe", "#ede9fe")

# Eval box
s(f'  <rect x="1060" y="1196" width="92" height="100" rx="8" fill="#fffbeb" stroke="#fde68a" stroke-width="1.2"/>')
s(f'  <text x="1106" y="1218" font-size="11" font-weight="600" fill="#111827" text-anchor="middle">评测集</text>')
for i, t in enumerate(["server/eval", "19 用例", "差评回流", "evalCases", ".json"]):
    s(f'  <text x="1106" y="{1234 + i*14}" font-size="10" fill="#6b7280" text-anchor="middle">{t}</text>')

# Arrow to infra
s(f'  <line x1="600" y1="1360" x2="600" y2="1386" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#agray)"/>')

# ===== Layer 7: Infrastructure =====
s(f'  <rect x="36" y="1390" width="1128" height="130" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="52" y="1410" font-size="13" font-weight="600" fill="#374151">基础设施 / 部署</text>')

infra = [
    (48, 1420, 200, "Node.js 运行时", ["tsx 开发 · esbuild 打包", "dist/server.cjs 生产产物", "PORT 3000 · HOST 127.0.0.1", "Vite dev 中间件一体化"]),
    (260, 1420, 200, "Docker 容器", ["多阶段构建 · 非 root", "HEALTHCHECK 探活", "HOST=0.0.0.0 固定", "JWT_SECRET fail-fast"]),
    (472, 1420, 200, "测试体系", ["Vitest 54 文件 569 用例", "tsc 双配置 0 错误", "Playwright E2E", "eslint + 每次全量回归"]),
    (684, 1420, 200, "Git 双远程", ["origin: GitHub (HTTPS)", "gitee: Gitee (SSH)", "main 分支 · 禁止 force", "修改前 pull · 完成后双推"]),
    (896, 1420, 256, "文档即产品", ["系统功能说明书（单一事实源）", "系统内帮助实时读取", "变更记录 v0.1→v0.5.3 共 27 版", "OpenAPI · 培训 PPT · 宣讲材料"]),
]
for x, y, w, t1, lines in infra:
    cx = x + w // 2
    s(f'  <rect x="{x}" y="{y}" width="{w}" height="86" rx="8" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1.2"/>')
    s(f'  <text x="{cx}" y="{y+20}" font-size="12" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    for i, ln in enumerate(lines):
        s(f'  <text x="{cx}" y="{y+38 + i*14}" font-size="10.5" fill="#6b7280" text-anchor="middle">{ln}</text>')

# ===== Legend =====
ly = 1540
s(f'  <text x="52" y="{ly+20}" font-size="12" font-weight="600" fill="#374151">图例</text>')
legs = [
    (52, "#2563eb", "url(#ab)", "主流程 / 请求", None),
    (180, "#16a34a", "url(#ag)", "数据读写", None),
    (290, "#9333ea", "url(#ap)", "LLM 调用 / 向量", None),
    (430, "#6b7280", "url(#agray)", "基础设施", "4,3"),
    (540, "#ea580c", "url(#ao)", "v0.4.x+ 新增能力", None),
]
for x, color, marker, label, dash in legs:
    d = f' stroke-dasharray="{dash}"' if dash else ''
    s(f'  <line x1="{x}" y1="{ly+38}" x2="{x+30}" y2="{ly+38}" stroke="{color}" stroke-width="1.5"{d} marker-end="{marker}"/>')
    s(f'  <text x="{x+38}" y="{ly+42}" font-size="10.5" fill="#6b7280">{label}</text>')

s(f'  <text x="52" y="{ly+62}" font-size="10.5" fill="#9ca3af">架构分层：客户端 → 前端应用层 → API 安全网关（6 层纵深防御） → 业务逻辑层（19 路由 + 25 核心服务） → AI 引擎层（三引擎 + Python 子进程） → 数据与存储层（4 源 + 评测集） → 基础设施</text>')
s(f'  <text x="52" y="{ly+76}" font-size="10.5" fill="#9ca3af">v0.5.3 新增模块：灵活查询 · 问数报告中心 · 报告模板管理 · 数据变化自主更新 · 外部知识库 · 对话历史 · 个人 few-shot · 拒答契约 · 金额单位 · 规则化降级 · ReportLab PDF · 下钻 · 同/环比 · 多表 JOIN · 慢查询审计 · a11y</text>')

s('</svg>')

with open(OUT, 'w') as f:
    f.write('\n'.join(L))
print(f"✓ Generated: {OUT} ({len(L)} lines)")
