#!/usr/bin/env python3
"""生成「环抱 + 核」的开口环路径（可指定开口方位），用于比较方位差异。"""
import math

CX = CY = 128.0
R, r = 78.0, 44.0          # 环外/内半径，环厚 34
CORE = 22.0                # 核半径
GAP = 80.0                 # 开口角度
TILE = "M56 16H200A40 40 0 0 1 240 56V200A40 40 0 0 1 200 240H56A40 40 0 0 1 16 200V56A40 40 0 0 1 56 16Z"
M = (R + r) / 2.0
C_R = (R - r) / 2.0


def pt(rad, deg):
    a = math.radians(deg)
    return CX + rad * math.cos(a), CY + rad * math.sin(a)


def f(v):
    return f"{v:.1f}".rstrip("0").rstrip(".")


def embrace(open_deg):
    a = open_deg + GAP / 2.0        # 带起于开口一侧
    b = open_deg - GAP / 2.0 + 360  # 绕行一圈后止于开口另一侧
    po_a, pi_a = pt(R, a), pt(r, a)
    po_b, pi_b = pt(R, b), pt(r, b)
    span = b - a
    large = 1 if span > 180 else 0
    d = (f"M{f(po_a[0])} {f(po_a[1])}"
         f"A{R:g} {R:g} 0 {large} 1 {f(po_b[0])} {f(po_b[1])}"
         f"A{C_R:g} {C_R:g} 0 0 1 {f(pi_b[0])} {f(pi_b[1])}"
         f"A{r:g} {r:g} 0 {large} 0 {f(pi_a[0])} {f(pi_a[1])}"
         f"A{C_R:g} {C_R:g} 0 0 1 {f(po_a[0])} {f(po_a[1])}Z")
    core = (f"M{f(CX + CORE)} {f(CY)}A{CORE:g} {CORE:g} 0 1 1 {f(CX - CORE)} {f(CY)}"
            f"A{CORE:g} {CORE:g} 0 1 1 {f(CX + CORE)} {f(CY)}Z")
    return f'{TILE}\n           {d}\n           {core}'


SPECS = [
    ("right", 0, "开口在右（3 点）", "环从右上起笔、向左绕行整圈，回到右下：开口正对视线，读作「入口」。"),
    ("top", 270, "开口在上（12 点）", "开口朝上：环像一个承接的碗，数据自上落下，绕行一圈后沉淀成中心的核。"),
    ("bottom", 90, "开口在下（6 点）", "开口朝下：数据从底部进入，向上绕行一圈后落在中心核上。"),
    ("lowerleft", 135, "开口在左下（7-8 点）", "开口朝左下：环从左上抱住核，视觉重心在右上，动势最强。"),
]

for name, deg, cn, note in SPECS:
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Embrace {name}">
  <title>Embrace {name}</title>
  <!-- {cn}：{note}
       环厚 34、核 r22、间隙 22；方砖为容器，负形为路径。 -->
  <path fill="#000" fill-rule="evenodd"
        d="{embrace(deg)}"/>
</svg>
'''
    open(f"concept-q-{name}.svg", "w", encoding="utf-8").write(svg)
    print("wrote", f"concept-q-{name}.svg")
