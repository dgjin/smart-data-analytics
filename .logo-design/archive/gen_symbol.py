#!/usr/bin/env python3
"""Brush 定稿：把采样折线重绘为 8 段三次贝塞尔。

几何：极坐标螺旋，中心线半径 58→32，带宽 40→0（收成尖），盘绕 305°。
贝塞尔拟合：每段按端点的解析切线定向，控制点长度取圆弧公式 (4/3)·tan(Δθ/4)·R_mid。
"""
import math

CX = CY = 128.0
TH0 = math.radians(15.0)
SWEEP = math.radians(305.0)
R_OUT, R_IN, R_TIP = 78.0, 38.0, 32.0
CORE = 22.0
NSEG = 8
TILE = ("M56 16H200A40 40 0 0 1 240 56V200A40 40 0 0 1 200 240H56"
        "A40 40 0 0 1 16 200V56A40 40 0 0 1 56 16Z")


def radius(rad, outer):
    t = (rad - TH0) / SWEEP
    return (R_OUT if outer else R_IN) + (R_TIP - (R_OUT if outer else R_IN)) * t


def pos(rad, outer):
    r = radius(rad, outer)
    return CX + r * math.cos(rad), CY + r * math.sin(rad)


def deriv(rad, outer):
    b = (R_TIP - (R_OUT if outer else R_IN)) / SWEEP
    r = radius(rad, outer)
    return b * math.cos(rad) - r * math.sin(rad), b * math.sin(rad) + r * math.cos(rad)


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def seg(t0, t1, outer):
    p0, p3 = pos(t0, outer), pos(t1, outer)
    d0, d3 = deriv(t0, outer), deriv(t1, outer)
    n0, n3 = math.hypot(*d0), math.hypot(*d3)
    u0 = (d0[0] / n0, d0[1] / n0)
    u3 = (d3[0] / n3, d3[1] / n3)
    L = (4.0 / 3.0) * math.tan((t1 - t0) / 4.0) * radius((t0 + t1) / 2.0, outer)
    c1 = (p0[0] + u0[0] * L, p0[1] + u0[1] * L)
    c2 = (p3[0] - u3[0] * L, p3[1] - u3[1] * L)
    return p0, c1, c2, p3


def bez(p0, c1, c2, p3, t):
    mt = 1 - t
    a, b, c, d = mt**3, 3 * mt**2 * t, 3 * mt * t**2, t**3
    return (a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
            a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1])


steps = [TH0 + SWEEP * i / NSEG for i in range(NSEG + 1)]
d = []
o0 = seg(steps[0], steps[1], True)
d.append(f"M{f(o0[0][0])} {f(o0[0][1])}")
for i in range(NSEG):
    _, c1, c2, p3 = seg(steps[i], steps[i + 1], True)
    d.append(f"C{f(c1[0])} {f(c1[1])} {f(c2[0])} {f(c2[1])} {f(p3[0])} {f(p3[1])}")

for i in reversed(range(NSEG)):
    p0, c1, c2, p3 = seg(steps[i], steps[i + 1], False)
    d.append(f"C{f(c2[0])} {f(c2[1])} {f(c1[0])} {f(c1[1])} {f(p0[0])} {f(p0[1])}")

start = pos(TH0, True)
d.append(f"A{(R_OUT - R_IN) / 2:.0f} {(R_OUT - R_IN) / 2:.0f} 0 0 0 {f(start[0])} {f(start[1])}Z")
band = "\n           ".join(d)

core = (f"M{f(CX + CORE)} {f(CY)}A{CORE:g} {CORE:g} 0 1 1 {f(CX - CORE)} {f(CY)}"
        f"A{CORE:g} {CORE:g} 0 1 1 {f(CX + CORE)} {f(CY)}Z")

# 拟合精度：每段中点处，贝塞尔 vs 理想螺旋的距离
worst = 0.0
for i in range(NSEG):
    p0, c1, c2, p3 = seg(steps[i], steps[i + 1], True)
    m = bez(p0, c1, c2, p3, 0.5)
    ideal = pos((steps[i] + steps[i + 1]) / 2, True)
    worst = max(worst, math.hypot(m[0] - ideal[0], m[1] - ideal[1]))

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="智能问数">
  <title>智能问数 — Brush</title>
  <!-- 一笔：粗端（带宽 40）在右下起笔，逆时针盘绕 305°，边绕边收，末端与核相距 10 处收成尖。
       8 段三次贝塞尔（拟合偏差 {worst:.3f}px）；核 r22。方砖为容器，笔弧与核为白色负形。 -->
  <path fill="#000" fill-rule="evenodd"
        d="{TILE}
           {band}
           {core}"/>
</svg>
'''
open("logo-symbol.svg", "w", encoding="utf-8").write(svg)
print(f"wrote logo-symbol.svg · bezier max deviation {worst:.3f}px")
