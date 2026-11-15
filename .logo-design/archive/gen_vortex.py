#!/usr/bin/env python3
"""Vortex：一条沿圆周盘绕、边绕边收细的带子，末端收在核的旁边。

数据（粗端，开口处）→ 盘绕 → 收细 → 核（判断）。
与 Orbit 同尺度：外接半径 78，核 r22，方砖 16..240。
"""
import math

CX = CY = 128.0
TH0 = 10.0          # 起点角（3 点偏上）
SWEEP = 340.0       # 盘绕角度
R0, R1 = 78.0, 66.0 # 外边界：起 → 止
IN0, IN1 = 44.0, 42.0  # 内边界：起 → 止（带宽 34 → 24）
CORE = 22.0
STEP = 4.0          # 采样步长（度）
TILE = ("M56 16H200A40 40 0 0 1 240 56V200A40 40 0 0 1 200 240H56"
        "A40 40 0 0 1 16 200V56A40 40 0 0 1 56 16Z")


def pt(rad, deg):
    a = math.radians(deg)
    return CX + rad * math.cos(a), CY + rad * math.sin(a)


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def lerp(a, b, t):
    return a + (b - a) * t


def vortex():
    n = int(round(SWEEP / STEP))
    outer, inner = [], []
    for i in range(n + 1):
        t = i / n
        deg = TH0 + SWEEP * t
        outer.append(pt(lerp(R0, R1, t), deg))
        inner.append(pt(lerp(IN0, IN1, t), deg))

    d = [f"M{f(outer[0][0])} {f(outer[0][1])}"]
    d += [f"L{f(p[0])} {f(p[1])}" for p in outer[1:]]
    cap_r = (R1 - IN1) / 2.0
    d.append(f"A{cap_r:g} {cap_r:g} 0 0 1 {f(inner[-1][0])} {f(inner[-1][1])}")
    d += [f"L{f(p[0])} {f(p[1])}" for p in reversed(inner[:-1])]
    start_r = (R0 - IN0) / 2.0
    d.append(f"A{start_r:g} {start_r:g} 0 0 1 {f(outer[0][0])} {f(outer[0][1])}Z")
    band = "".join(d)

    core = (f"M{f(CX + CORE)} {f(CY)}A{CORE:g} {CORE:g} 0 1 1 {f(CX - CORE)} {f(CY)}"
            f"A{CORE:g} {CORE:g} 0 1 1 {f(CX + CORE)} {f(CY)}Z")
    return band, core


band, core = vortex()
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Embrace vortex">
  <title>Embrace vortex</title>
  <!-- 开口在右（3 点）：带子从开口进入，盘绕 {SWEEP:g}° 边绕边收细（带宽 {R0-IN0:g}→{R1-IN1:g}），
       末端收在核旁；核 r22、间隙 {IN1-CORE:g}。方砖为容器，环带与核均为白色负形。 -->
  <path fill="#000" fill-rule="evenodd"
        d="{TILE}
           {band}
           {core}"/>
</svg>
'''
open("concept-s-vortex.svg", "w", encoding="utf-8").write(svg)
print("wrote concept-s-vortex.svg")
