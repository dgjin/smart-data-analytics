#!/usr/bin/env python3
"""Generate 系统功能流程图 SVG using Python list method (fireworks-tech-graph Style 1)."""
import os

OUT = os.path.join(os.path.dirname(__file__), "系统功能流程图.svg")
W, H = 1120, 1320

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

# ---- Title ----
s(f'  <text x="40" y="36" font-size="19" font-weight="700" fill="#111827">智能问数分析系统 · 整体功能流程图</text>')
s(f'  <text x="40" y="56" font-size="11.5" fill="#6b7280">v0.9.46 · React 19 + Vite + Tailwind CSS 4 前端 · Express 4 服务端 · 大小模型分工 AI（Qwen / Ollama / Gemini）· 90 测试文件 1035 用例 · 112 REST 端点</text>')

# ---- User layer ----
s(f'  <circle cx="560" cy="84" r="10" fill="#ffffff" stroke="#111827" stroke-width="1.5"/>')
s(f'  <path d="M 544,110 Q 560,94 576,110" fill="none" stroke="#111827" stroke-width="1.5"/>')
s(f'  <text x="584" y="90" font-size="12.5" fill="#111827">用户</text>')
s(f'  <rect x="620" y="74" width="70" height="20" rx="4" fill="#eff6ff" stroke="#bfdbfe"/><text x="655" y="88" font-size="10" fill="#1e40af" text-anchor="middle">ADMIN</text>')
s(f'  <rect x="696" y="74" width="80" height="20" rx="4" fill="#eff6ff" stroke="#bfdbfe"/><text x="736" y="88" font-size="10" fill="#1e40af" text-anchor="middle">ANALYST</text>')
s(f'  <rect x="782" y="74" width="70" height="20" rx="4" fill="#eff6ff" stroke="#bfdbfe"/><text x="817" y="88" font-size="10" fill="#1e40af" text-anchor="middle">VIEWER</text>')
s(f'  <line x1="560" y1="114" x2="560" y2="136" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ---- Frontend layer container ----
s(f'  <rect x="36" y="140" width="1048" height="272" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="50" y="160" font-size="13" font-weight="600" fill="#374151">前端交互层（React 19 + Vite + Zustand + Tailwind CSS 4）· 左侧导航七大入口</text>')

mods1 = [
    (48, 170, "智能问数 QueryChat", "技能+ · 流式进度 · 推导回放", "专家角色 · 全屏深读 (v0.9.38)", "六重澄清 · 模型自选", "#9333ea", "ADMIN / ANALYST"),
    (318, 170, "灵活查询 FlexQueryBuilder", "拖拽定制 · 高级筛选双入口", "跨表 JOIN · HAVING · 透视", "1万/5万行 · 固化看板", "#9333ea", "ADMIN / ANALYST"),
    (588, 170, "可视化决策报表", "模板生成 · PPT · ReportLab PDF", "图表下钻 · 同/环比对比", "计划模式 · 批注评论", "#6b7280", "ALL"),
    (858, 170, "问数报告中心", "报告模式生成 · 卡片列表", "服务端保存 (v0.9.24)", "详情复用 · PDF / PPT 导出", "#9333ea", "ADMIN / ANALYST"),
]
for x, y, t1, t2, t3, t4, tc, tag in mods1:
    cx = x + 119
    s(f'  <rect x="{x}" y="{y}" width="238" height="86" rx="8" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+22}" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+40}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+54}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')
    s(f'  <text x="{cx}" y="{y+68}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t4}</text>')
    s(f'  <text x="{cx}" y="{y+80}" font-size="9" fill="{tc}" text-anchor="middle">{tag}</text>')

mods2 = [
    (48, 266, "决策数据看板", "图表固化 · 日常巡检 · 指标直查", "60s 轮询 · 数据变化自主更新", "全屏大屏 · 异步刷新 (v0.9.2+)", "#ea580c", "数据变化自主更新 (v0.4.8+)"),
    (318, 266, "数据源与 Schema", "多源接入 · 文件导入落库 (v0.9.34)", "数据血缘 · 行级权限 · 自省开关", "JSON / CSV / Excel / API", "#9333ea", "ADMIN"),
    (588, 266, "知识 · 技能 · 样例 · 铁律 · 指标", "本地 RAG · 外部知识库 · 技能分享审核", "SQL 样例 · 语义指标 · JSON 备份 (v0.9.33)", "铁律规则库 (v0.9.35) · 专家角色 (v0.9.40)", "#9333ea", "ADMIN（外部源配置）"),
    (858, 266, "系统管理（六大区块）", "基础管理 · 质量监控 · 规则治理", "权限审批 · AI 审核 · 系统配置", "Fallback 审核队列 · A/B 看板", "#9333ea", "ADMIN"),
]
for x, y, t1, t2, t3, t4, tc, tag in mods2:
    cx = x + 119
    s(f'  <rect x="{x}" y="{y}" width="238" height="86" rx="8" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+22}" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+40}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+54}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')
    s(f'  <text x="{cx}" y="{y+68}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t4}</text>')
    s(f'  <text x="{cx}" y="{y+80}" font-size="9" fill="{tc}" text-anchor="middle">{tag}</text>')

# Frontend → Gateway arrows
for x in [167, 437, 707, 977]:
    s(f'  <line x1="{x}" y1="352" x2="{x}" y2="398" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ---- API Gateway ----
s(f'  <rect x="36" y="402" width="1048" height="48" rx="8" fill="#fff7ed" stroke="#fdba74" stroke-width="1.5"/>')
s(f'  <text x="560" y="431" font-size="12" font-weight="500" fill="#111827" text-anchor="middle">API 安全网关 · L1 输入防护 → L2 RBAC 鉴权 → L3 Scope 白名单 / 敏感列过滤 / 行级权限 AST 注入 → L4 SELECT-only → L5 限流（速率+配额+并发） → L6 审计落账 + DLP 下载审计</text>')
s(f'  <line x1="560" y1="450" x2="560" y2="476" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ---- Analysis Engine ----
s(f'  <rect x="36" y="480" width="1048" height="428" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="50" y="500" font-size="13" font-weight="600" fill="#374151">智能分析引擎（Express / Node.js · tsx 开发 / esbuild 打包）</text>')

erow1 = [
    (48, 510, "问数编排 liveQuery", "双阶段流水线 · SSE 流式进度", "六重上下文 · 拒答契约 · 深度分析"),
    (318, 510, "Schema 圈表", "关键词粗排 + embedding 精排", "短 TTL 缓存 · 降级纯关键词"),
    (588, 510, "上下文并行构建（八源）", "few-shot · 本地/外部 RAG · 语义指标", "铁律 · 专家角色 · 反例 · 金额单位"),
    (858, 510, "复杂度预门控 / 清洗链", "启发式信号 · 中间表 ait_*", "物化应用库 · TTL 24h · 不阻断"),
]
for x, y, t1, t2, t3 in erow1:
    cx = x + 119
    s(f'  <rect x="{x}" y="{y}" width="238" height="62" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+23}" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+42}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+56}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')

erow2 = [
    (48, 584, "阶段一 SQL 生成", "铁律优先 · 专家角色 · 歧义澄清", "自省 · 金额单位 · 多候选择优"),
    (318, 584, "安全执行层", "SELECT-only · AST 双校验", "连接池 · 行级权限注入"),
    (588, 584, "阶段二数据解读", "真实 rows 回喂 · 小模型快速路由", "LLM 失败 → 规则化降级 · 中文兜底"),
    (858, 584, "Fallback 对抗训练 (v0.9.44)", "失败采集 → 人工审核 → 注入 Few-Shot", "三层自救 · 主动学习 · A/B 实验"),
]
for x, y, t1, t2, t3 in erow2:
    cx = x + 119
    isfb = "Fallback" in t1
    fill = "#fff7ed" if (isfb or "降级" in t3) else "#ffffff"
    stroke = "#fed7aa" if (isfb or "降级" in t3) else "#d1d5db"
    s(f'  <rect x="{x}" y="{y}" width="238" height="62" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+23}" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+42}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    t3c = "#ea580c" if (isfb or "降级" in t3) else "#6b7280"
    s(f'  <text x="{cx}" y="{y+56}" font-size="10.5" fill="{t3c}" text-anchor="middle">{t3}</text>')

# Engine Row 3: wide boxes
s(f'  <rect x="48" y="658" width="498" height="62" rx="8" fill="#f0fdfa" stroke="#99f6e4" stroke-width="1.5"/>')
s(f'  <text x="297" y="681" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">灵活查询构建器 FlexQueryBuilder</text>')
s(f'  <text x="297" y="700" font-size="10.5" fill="#6b7280" text-anchor="middle">客户端白名单校验 → 服务端 SELECT-only + 表白名单 + 敏感列 + 行级过滤（双道防线）</text>')
s(f'  <text x="297" y="714" font-size="10.5" fill="#6b7280" text-anchor="middle">多表 JOIN · 高级筛选双入口 (v0.9.37) · HAVING · 透视 · CSV · 全屏 · 固化看板</text>')

s(f'  <rect x="558" y="658" width="498" height="62" rx="8" fill="#fffbeb" stroke="#fde68a" stroke-width="1.5"/>')
s(f'  <text x="807" y="681" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">报表双阶段编排 liveReport + 异步任务 taskQueue</text>')
s(f'  <text x="807" y="700" font-size="10.5" fill="#6b7280" text-anchor="middle">查询计划 → 真实执行 → 摘要撰写 · 并行生成 (v0.9.11) · 报告/重算入队异步 (v0.9.2)</text>')
s(f'  <text x="807" y="714" font-size="10.5" fill="#6b7280" text-anchor="middle">PPT · PDF · 报告计划 · 服务端保存 (v0.9.19-24) · 数据变化自动重生成</text>')

# Engine Row 4: ops row
s(f'  <rect x="48" y="732" width="340" height="56" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>')
s(f'  <text x="218" y="754" font-size="12.5" font-weight="600" fill="#111827" text-anchor="middle">运行监控 monitoring (v0.9.14-18)</text>')
s(f'  <text x="218" y="772" font-size="10.5" fill="#6b7280" text-anchor="middle">可用性 · 成功率/耗时告警 · 缓存命中 · 监控仪表盘</text>')
s(f'  <rect x="398" y="732" width="340" height="56" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>')
s(f'  <text x="568" y="754" font-size="12.5" font-weight="600" fill="#111827" text-anchor="middle">漂移检测 driftDetector (v0.9.7-8)</text>')
s(f'  <text x="568" y="772" font-size="10.5" fill="#6b7280" text-anchor="middle">口径漂移识别 → 运营告警 → 反哺知识库</text>')
s(f'  <rect x="748" y="732" width="308" height="56" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>')
s(f'  <text x="902" y="754" font-size="12.5" font-weight="600" fill="#111827" text-anchor="middle">SSE 断线续传 (v0.9.6)</text>')
s(f'  <text x="902" y="772" font-size="10.5" fill="#6b7280" text-anchor="middle">sseReplayBuffer · 重连回放进度不丢失</text>')

# Engine bottom strip
s(f'  <rect x="48" y="798" width="1008" height="30" rx="6" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1"/>')
s(f'  <text x="552" y="818" font-size="10.5" fill="#6b7280" text-anchor="middle">queryCache 语义缓存 · queryTrace 全链路留痕 · queryPlan 计划模式 · drill 下钻 · fileDataSource 文件落库 · serverFallbacks 中文兜底 (v0.9.39-42)</text>')
s(f'  <rect x="48" y="834" width="1008" height="30" rx="6" fill="#f0fdf4" stroke="#bbf7d0" stroke-width="1"/>')
s(f'  <text x="552" y="854" font-size="10.5" fill="#166534" text-anchor="middle">知识注入优先级：铁律规则 > 语义指标 > 专家角色 > few-shot 样例 > 知识库 RAG · Fallback 审核入口：系统管理 → AI 审核（优先级排名 + 批量操作）</text>')
s(f'  <text x="560" y="892" font-size="11" fill="#374151" text-anchor="middle" font-weight="600">失败自愈闭环 (v0.9.44-46)：问数失败 → 自动采集 → 人工审核标注正确 SQL → 注入样例库 Few-Shot → 同类失败自动修正重试</text>')

# Engine → AI arrows
s(f'  <line x1="300" y1="908" x2="300" y2="940" stroke="#9333ea" stroke-width="1.5" marker-start="url(#ap)" marker-end="url(#ap)"/>')
s(f'  <line x1="820" y1="908" x2="820" y2="940" stroke="#9333ea" stroke-width="1.5" marker-start="url(#ap)" marker-end="url(#ap)"/>')
s(f'  <text x="310" y="930" font-size="10.5" fill="#9333ea">LLM 调用 / 向量</text>')

# ---- AI Engine Layer ----
s(f'  <rect x="36" y="944" width="1048" height="100" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="50" y="964" font-size="13" font-weight="600" fill="#374151">AI 引擎层（llmClient 统一通道 · 大小模型分工 v0.8 · 用户自选模型优先）</text>')
ai_engines = [
    (48, 974, 220, "通义千问 Qwen（大模型）", "百炼兼容端点 · SQL 生成主力", "", "#faf5ff", "#ddd6fe"),
    (280, 974, 220, "Ollama 本地（小模型）", "快速任务 · 解读 · 兜底", "keep_alive 30m", "#f0fdfa", "#99f6e4"),
    (512, 974, 180, "Gemini API", "备用引擎", "", "#faf5ff", "#ddd6fe"),
    (704, 974, 200, "Embedding", "nomic-embed-text · v4", "10min 缓存", "#fff7ed", "#fed7aa"),
    (916, 974, 140, "Python", "ReportLab PDF", "spawn 子进程", "#fef2f2", "#fecaca"),
]
for x, y, w, t1, t2, t3, fill, stroke in ai_engines:
    cx = x + w // 2
    s(f'  <rect x="{x}" y="{y}" width="{w}" height="56" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+22}" font-size="12" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+40}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    if t3:
        s(f'  <text x="{cx}" y="{y+52}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')

# AI → Storage arrows
s(f'  <line x1="200" y1="1044" x2="200" y2="1086" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <line x1="500" y1="1044" x2="500" y2="1086" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <line x1="800" y1="1044" x2="800" y2="1086" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <line x1="1000" y1="1044" x2="1000" y2="1086" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#agray)"/>')
s(f'  <text x="210" y="1070" font-size="10.5" fill="#16a34a">元数据/留痕</text>')
s(f'  <text x="510" y="1070" font-size="10.5" fill="#16a34a">真实 SQL 读写</text>')
s(f'  <text x="810" y="1070" font-size="10.5" fill="#16a34a">状态/缓存</text>')
s(f'  <text x="1004" y="1070" font-size="10.5" fill="#6b7280">PDF 子进程</text>')

# ---- Storage Layer ----
s(f'  <rect x="36" y="1090" width="1048" height="140" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="50" y="1110" font-size="13" font-weight="600" fill="#374151">存储层</text>')

def cylinder(x, w, title, lines, fill, stroke, top_fill):
    cx = x + w // 2
    s(f'  <path d="M {x},1124 A {w//2},10 0 0 1 {x+w},1124 L {x+w},1198 A {w//2},10 0 0 1 {x},1198 Z" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <ellipse cx="{cx}" cy="1124" rx="{w//2}" ry="10" fill="{top_fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="1150" font-size="12" font-weight="600" fill="#111827" text-anchor="middle">{title}</text>')
    for i, ln in enumerate(lines):
        s(f'  <text x="{cx}" y="{1166 + i*14}" font-size="10" fill="#6b7280" text-anchor="middle">{ln}</text>')

cylinder(48, 250, "应用库 MySQL smart_analytics", ["用户/数据源/知识/技能/指标/铁律", "对话历史/审计/trace/报告模板/专家角色", "fallback_samples/ab_experiments/saved_reports"], "#f0fdf4", "#86efac", "#dcfce7")
cylinder(330, 220, "用户源数据库", ["MySQL / PostgreSQL / Greenplum", "业务宽表 127 万 + 1139 万行", "CSV / Excel / JSON 文件落库"], "#f0fdf4", "#86efac", "#dcfce7")
cylinder(610, 160, "Redis / StateStore", ["限流 / 配额 / 任务队列状态", "SSE 续传缓冲 · 未配则进程内", ""], "#f0fdf4", "#86efac", "#dcfce7")
cylinder(820, 200, "外部知识库服务", ["Dify / RAGFlow / 自建网关", "POST 检索 · Bearer 认证", "API Key AES-256-GCM"], "#faf5ff", "#ddd6fe", "#ede9fe")

# Trace 旁路
s(f'  <path d="M 48,760 L 20,760 L 20,1154 L 46,1154" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="4,3" fill="none" marker-end="url(#agray)"/>')
s(f'  <text x="14" y="960" font-size="10.5" fill="#6b7280" transform="rotate(-90 14 960)" text-anchor="middle">query_trace / 审计 / DLP 旁路落库</text>')

# 结果回前端
s(f'  <path d="M 1068,690 L 1112,690 L 1112,156 L 977,156 L 977,168" stroke="#9333ea" stroke-width="1.5" fill="none" marker-end="url(#ap)"/>')
s(f'  <text x="1096" y="440" font-size="10.5" fill="#9333ea" transform="rotate(-90 1096 440)" text-anchor="middle">图表 / KPI / 洞察 / 报告 / 追问 / 异步任务进度</text>')

# 数据变化回看板
s(f'  <path d="M 1068,1130 L 1112,1130 L 1112,261 L 167,261 L 167,264" stroke="#ea580c" stroke-width="1.5" stroke-dasharray="5,3" fill="none" marker-end="url(#ao)"/>')
s(f'  <text x="1096" y="700" font-size="10.5" fill="#ea580c" transform="rotate(-90 1096 700)" text-anchor="middle">数据变化 → 自主更新看板/报表</text>')

# ---- Legend ----
ly = 1268
s(f'  <line x1="40" y1="{ly}" x2="70" y2="{ly}" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')
s(f'  <text x="78" y="{ly+4}" font-size="11.5" fill="#6b7280">主流程 / 请求</text>')
s(f'  <line x1="168" y1="{ly}" x2="198" y2="{ly}" stroke="#16a34a" stroke-width="1.5" marker-end="url(#ag)"/>')
s(f'  <text x="206" y="{ly+4}" font-size="11.5" fill="#6b7280">数据读写</text>')
s(f'  <line x1="276" y1="{ly}" x2="306" y2="{ly}" stroke="#9333ea" stroke-width="1.5" marker-end="url(#ap)"/>')
s(f'  <text x="314" y="{ly+4}" font-size="11.5" fill="#6b7280">LLM 调用 / 结果返回</text>')
s(f'  <line x1="436" y1="{ly}" x2="466" y2="{ly}" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#agray)"/>')
s(f'  <text x="474" y="{ly+4}" font-size="11.5" fill="#6b7280">留痕 / 回放</text>')
s(f'  <line x1="556" y1="{ly}" x2="586" y2="{ly}" stroke="#ea580c" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#ao)"/>')
s(f'  <text x="594" y="{ly+4}" font-size="11.5" fill="#6b7280">数据变化自主更新</text>')
s(f'  <text x="1068" y="{ly+4}" font-size="10.5" fill="#9ca3af" text-anchor="end">v0.9.46 · 2026-09-10 · 紫色标签 = 权限受限 · 橙色 = v0.6+ 新增能力</text>')
s(f'  <text x="40" y="{ly+26}" font-size="10.5" fill="#9ca3af">相比 v0.5.3 旧图新增：铁律规则库 · 专家角色库 · Fallback 对抗训练闭环 · 异步任务 · SSE 断线续传 · 漂移检测 · 并行生成 · 运行监控 · 报表服务端保存 · JSON 备份 · 文件数据源落库 · 高级筛选双入口 · 结果全屏 · 中文强制兜底 · 大小模型分工</text>')

s('</svg>')

with open(OUT, 'w') as f:
    f.write('\n'.join(L))
print(f"OK Generated: {OUT} ({len(L)} lines)")
