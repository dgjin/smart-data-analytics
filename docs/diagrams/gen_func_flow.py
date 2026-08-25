#!/usr/bin/env python3
"""Generate 系统功能流程图 SVG using Python list method (fireworks-tech-graph Style 1)."""
import os

OUT = os.path.join(os.path.dirname(__file__), "系统功能流程图.svg")
W, H = 1120, 1240

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
s(f'  <text x="40" y="56" font-size="11.5" fill="#6b7280">v0.5.3 · React 19 + Vite + Tailwind CSS 4 前端 · Express 4 服务端 · 三引擎 AI（Ollama / 通义千问 / Gemini）· 54 测试文件 569 用例</text>')

# ---- User layer ----
s(f'  <circle cx="560" cy="84" r="10" fill="#ffffff" stroke="#111827" stroke-width="1.5"/>')
s(f'  <path d="M 544,110 Q 560,94 576,110" fill="none" stroke="#111827" stroke-width="1.5"/>')
s(f'  <text x="584" y="90" font-size="12.5" fill="#111827">用户</text>')
s(f'  <rect x="620" y="74" width="70" height="20" rx="4" fill="#eff6ff" stroke="#bfdbfe"/><text x="655" y="88" font-size="10" fill="#1e40af" text-anchor="middle">ADMIN</text>')
s(f'  <rect x="696" y="74" width="80" height="20" rx="4" fill="#eff6ff" stroke="#bfdbfe"/><text x="736" y="88" font-size="10" fill="#1e40af" text-anchor="middle">ANALYST</text>')
s(f'  <rect x="782" y="74" width="70" height="20" rx="4" fill="#eff6ff" stroke="#bfdbfe"/><text x="817" y="88" font-size="10" fill="#1e40af" text-anchor="middle">VIEWER</text>')
s(f'  <line x1="560" y1="114" x2="560" y2="136" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ---- Frontend layer container ----
s(f'  <rect x="36" y="140" width="1048" height="270" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="50" y="160" font-size="13" font-weight="600" fill="#374151">前端交互层（React 19 + Vite + Zustand + Tailwind CSS 4）</text>')

# Row 1 modules
mods1 = [
    (48, 170, "智能问数 QueryChat", "技能+ · 流式进度 · 推导回放", "计划/报告/深度分析 · 模型自选", "金额单位 · 拒答 · 历史对话", "#9333ea", "ADMIN / ANALYST"),
    (318, 170, "灵活查询 FlexQueryBuilder", "拖拽定制 · 多表 JOIN · 透视", "去重计数 · HAVING · CSV 导出", "全屏 · 固化看板 · 历史还原", "#9333ea", "ADMIN / ANALYST · v0.4.9+"),
    (588, 170, "可视化决策报表", "模板生成 · PPT · ReportLab PDF", "图表下钻 · 同/环比对比", "计划模式 · 批注评论", "#6b7280", "ALL"),
    (858, 170, "问数报告中心", "报告模式生成 · 卡片列表", "详情复用 · PDF / PPT 导出", "模板管理 · 预设 + 自定义", "#9333ea", "ADMIN / ANALYST · v0.5.0+"),
]
for x, y, t1, t2, t3, t4, tc, tag in mods1:
    cx = x + 119
    s(f'  <rect x="{x}" y="{y}" width="238" height="86" rx="8" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+22}" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+40}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+54}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')
    s(f'  <text x="{cx}" y="{y+68}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t4}</text>')
    s(f'  <text x="{cx}" y="{y+80}" font-size="9" fill="{tc}" text-anchor="middle">{tag}</text>')

# Row 2 modules
mods2 = [
    (48, 266, "决策数据看板", "图表固化 · 日常巡检", "60s 轮询 · 自动重放", "", "#ea580c", "数据变化自主更新 (v0.4.8+)", "#6b7280", "ALL"),
    (318, 266, "数据源与 Schema", "多源接入 · Schema 查看", "数据血缘 · 行级权限", "自省开关 · 快速问题", "#9333ea", "ADMIN", "", ""),
    (588, 266, "知识 · 技能 · 样例", "本地 RAG · 外部知识库", "技能库（分享-审核流）", "SQL 样例 · 语义指标", "#9333ea", "ADMIN（外部源配置）", "", ""),
    (858, 266, "系统管理", "用户角色 · RBAC 三级", "Token 用量 · 模型汇总", "报告模板管理", "#9333ea", "ADMIN", "", ""),
]
for x, y, t1, t2, t3, t4, tc, tag, sc, stag in mods2:
    cx = x + 119
    s(f'  <rect x="{x}" y="{y}" width="238" height="86" rx="8" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+22}" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+40}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+54}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')
    s(f'  <text x="{cx}" y="{y+68}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t4}</text>')
    s(f'  <text x="{cx}" y="{y+80}" font-size="9" fill="{tc}" text-anchor="middle">{tag}</text>')

# Frontend → Gateway arrows
s(f'  <line x1="167" y1="352" x2="167" y2="398" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')
s(f'  <line x1="437" y1="352" x2="437" y2="398" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')
s(f'  <line x1="707" y1="352" x2="707" y2="398" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')
s(f'  <line x1="977" y1="352" x2="977" y2="398" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ---- API Gateway ----
s(f'  <rect x="36" y="402" width="1048" height="48" rx="8" fill="#fff7ed" stroke="#fdba74" stroke-width="1.5"/>')
s(f'  <text x="560" y="431" font-size="12" font-weight="500" fill="#111827" text-anchor="middle">API 安全网关 · L1 输入防护（截断+注入检测） → L2 RBAC 鉴权 → L3 Scope 白名单 / 敏感列过滤 / 行级权限 AST 注入 → L4 SELECT-only 只读执行 → L5 限流（速率+配额+并发互斥） → L6 审计落账（八态）</text>')

s(f'  <line x1="560" y1="450" x2="560" y2="476" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')

# ---- Analysis Engine ----
s(f'  <rect x="36" y="480" width="1048" height="280" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="50" y="500" font-size="13" font-weight="600" fill="#374151">智能分析引擎（Express / Node.js · tsx 开发 / esbuild 打包）</text>')

# Engine Row 1
erow1 = [
    (48, 510, "问数编排 liveQuery", "双阶段流水线 · SSE 流式进度", "计划模式 · 报告模式 · 拒答契约"),
    (318, 510, "Schema 圈表", "关键词粗排 + embedding 精排", "短 TTL 缓存 · 降级纯关键词"),
    (588, 510, "上下文并行构建", "few-shot(团队+个人) · 本地 RAG", "外部知识 RAG · 语义指标 · 反例"),
    (858, 510, "复杂度预门控 / 清洗链", "启发式信号 · 中间表 ait_*", "物化应用库 · TTL 24h · 失败不阻断"),
]
for x, y, t1, t2, t3 in erow1:
    cx = x + 119
    s(f'  <rect x="{x}" y="{y}" width="238" height="62" rx="8" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+23}" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+42}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="{y+56}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')

# Engine Row 2
erow2 = [
    (48, 584, "阶段一 SQL 生成", "专家角色 · 歧义澄清 · 自省", "金额单位约定 · 多候选择优"),
    (318, 584, "安全执行层", "SELECT-only · node-sql-parser", "行级权限 AST 注入 · ait_* 应用库"),
    (588, 584, "阶段二数据解读", "真实 rows 回喂 LLM · 快速路由", "LLM 失败 → 规则化降级解读"),
    (858, 584, "缓存 / 留痕 / 反馈闭环", "语义缓存 10min · query_trace", "点赞→auto_train · 点踩→反例"),
]
for x, y, t1, t2, t3 in erow2:
    cx = x + 119
    fill = "#fff7ed" if "降级" in t3 else "#ffffff"
    stroke = "#fed7aa" if "降级" in t3 else "#d1d5db"
    s(f'  <rect x="{x}" y="{y}" width="238" height="62" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+23}" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+42}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    t3c = "#ea580c" if "降级" in t3 else "#6b7280"
    s(f'  <text x="{cx}" y="{y+56}" font-size="10.5" fill="{t3c}" text-anchor="middle">{t3}</text>')

# Engine Row 3: wide boxes
s(f'  <rect x="48" y="658" width="498" height="62" rx="8" fill="#f0fdfa" stroke="#99f6e4" stroke-width="1.5"/>')
s(f'  <text x="297" y="681" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">灵活查询构建器 FlexQueryBuilder</text>')
s(f'  <text x="297" y="700" font-size="10.5" fill="#6b7280" text-anchor="middle">客户端纯函数白名单校验 → 服务端 SELECT-only + 表白名单 + 敏感列 + 行级过滤（双道防线）</text>')
s(f'  <text x="297" y="714" font-size="10.5" fill="#6b7280" text-anchor="middle">多表 JOIN · 去重计数 · HAVING · BETWEEN · 透视 · CSV · 全屏 · 固化看板 · 历史还原</text>')

s(f'  <rect x="558" y="658" width="498" height="62" rx="8" fill="#fffbeb" stroke="#fde68a" stroke-width="1.5"/>')
s(f'  <text x="807" y="681" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">报表双阶段编排 liveReport</text>')
s(f'  <text x="807" y="700" font-size="10.5" fill="#6b7280" text-anchor="middle">查询计划 → 真实执行 → 真实数据摘要撰写 · 金额单位口径对齐</text>')
s(f'  <text x="807" y="714" font-size="10.5" fill="#6b7280" text-anchor="middle">PPT (pptxgenjs) · PDF (ReportLab 矢量排版) · 报告计划模式 · 数据变化自动重生成</text>')

# Engine → AI arrows
s(f'  <line x1="300" y1="740" x2="300" y2="772" stroke="#9333ea" stroke-width="1.5" marker-start="url(#ap)" marker-end="url(#ap)"/>')
s(f'  <line x1="820" y1="740" x2="820" y2="772" stroke="#9333ea" stroke-width="1.5" marker-start="url(#ap)" marker-end="url(#ap)"/>')
s(f'  <text x="310" y="762" font-size="10.5" fill="#9333ea">LLM 调用 / 向量</text>')

# ---- AI Engine Layer ----
s(f'  <rect x="36" y="776" width="1048" height="100" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="50" y="796" font-size="13" font-weight="600" fill="#374151">AI 引擎层（llmClient 统一通道 · 阶段级模型路由 · 用户自选模型优先）</text>')

ai_engines = [
    (48, 806, 220, "通义千问 Qwen", "百炼兼容端点 · qwen3.8-max", "Coding Plan 专属端点", "#faf5ff", "#ddd6fe"),
    (280, 806, 220, "Ollama 本地（双模型）", "SQL: qwen3.8:27b / r1:32b", "解读: deepseek-r1:8b · keep_alive 30m", "#f0fdfa", "#99f6e4"),
    (512, 806, 180, "Gemini API", "备用引擎", "", "#faf5ff", "#ddd6fe"),
    (704, 806, 200, "Embedding", "nomic-embed-text · text-embedding-v4", "10min 缓存", "#fff7ed", "#fed7aa"),
    (916, 806, 140, "Python", "ReportLab PDF", "spawn 子进程", "#fef2f2", "#fecaca"),
]
for x, y, w, t1, t2, t3, fill, stroke in ai_engines:
    cx = x + w // 2
    s(f'  <rect x="{x}" y="{y}" width="{w}" height="56" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y+22}" font-size="12.5" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="{y+40}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    if t3:
        s(f'  <text x="{cx}" y="{y+52}" font-size="10.5" fill="#6b7280" text-anchor="middle">{t3}</text>')

# AI → Storage arrows
s(f'  <line x1="200" y1="876" x2="200" y2="918" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <line x1="500" y1="876" x2="500" y2="918" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <line x1="800" y1="876" x2="800" y2="918" stroke="#16a34a" stroke-width="1.5" marker-start="url(#ag)" marker-end="url(#ag)"/>')
s(f'  <line x1="1000" y1="876" x2="1000" y2="918" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#agray)"/>')
s(f'  <text x="210" y="902" font-size="10.5" fill="#16a34a">元数据/留痕</text>')
s(f'  <text x="510" y="902" font-size="10.5" fill="#16a34a">真实 SQL 读写</text>')
s(f'  <text x="810" y="902" font-size="10.5" fill="#16a34a">状态/缓存</text>')
s(f'  <text x="1004" y="902" font-size="10.5" fill="#6b7280">PDF 子进程</text>')

# ---- Storage Layer ----
s(f'  <rect x="36" y="922" width="1048" height="140" rx="10" fill="none" stroke="#9ca3af" stroke-width="1.2" stroke-dasharray="6,4"/>')
s(f'  <text x="50" y="942" font-size="13" font-weight="600" fill="#374151">存储层</text>')

# Cylinder helper
def cylinder(x, w, title, lines, fill, stroke, top_fill):
    cx = x + w // 2
    s(f'  <path d="M {x},956 A {w//2},10 0 0 1 {x+w},956 L {x+w},1030 A {w//2},10 0 0 1 {x},1030 Z" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <ellipse cx="{cx}" cy="956" rx="{w//2}" ry="10" fill="{top_fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="982" font-size="12" font-weight="600" fill="#111827" text-anchor="middle">{title}</text>')
    for i, ln in enumerate(lines):
        s(f'  <text x="{cx}" y="{998 + i*14}" font-size="10" fill="#6b7280" text-anchor="middle">{ln}</text>')

cylinder(48, 230, "应用库 MySQL smart_analytics", ["用户/数据源/知识/技能/指标", "对话历史/审计/trace/报告模板", "query_reports/外部知识源/ait_*"], "#f0fdf4", "#86efac", "#dcfce7")
cylinder(330, 220, "用户源数据库", ["MySQL / PostgreSQL / Greenplum", "业务宽表 127 万 + 1139 万行", "CSV / API / JSON 数据源"], "#f0fdf4", "#86efac", "#dcfce7")
cylinder(610, 160, "Redis / StateStore", ["限流 / 配额 / 缓存状态", "计划 10min 消费（可选）", "未配则进程内存储"], "#f0fdf4", "#86efac", "#dcfce7")
cylinder(820, 200, "外部知识库服务", ["Dify / RAGFlow / 自建网关", "POST 检索 · Bearer 认证", "API Key AES-256-GCM 加密"], "#faf5ff", "#ddd6fe", "#ede9fe")

# Trace 旁路
s(f'  <path d="M 48,724 L 20,724 L 20,986 L 46,986" stroke="#6b7280" stroke-width="1.5" stroke-dasharray="4,3" fill="none" marker-end="url(#agray)"/>')
s(f'  <text x="14" y="856" font-size="10.5" fill="#6b7280" transform="rotate(-90 14 856)" text-anchor="middle">query_trace / 审计旁路落库</text>')

# 结果回前端
s(f'  <path d="M 1068,690 L 1112,690 L 1112,156 L 977,156 L 977,168" stroke="#9333ea" stroke-width="1.5" fill="none" marker-end="url(#ap)"/>')
s(f'  <text x="1096" y="460" font-size="10.5" fill="#9333ea" transform="rotate(-90 1096 460)" text-anchor="middle">图表 / KPI / 洞察 / 报告 / 追问</text>')

# 数据变化回看板
s(f'  <path d="M 1068,960 L 1112,960 L 1112,261 L 167,261 L 167,264" stroke="#ea580c" stroke-width="1.5" stroke-dasharray="5,3" fill="none" marker-end="url(#ao)"/>')
s(f'  <text x="1088" y="650" font-size="10.5" fill="#ea580c" transform="rotate(-90 1088 650)" text-anchor="middle">数据变化 → 自主更新看板/报表</text>')

# ---- Legend ----
ly = 1100
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
s(f'  <text x="1068" y="{ly+4}" font-size="10.5" fill="#9ca3af" text-anchor="end">v0.5.3 · 2026-08-21 · 紫色标签 = 权限受限 · 橙色 = v0.4.x+ 新增能力</text>')

s(f'  <text x="40" y="{ly+26}" font-size="10.5" fill="#9ca3af">相比 v0.3.7 旧图新增：灵活查询模块、报告模式、问数报告中心、报告模板管理、数据变化自主更新、拒答契约、金额单位自选、外部知识库接入、对话历史落库、个人 few-shot 沉淀、规则化降级解读、ReportLab PDF 导出、图表下钻、同/环比对比</text>')

s('</svg>')

with open(OUT, 'w') as f:
    f.write('\n'.join(L))
print(f"✓ Generated: {OUT} ({len(L)} lines)")
