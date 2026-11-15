#!/usr/bin/env python3
"""笔弧几何（单一真源）。导出 geometry() 给 kit / icon / mockup 生成器共用。"""
import math

CX = CY = 128.0
TH0 = 15.0
SWEEP = 305.0
NSEG = 8
TILE = ("M56 16H200A40 40 0 0 1 240 56V200A40 40 0 0 1 200 240H56"
        "A40 40 0 0 1 16 200V56A40 40 0 0 1 56 16Z")

CN = "智能问数"
EN = "NL2SQL PRO"
CN_FONT = "PingFang SC, Hiragino Sans GB, Heiti SC, Source Han Sans SC, sans-serif"
EN_FONT = "Helvetica Neue, Arial, PingFang SC, sans-serif"

INK = "#312E81"
ACCENT = "#22D3EE"


def f(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def geometry(r_out, r_in, r_tip, core_r):
    """返回 (笔弧 d, 核 d)。t∈[0,1]：粗端 → 尖端。"""
    th0, sweep = math.radians(TH0), math.radians(SWEEP)

    def rad(t, outer):
        base = r_out if outer else r_in
        return base + (r_tip - base) * t

    def pos(t, outer):
        r, a = rad(t, outer), th0 + sweep * t
        return CX + r * math.cos(a), CY + r * math.sin(a)

    def der(t, outer):
        b = ((r_tip - r_out) if outer else (r_tip - r_in)) / sweep
        r, a = rad(t, outer), th0 + sweep * t
        return b * math.cos(a) - r * math.sin(a), b * math.sin(a) + r * math.cos(a)

    def seg(t0, t1, outer):
        p0, p3 = pos(t0, outer), pos(t1, outer)
        d0, d3 = der(t0, outer), der(t1, outer)
        n0, n3 = math.hypot(*d0), math.hypot(*d3)
        u0 = (d0[0] / n0, d0[1] / n0)
        u3 = (d3[0] / n3, d3[1] / n3)
        L = (4.0 / 3.0) * math.tan((t1 - t0) * sweep / 4.0) * rad((t0 + t1) / 2.0, outer)
        return p0, (p0[0] + u0[0] * L, p0[1] + u0[1] * L), (p3[0] - u3[0] * L, p3[1] - u3[1] * L), p3

    ts = [i / NSEG for i in range(NSEG + 1)]
    start = pos(0, True)
    d = [f"M{f(start[0])} {f(start[1])}"]
    for i in range(NSEG):
        _, c1, c2, p3 = seg(ts[i], ts[i + 1], True)
        d.append(f"C{f(c1[0])} {f(c1[1])} {f(c2[0])} {f(c2[1])} {f(p3[0])} {f(p3[1])}")
    for i in reversed(range(NSEG)):
        p0, c1, c2, p3 = seg(ts[i], ts[i + 1], False)
        d.append(f"C{f(c2[0])} {f(c2[1])} {f(c1[0])} {f(c1[1])} {f(p0[0])} {f(p0[1])}")
    cap = (r_out - r_in) / 2.0
    d.append(f"A{cap:g} {cap:g} 0 0 0 {f(start[0])} {f(start[1])}Z")
    core = (f"M{f(CX + core_r)} {f(CY)}A{core_r:g} {core_r:g} 0 1 1 {f(CX - core_r)} {f(CY)}"
            f"A{core_r:g} {core_r:g} 0 1 1 {f(CX + core_r)} {f(CY)}Z")
    return "\n           ".join(d), core


def mark(band, core, fill="currentColor", indent="  "):
    return (f'<path fill="{fill}" fill-rule="evenodd"\n'
            f'{indent}      d="{TILE}\n{indent}         {band}\n{indent}         {core}"/>')


BAND, CORE_D = geometry(78, 38, 32, 22)        # 主标
FAV_BAND, FAV_CORE = geometry(80, 40, 40, 24)  # 16–32px 简化版
