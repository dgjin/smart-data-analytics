#!/usr/bin/env python3
"""Brush：一笔从粗到尖的弧。

粗端（带宽 40）从右侧进入 → 盘绕 305° → 收成尖（带宽 0），中心一颗核。
与 Orbit 同尺度：外接半径 78，核 r22，方砖 16..240。
粗细变化是关键：等宽的环读作字母 C，有笔锋的弧读作「一笔流动」。
"""
import math

CX = CY = 128.0
TH_START = 15.0        # 粗端起笔（右下）
SWEEP = 305.0          # 盘绕角度，收笔于 320°（右上）
R_OUT, R_IN = 78.0, 38.0   # 起笔外/内半径（带宽 40）
R_TIP = 32.0               # 收笔点半径（外内汇合，指向核，间隙 10）
CORE = 22.0
STEP = 8.0            # 采样步长（定稿需重绘为贝塞尔）


def pt(rad, deg):
    a = math.radians(deg)
    return CX + rad * math.cos(a), CY + rad * math.sin(a)


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def lerp(a, b, t):
    return a + (b - a) * t


def brush():
    n = int(round(SWEEP / STEP))
    outer, inner = [], []
    for i in range(n + 1):
        t = i / n
        deg = TH_START + SWEEP * t
        outer.append(pt(lerp(R_OUT, R_TIP, t), deg))
        inner.append(pt(lerp(R_IN, R_TIP, t), deg))

    d = [f"M{f(outer[0][0])} {f(outer[0][1])}"]
    d += [f"L{f(p[0])} {f(p[1])}" for p in outer[1:]]
    d += [f"L{f(p[0])} {f(p[1])}" for p in reversed(inner[:-1])]
    cap_r = (R_OUT - R_IN) / 2.0
    d.append(f"A{cap_r:g} {cap_r:g} 0 0 0 {f(outer[0][0])} {f(outer[0][1])}Z")
    band = "".join(d)

    core = (f"M{f(CX + CORE)} {f(CY)}A{CORE:g} {CORE:g} 0 1 1 {f(CX - CORE)} {f(CY)}"
            f"A{CORE:g} {CORE:g} 0 1 1 {f(CX + CORE)} {f(CY)}Z")
    return band, core


band, core = brush()
TILE = ("M56 16H200A40 40 0 0 1 240 56V200A40 40 0 0 1 200 240H56"
        "A40 40 0 0 1 16 200V56A40 40 0 0 1 56 16Z")
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Embrace brush">
  <title>Embrace brush</title>
  <!-- 一笔弧：粗端（带宽 40）在右下起笔，逆时针盘绕 {SWEEP:g}°，边绕边收，末端收成尖（带宽 0）。
       中心一颗核 r22。方砖为容器，笔弧与核均为白色负形。 -->
  <path fill="#000" fill-rule="evenodd"
        d="{TILE}
           {band}
           {core}"/>
</svg>
'''
open("concept-t-brush.svg", "w", encoding="utf-8").write(svg)
print("wrote concept-t-brush.svg")
