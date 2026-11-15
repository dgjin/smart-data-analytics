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

# ---- 品牌色：浅靛 + 光泽（三层渐变，像素小尺寸退回 INK 单色） ----
INK = "#4F46E5"        # 品牌靛蓝（单色 / 小尺寸 / 渐变中段）
INK_HI = "#7A73F5"     # 光泽高光端（左上受光）
INK_LO = "#4033C4"     # 光泽暗端（右下）
TILE_HI = "#FFFFFF"    # 瓷面砖：顶部纯白
TILE_MD = "#FBFBFF"
TILE_LO = "#EBEEFC"    # 砖底微冷，产生厚度感（不再发灰）
CORE_HI = "#C7F9FE"    # 核心球面高光（中心偏左上）
CORE_MD = "#5FE9F6"
CORE_LO = "#1FC4E4"
ACCENT = "#22D3EE"


def defs(prefix=""):
    """三层光泽渐变：笔弧金属 / 砖面瓷面 / 核心球面。同一文档内定义一次即可。

    userSpaceOnUse 坐标按 256 画布给出——嵌套 <svg viewBox="0 0 256 256"> 内引用时
    解析的是元素自身的用户坐标系，因此内外尺寸不同也无需改坐标。
    """
    p = prefix
    return (
        '<defs>\n'
        f'    <linearGradient id="{p}ink" gradientUnits="userSpaceOnUse" x1="42" y1="18" x2="214" y2="238">\n'
        f'      <stop offset="0%" stop-color="{INK_HI}"/>\n'
        f'      <stop offset="46%" stop-color="{INK}"/>\n'
        f'      <stop offset="100%" stop-color="{INK_LO}"/>\n'
        '    </linearGradient>\n'
        f'    <linearGradient id="{p}tile" gradientUnits="userSpaceOnUse" x1="44" y1="20" x2="198" y2="240">\n'
        f'      <stop offset="0%" stop-color="{TILE_HI}"/>\n'
        f'      <stop offset="58%" stop-color="{TILE_MD}"/>\n'
        f'      <stop offset="100%" stop-color="{TILE_LO}"/>\n'
        '    </linearGradient>\n'
        f'    <radialGradient id="{p}core" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">\n'
        f'      <stop offset="0%" stop-color="{CORE_HI}"/>\n'
        f'      <stop offset="44%" stop-color="{CORE_MD}"/>\n'
        f'      <stop offset="100%" stop-color="{CORE_LO}"/>\n'
        '    </radialGradient>\n'
        '  </defs>'
    )


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
