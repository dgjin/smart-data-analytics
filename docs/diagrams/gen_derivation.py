#!/usr/bin/env python3
"""Generate 智能问数推导过程图 SVG using Python list method (fireworks-tech-graph Style 1)."""
import os

OUT = os.path.join(os.path.dirname(__file__), "智能问数推导过程图.svg")
W, H = 1040, 1440

L = []
def s(t): L.append(t)

s(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')
s('  <style>text { font-family: "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", "SimHei", sans-serif; }</style>')
s('  <defs>')
s('    <marker id="ab" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#2563eb"/></marker>')
s('    <marker id="ag" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#16a34a"/></marker>')
s('    <marker id="ap" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#9333ea"/></marker>')
s('    <marker id="ar" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#dc2626"/></marker>')
s('    <marker id="agray" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#6b7280"/></marker>')
s('    <marker id="ao" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ea580c"/></marker>')
s('  </defs>')
s(f'  <rect width="{W}" height="{H}" fill="#ffffff"/>')

# Title
s(f'  <text x="40" y="36" font-size="19" font-weight="700" fill="#111827">智能问数 · 详细推导过程（NL2SQL 双阶段流水线）</text>')
s(f'  <text x="40" y="56" font-size="11.5" fill="#6b7280">v0.5.3 · 同题实测 105s→68s · 重复提问命中缓存秒回 · 全链路 query_trace 留痕 · 拒答/澄清/自省四契约</text>')

def box(x, y, w, h, t1, t2, fill="#ffffff", stroke="#d1d5db", fs1=13, fs2=11):
    cx = x + w // 2
    s(f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{y + h//2 - (8 if t2 else 0)}" font-size="{fs1}" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    if t2:
        s(f'  <text x="{cx}" y="{y + h//2 + 10}" font-size="{fs2}" fill="#6b7280" text-anchor="middle">{t2}</text>')

def diamond(cx, cy, hw, hh, label):
    s(f'  <polygon points="{cx},{cy-hh} {cx+hw},{cy} {cx},{cy+hh} {cx-hw},{cy}" fill="#ffffff" stroke="#d1d5db" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="{cy+5}" font-size="13" font-weight="600" fill="#111827" text-anchor="middle">{label}</text>')

def arrow(x1, y1, x2, y2, color="#2563eb", marker="url(#ab)", dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    s(f'  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="1.5"{d} marker-end="{marker}"/>')

# Step 0: User question
box(360, 72, 280, 42, "用户自然语言提问", None, "#eff6ff", "#bfdbfe")
arrow(500, 114, 500, 140)

# Step 1: Input security
box(300, 144, 400, 48, "输入防护与安全校验", "L1 注入过滤 · 500字截断 · L2 RBAC · L5 限流（速率+配额+并发互斥）", "#fff7ed", "#fdba74", 13, 11)
arrow(500, 192, 500, 218)

# Step 2: Lifecycle hook
box(340, 222, 320, 38, "生命周期钩子 emitBeforeQuery · trace 记录开始", None, "#f9fafb", "#e5e7eb", 12, 11)
arrow(500, 260, 500, 286)

# Step 3: Schema context
box(300, 290, 400, 48, "Schema 上下文加载", "落库 schema → scope 白名单 → 敏感列过滤 → 5min 缓存")
arrow(500, 338, 500, 361)

# Step 4: Cache decision
diamond(500, 396, 125, 33, "语义缓存命中？")
arrow(628, 396, 702, 396, "#16a34a", "url(#ag)")
s(f'  <text x="636" y="388" font-size="11" fill="#16a34a">命中</text>')
box(706, 374, 250, 44, "秒回：复用成功结果（CACHE）", None, "#f0fdf4", "#86efac")
arrow(500, 432, 500, 458, "#2563eb", "url(#ab)")
s(f'  <text x="512" y="450" font-size="11" fill="#6b7280">未命中</text>')

# Step 5: Schema linking
box(300, 462, 400, 48, "Schema 圈表（Schema Linking）", "关键词粗排 + embedding 精排 · 问题向量缓存复用 · 降级纯关键词")
arrow(500, 510, 500, 538)

# Step 6: Parallel context (6 paths)
s(f'  <line x1="106" y1="542" x2="894" y2="542" stroke="#2563eb" stroke-width="1.5"/>')
s(f'  <text x="500" y="534" font-size="11" fill="#2563eb" text-anchor="middle">Promise.all 并行上下文构建（六路并发，各自失败降级不阻断）</text>')
s(f'  <line x1="500" y1="538" x2="500" y2="542" stroke="#2563eb" stroke-width="1.5"/>')

contexts = [
    (44, "Few-shot 样例", "团队库 top-3 · DAIL-SQL", "个人沉淀（v0.4.0+）", "#eff6ff", "#bfdbfe", "#9333ea"),
    (204, "本地知识库 RAG", "TOP4 · token 预算截断", "口径/指南保留槽位", "#eff6ff", "#bfdbfe", "#6b7280"),
    (364, "外部知识库 RAG", "Dify/RAGFlow/自建", "独立 1200 token · 降级空", "#faf5ff", "#ddd6fe", "#9333ea"),
    (524, "语义指标层", "指标名/同义词命中", "权威口径模板 · filters", "#eff6ff", "#bfdbfe", "#6b7280"),
    (684, "点踩反例", "反面教材注入", "避免重复同类错误", "#fef2f2", "#fecaca", "#9333ea"),
    (844, "金额单位约定", "亿/百万/万/元", "SQL 除法 + ROUND(2)", "#fffbeb", "#fde68a", "#9333ea"),
]
for x, t1, t2, t3, fill, stroke, tc in contexts:
    cx = x + 82
    s(f'  <line x1="{cx}" y1="542" x2="{cx}" y2="560" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')
    s(f'  <rect x="{x}" y="564" width="164" height="72" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="586" font-size="12" font-weight="600" fill="#111827" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="602" font-size="10.5" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="616" font-size="10.5" fill="{tc}" text-anchor="middle">{t3}</text>')

# Merge lines
for cx in [126, 286, 446, 606, 766, 926]:
    s(f'  <line x1="{cx}" y1="636" x2="{cx}" y2="660" stroke="#2563eb" stroke-width="1.5"/>')
s(f'  <line x1="126" y1="660" x2="926" y2="660" stroke="#2563eb" stroke-width="1.5"/>')
arrow(500, 660, 500, 683)

# Trace record
s(f'  <rect x="620" y="640" width="280" height="30" rx="6" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1"/>')
s(f'  <text x="760" y="660" font-size="10.5" fill="#6b7280" text-anchor="middle">trace: 知识片段 N 字 · 外部 N 源 · few-shot N 组 · 反例 N 组</text>')

# Step 7: Complexity decision
diamond(500, 718, 120, 33, "清洗信号 / 深度分析？")
arrow(377, 718, 336, 718, "#9333ea", "url(#ap)")
s(f'  <text x="342" y="710" font-size="11" fill="#9333ea">有信号</text>')
box(80, 696, 252, 44, "LLM 复杂度评估 → 清洗链", "最多 3 步 · 中间表 ait_* 物化应用库", "#faf5ff", "#ddd6fe", 13, 10.5)
s(f'  <path d="M 206,740 L 206,776 L 380,776 L 380,792" stroke="#9333ea" stroke-width="1.5" fill="none" marker-end="url(#ap)"/>')
arrow(500, 754, 500, 790)
s(f'  <text x="512" y="775" font-size="11" fill="#6b7280">无信号：直接判 simple（省 ~7s）</text>')

# Step 8: Stage 1 SQL generation
box(300, 794, 400, 48, "阶段一：LLM 生成 SQL（专家角色 · 用户自选模型优先）", "金额单位约定注入首位 · few-shot 消息对 · 多候选择优投票")
arrow(500, 842, 500, 870)
s(f'  <text x="500" y="864" font-size="11.5" fill="#374151" text-anchor="middle" font-weight="600">阶段一输出四契约（仅首次首候选接受澄清/拒答/自省）</text>')

# Four contracts
contracts = [
    (36, "拒答 refuse", "Schema 无语义相近表/字段", "v0.4.7+ · 如实反馈不托底", "#fef2f2", "#fecaca", "#dc2626"),
    (256, "歧义澄清 clarify", "多候选字段 → 用户确认", "2-4 选项 · 改写后重提交", "#fffbeb", "#fde68a", "#92400e"),
    (476, "数据自省 introspect", "探查 SQL → 取值回喂", "仅一轮 · 防递归", "#f0fdfa", "#99f6e4", "#115e59"),
    (696, "直接生成 SQL", "JSON 契约: sql + 图表配置", "thoughtProcess · columnNames", "#eff6ff", "#bfdbfe", "#1e40af"),
]
for x, t1, t2, t3, fill, stroke, tc in contracts:
    cx = x + 100
    s(f'  <rect x="{x}" y="880" width="200" height="50" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>')
    s(f'  <text x="{cx}" y="900" font-size="12.5" font-weight="600" fill="{tc}" text-anchor="middle">{t1}</text>')
    s(f'  <text x="{cx}" y="916" font-size="10" fill="#6b7280" text-anchor="middle">{t2}</text>')
    s(f'  <text x="{cx}" y="928" font-size="10" fill="#6b7280" text-anchor="middle">{t3}</text>')

# Arrows to 4 branches
arrow(350, 870, 136, 876, "#dc2626", "url(#ar)")
s(f'  <line x1="430" y1="870" x2="356" y2="876" stroke="#92400e" stroke-width="1.5"/>')
s(f'  <line x1="560" y1="870" x2="576" y2="876" stroke="#115e59" stroke-width="1.5"/>')
arrow(650, 870, 796, 876)

# Refuse → end
s(f'  <path d="M 136,930 L 136,960 L 40,960" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5,3" fill="none"/>')
s(f'  <rect x="36" y="948" width="100" height="24" rx="6" fill="#fef2f2" stroke="#fecaca" stroke-width="1"/>')
s(f'  <text x="86" y="964" font-size="10.5" fill="#dc2626" text-anchor="middle">审计 REFUSED → 返回</text>')

# Clarify → front
s(f'  <path d="M 356,930 L 356,962 L 280,962" stroke="#92400e" stroke-width="1.5" stroke-dasharray="5,3" fill="none"/>')
s(f'  <rect x="256" y="948" width="110" height="24" rx="6" fill="#fffbeb" stroke="#fde68a" stroke-width="1"/>')
s(f'  <text x="311" y="964" font-size="10.5" fill="#92400e" text-anchor="middle">审计 CLARIFY → 前端</text>')

# Introspect → feed back
s(f'  <path d="M 576,930 L 576,940 L 246,940 L 246,818 L 298,818" stroke="#115e59" stroke-width="1.5" stroke-dasharray="5,3" fill="none" marker-end="url(#ag)"/>')
s(f'  <text x="350" y="936" font-size="10" fill="#115e59">取值回喂</text>')

# Direct SQL → execute
s(f'  <line x1="796" y1="930" x2="796" y2="970" stroke="#2563eb" stroke-width="1.5"/>')
s(f'  <line x1="796" y1="970" x2="500" y2="970" stroke="#2563eb" stroke-width="1.5"/>')
arrow(500, 970, 500, 996)

# Step 10: Safe execution
box(280, 1000, 440, 56, "安全执行层 executeSafeSql", "SELECT-only 白名单 · node-sql-parser AST 双校验 · 行级权限 AST 强制注入（fail-closed） · ait_* 改应用库执行")
arrow(500, 1056, 500, 1082)

# Step 11: Execute success?
diamond(500, 1116, 120, 33, "校验并执行成功？")
arrow(377, 1116, 336, 1116, "#dc2626", "url(#ar)")
s(f'  <text x="342" y="1108" font-size="11" fill="#dc2626">失败</text>')
box(80, 1094, 252, 44, "自纠错重试", "错误信息回喂 LLM · 多候选择优（≤2 次）", "#fef2f2", "#fecaca")
s(f'  <path d="M 140,1094 L 140,1016 L 280,1016" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5,3" fill="none" marker-end="url(#ar)"/>')
s(f'  <text x="152" y="1008" font-size="10.5" fill="#dc2626">重试</text>')

arrow(500, 1152, 500, 1178)
s(f'  <text x="512" y="1170" font-size="11" fill="#6b7280">成功</text>')

# Step 12: Empty result?
diamond(500, 1212, 115, 33, "空结果集？")
arrow(618, 1212, 702, 1212, "#16a34a", "url(#ag)")
s(f'  <text x="626" y="1204" font-size="11" fill="#16a34a">是</text>')
box(706, 1190, 250, 44, "直接返回真实结论（跳过阶段二）", None, "#f0fdf4", "#86efac")
arrow(500, 1248, 500, 1274)
s(f'  <text x="512" y="1266" font-size="11" fill="#6b7280">非空</text>')

# Step 13: Stage 2 analysis
box(260, 1278, 480, 56, "阶段二：数据解读（专家角色 · 快速模型路由）", "行统计 + 样本（前 15 行）回喂 LLM · 生成 aiExplanation / keyInsights / kpiMetrics")
s(f'  <text x="500" y="1330" font-size="11" fill="#ea580c" text-anchor="middle">LLM 失败/空 → buildFallbackAnalysis 规则化降级（基于真实列统计）</text>')

# Fallback旁路
s(f'  <rect x="760" y="1290" width="200" height="32" rx="6" fill="#fff7ed" stroke="#fed7aa" stroke-width="1.2"/>')
s(f'  <text x="860" y="1310" font-size="10.5" fill="#ea580c" text-anchor="middle">v0.4.6+ 规则化降级解读</text>')
s(f'  <line x1="760" y1="1306" x2="740" y2="1306" stroke="#ea580c" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ao)"/>')

arrow(500, 1334, 500, 1362)

# Step 14: Output
box(220, 1366, 560, 44, "输出组装与持久化", "图表 / KPI / 洞察 / 追问 · 写结果缓存 · query_trace 全链路留痕 · 对话历史落库 · 审计落账")

# Feedback loop
s(f'  <path d="M 780,1388 L 1020,1388 L 1020,93 L 640,93" stroke="#9333ea" stroke-width="1.5" stroke-dasharray="6,4" fill="none" marker-end="url(#ap)"/>')
s(f'  <text x="1028" y="750" font-size="10.5" fill="#9333ea" transform="rotate(-90 1028 750)" text-anchor="middle">点赞→auto_train 沉淀 · 点踩→反例注入 · 反馈闭环</text>')

# Legend
ly = 1410
s(f'  <line x1="40" y1="{ly}" x2="70" y2="{ly}" stroke="#2563eb" stroke-width="1.5" marker-end="url(#ab)"/>')
s(f'  <text x="78" y="{ly+4}" font-size="11" fill="#6b7280">主推导流程</text>')
s(f'  <line x1="158" y1="{ly}" x2="188" y2="{ly}" stroke="#16a34a" stroke-width="1.5" marker-end="url(#ag)"/>')
s(f'  <text x="196" y="{ly+4}" font-size="11" fill="#6b7280">短路返回</text>')
s(f'  <line x1="266" y1="{ly}" x2="296" y2="{ly}" stroke="#9333ea" stroke-width="1.5" marker-end="url(#ap)"/>')
s(f'  <text x="304" y="{ly+4}" font-size="11" fill="#6b7280">LLM / 清洗链 / 反馈闭环</text>')
s(f'  <line x1="454" y1="{ly}" x2="484" y2="{ly}" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5,3" marker-end="url(#ar)"/>')
s(f'  <text x="492" y="{ly+4}" font-size="11" fill="#6b7280">自纠错重试</text>')
s(f'  <line x1="582" y1="{ly}" x2="612" y2="{ly}" stroke="#ea580c" stroke-width="1.5" marker-end="url(#ao)"/>')
s(f'  <text x="620" y="{ly+4}" font-size="11" fill="#6b7280">规则化降级</text>')
s(f'  <text x="970" y="{ly+4}" font-size="10" fill="#9ca3af" text-anchor="end">每步旁路落库 query_trace 供时间线回放</text>')

s('</svg>')

with open(OUT, 'w') as f:
    f.write('\n'.join(L))
print(f"✓ Generated: {OUT} ({len(L)} lines)")
