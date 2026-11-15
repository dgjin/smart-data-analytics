#!/usr/bin/env python3
"""生成交付 kit：符号（单色/双色/反白）、favicon 简化版、横版与竖版锁合。

几何：极坐标螺旋笔弧，带宽线性收到 0（收成尖），8 段三次贝塞尔拟合。
- 主标：R 78→38，尖端半径 32，核 22（核与笔弧间隙 10）
- favicon：R 80→40，尖端半径 40，核 24（间隙 16，小尺寸不糊）
"""
import math
import os

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
    """返回 (笔弧 d, 核 d)。t∈[0,1] 从粗端走到尖端。"""
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
    d = [f"M{f(pos(0, True)[0])} {f(pos(0, True)[1])}"]
    for i in range(NSEG):
        _, c1, c2, p3 = seg(ts[i], ts[i + 1], True)
        d.append(f"C{f(c1[0])} {f(c1[1])} {f(c2[0])} {f(c2[1])} {f(p3[0])} {f(p3[1])}")
    for i in reversed(range(NSEG)):
        p0, c1, c2, p3 = seg(ts[i], ts[i + 1], False)
        d.append(f"C{f(c2[0])} {f(c2[1])} {f(c1[0])} {f(c1[1])} {f(p0[0])} {f(p0[1])}")
    s = pos(0, True)
    cap = (r_out - r_in) / 2.0
    d.append(f"A{cap:g} {cap:g} 0 0 0 {f(s[0])} {f(s[1])}Z")
    core = (f"M{f(CX + core_r)} {f(CY)}A{core_r:g} {core_r:g} 0 1 1 {f(CX - core_r)} {f(CY)}"
            f"A{core_r:g} {core_r:g} 0 1 1 {f(CX + core_r)} {f(CY)}Z")
    return "\n           ".join(d), core


BAND, CORE_D = geometry(78, 38, 32, 22)
FAV_BAND, FAV_CORE = geometry(80, 40, 40, 24)

os.makedirs("kit", exist_ok=True)


def write(name, text):
    open(f"kit/{name}", "w", encoding="utf-8").write(text)
    print("wrote kit/" + name)


def mark(band, core, fill="currentColor"):
    return (f'<path fill="{fill}" fill-rule="evenodd"\n'
            f'          d="{TILE}\n           {band}\n           {core}"/>')


# 1) 纯符号（负形透明，浅底直接用；颜色随 currentColor）
write("symbol.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="{CN}">
  <title>{CN}</title>
  <!-- 一笔：粗端带宽 40 自右下起笔，逆时针盘绕 305° 收成尖，中心落一颗核（r22）。
       负形透明（evenodd），砖与笔弧同色；深底反白见 symbol-reversed.svg。 -->
  {mark(BAND, CORE_D)}
</svg>
''')

# 2) 双色（砖=品牌深靛，笔弧=白，核=强调青）
write("symbol-duo.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="{CN}">
  <title>{CN}</title>
  <!-- 双色：砖 {INK} / 笔弧 #FFFFFF / 核 {ACCENT}。核是全标唯一的彩色点——
       数据汇聚成判断，判断被点亮。单色场景退回 symbol.svg。 -->
  <path fill="{INK}" d="{TILE}"/>
  <path fill="#FFFFFF" d="{BAND}"/>
  <path fill="{ACCENT}" d="{CORE_D}"/>
</svg>
''')

# 3) 反白（白砖 + 品牌色笔弧 + 青核，深底用）
write("symbol-reversed.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="{CN}">
  <title>{CN}</title>
  <!-- 反白：白砖 + 品牌蓝笔弧 + 青核，用于深色底/照片。
       三层显式上色（不依赖背景透出），与 symbol-duo.svg 构成正/反白对。 -->
  <path fill="#FFFFFF" d="{TILE}"/>
  <path fill="{INK}" d="{BAND}"/>
  <path fill="{ACCENT}" d="{CORE_D}"/>
</svg>
''')

# 4) favicon 简化版（间隙 16、核 24，16px 不糊）
write("favicon-source.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="{CN}">
  <title>{CN} — small size</title>
  <!-- 小尺寸版本：核 24、核与笔弧间隙 16、笔弧略外扩（R80/40）。16–32px 使用。 -->
  <path fill="currentColor" fill-rule="evenodd"
        d="{TILE}
           {FAV_BAND}
           {FAV_CORE}"/>
</svg>
''')

# 5) 横版锁合
write("lockup-horizontal.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 256" role="img" aria-label="{CN} {EN}">
  <title>{CN} — horizontal lockup</title>
  <!-- 横版：符号 192 + 中文 78/700 + 英文副行 22/700（字距 5）。两行视觉中心对符号中线。
       字体：中文 PingFang SC / 思源黑体 Bold；英文 Helvetica Neue / Arial Bold。生产环境用 Logo.tsx 排字。 -->
  <svg x="28" y="32" width="192" height="192" viewBox="0 0 256 256">
    {mark(BAND, CORE_D)}
  </svg>
  <text x="252" y="138" font-family="{CN_FONT}" font-size="78" font-weight="700"
        fill="currentColor" letter-spacing="2">{CN}</text>
  <text x="257" y="190" font-family="{EN_FONT}" font-size="22" font-weight="700"
        fill="currentColor" letter-spacing="5">{EN}</text>
</svg>
''')

# 6) 竖版锁合
write("lockup-vertical.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 420" role="img" aria-label="{CN} {EN}">
  <title>{CN} — vertical lockup</title>
  <!-- 竖版：符号 224 居中，中文 76/700，英文副行 22/700。 -->
  <svg x="88" y="26" width="224" height="224" viewBox="0 0 256 256">
    {mark(BAND, CORE_D)}
  </svg>
  <text x="200" y="332" text-anchor="middle" font-family="{CN_FONT}" font-size="76"
        font-weight="700" fill="currentColor" letter-spacing="2">{CN}</text>
  <text x="200" y="376" text-anchor="middle" font-family="{EN_FONT}" font-size="22"
        font-weight="700" fill="currentColor" letter-spacing="5">{EN}</text>
</svg>
''')

print("kit written")
