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

# ---- 品牌色（F 方案：提亮 + 玻璃质感）----
# 破局点不在「整体加白」，而在拉大砖的受光跨度：左上接近白紫、右下仍饱和。
# 主色仍落在品牌色相，但中段从 #6366F1 抬到 #7B7AF9（明度 65%→71%）。
INK = "#7B7AF9"        # 品牌主色（单色退回 / 渐变中段 / 文字）
INK_HI = "#C9C4FF"     # 光泽高光端（左上受光，接近白紫）
INK_LO = "#5A5CF0"     # 暗端不下沉，保持饱和
TILE_HI = "#FFFFFF"    # 瓷面砖：顶部纯白
TILE_MD = "#FDFDFF"
TILE_LO = "#F2F3FF"    # 砖底微冷，产生厚度感
CORE_HI = "#F6FFFF"    # 核心球面高光（中心偏左上）
CORE_MD = "#8CF2FE"
CORE_LO = "#1FCBE9"
ACCENT = "#22D3EE"

# ---- 深色底透明版：砖退场，笔弧整体提亮，核加高光 ----
# 背景 slate-900 #0F172A 下：亮端 13.4:1 / 暗端 5.4:1，远超非文本 3:1
ON_DARK_HI = "#E4E0FF"
ON_DARK = "#A79FFF"
ON_DARK_LO = "#7E75F8"
CORE_DK_HI = "#FFFFFF"
CORE_DK_MID = "#9CF4FF"
CORE_DK_LO = "#22D6EF"
# 无砖时 viewBox 收到笔弧外接框（r78 → 50..206，留 6 边），不再替砖占位
BARE_VIEWBOX = "44 44 168 168"

# ---- 玻璃光效：纯渐变实现（禁 filter / 禁位图）----
# 与上一版的关键差别：暗端全部归零——光效只做加法。提亮靠基色，质感靠高光形状。
SW_HI, SW_LO = 0.34, 0.0     # 砖面斜扫光（只提亮不压暗）
SH_HI, SH_LO = 0.46, 0.0     # 笔弧斜向受光（仅深底透明版）
TOPHL = 0.62                 # 砖顶 2px 内高光
SPOT = 0.24                  # 砖面左上主光斑（径向，像玻璃球的高光区）
BOUNCE = 0.22                # 砖底环境反光（冷白，抬厚度）
EDGE_HI, EDGE_MID = 0.80, 0.18  # 笔弧轮廓光（沿路径描边，上亮下隐）
LINELO, LINEHI = 0.10, 0.38  # 砖外缘暗线：左上几乎无、右下压重——把边界托住
BANDLINE = 0.30              # 白笔弧内缘倒角暗线：左上重、右下无——在亮砖上勾出尖端
RIM = 0.88                   # 核边缘光（上亮下隐）
SPEC = 0.96                  # 核镜面高光点（更小更集中）
CBOUNCE = 0.50               # 核底反光（背光面的一抹青）


def _material_defs(p):
    """玻璃光效的渐变定义，浅底砖版与深底透明版共用一份。

    暗端全部归零——光效只做加法。提亮靠基色，质感靠高光形状：
    主光斑给出玻璃球的聚光区，底部反光抬厚度，轮廓光让笔弧「立」起来。
    """
    return (
        f'    <linearGradient id="{p}sweep" gradientUnits="userSpaceOnUse" x1="36" y1="18" x2="214" y2="250">\n'
        f'      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{SW_HI}"/>\n'
        f'      <stop offset="38%" stop-color="#FFFFFF" stop-opacity="0"/>\n'
        f'      <stop offset="100%" stop-color="#000000" stop-opacity="{SW_LO}"/>\n'
        '    </linearGradient>\n'
        f'    <linearGradient id="{p}sheen" gradientUnits="userSpaceOnUse" x1="62" y1="54" x2="198" y2="208">\n'
        f'      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{SH_HI}"/>\n'
        f'      <stop offset="38%" stop-color="#FFFFFF" stop-opacity="0.05"/>\n'
        f'      <stop offset="100%" stop-color="#000000" stop-opacity="{SH_LO}"/>\n'
        '    </linearGradient>\n'
        f'    <radialGradient id="{p}spot" gradientUnits="userSpaceOnUse" cx="82" cy="66" r="130">\n'
        f'      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{SPOT}"/>\n'
        f'      <stop offset="55%" stop-color="#FFFFFF" stop-opacity="0.07"/>\n'
        f'      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>\n'
        '    </radialGradient>\n'
        f'    <linearGradient id="{p}bounce" gradientUnits="userSpaceOnUse" x1="128" y1="168" x2="128" y2="240">\n'
        f'      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0"/>\n'
        f'      <stop offset="100%" stop-color="#C8DEFF" stop-opacity="{BOUNCE}"/>\n'
        '    </linearGradient>\n'
        f'    <linearGradient id="{p}edge" gradientUnits="userSpaceOnUse" x1="128" y1="48" x2="128" y2="204">\n'
        f'      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{EDGE_HI}"/>\n'
        f'      <stop offset="52%" stop-color="#FFFFFF" stop-opacity="{EDGE_MID}"/>\n'
        f'      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>\n'
        '    </linearGradient>\n'
        f'    <linearGradient id="{p}edgeLine" gradientUnits="userSpaceOnUse" x1="40" y1="40" x2="232" y2="232">\n'
        f'      <stop offset="0%" stop-color="#3F3AA8" stop-opacity="{LINELO}"/>\n'
        f'      <stop offset="55%" stop-color="#3F3AA8" stop-opacity="0.22"/>\n'
        f'      <stop offset="100%" stop-color="#322D8C" stop-opacity="{LINEHI}"/>\n'
        '    </linearGradient>\n'
        f'    <linearGradient id="{p}bandLine" gradientUnits="userSpaceOnUse" x1="42" y1="18" x2="214" y2="238">\n'
        f'      <stop offset="0%" stop-color="#4A44A8" stop-opacity="{BANDLINE}"/>\n'
        f'      <stop offset="55%" stop-color="#4A44A8" stop-opacity="0.12"/>\n'
        f'      <stop offset="100%" stop-color="#322D8C" stop-opacity="0"/>\n'
        '    </linearGradient>\n'
        f'    <linearGradient id="{p}topHL" gradientUnits="userSpaceOnUse" x1="128" y1="16" x2="128" y2="104">\n'
        f'      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{TOPHL}"/>\n'
        f'      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>\n'
        '    </linearGradient>\n'
        f'    <linearGradient id="{p}rim" gradientUnits="userSpaceOnUse" x1="128" y1="104" x2="128" y2="152">\n'
        f'      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{RIM}"/>\n'
        f'      <stop offset="46%" stop-color="#FFFFFF" stop-opacity="0.20"/>\n'
        f'      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>\n'
        '    </linearGradient>\n'
        f'    <radialGradient id="{p}spec" gradientUnits="userSpaceOnUse" cx="119" cy="113" r="8">\n'
        f'      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{SPEC}"/>\n'
        f'      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>\n'
        '    </radialGradient>\n'
        f'    <radialGradient id="{p}cbounce" gradientUnits="userSpaceOnUse" cx="128" cy="144" r="15">\n'
        f'      <stop offset="0%" stop-color="#9CF4FF" stop-opacity="{CBOUNCE}"/>\n'
        f'      <stop offset="100%" stop-color="#9CF4FF" stop-opacity="0"/>\n'
        '    </radialGradient>\n'
    )


def defs(prefix="", material=True):
    """三层光泽渐变：笔弧金属 / 砖面瓷面 / 核心球面，外加薄光材质层。

    userSpaceOnUse 坐标按 256 画布给出——嵌套 <svg viewBox="0 0 256 256"> 内引用时
    解析的是元素自身的用户坐标系，因此内外尺寸不同也无需改坐标。
    material=False 供满版 app icon 使用：构图里没有砖，不需要扫光与边缘光。
    """
    p = prefix
    body = (
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
    )
    if material:
        body += _material_defs(p)
    return '<defs>\n' + body + '  </defs>'


def defs_on_dark(prefix="", material=True):
    """深色底的透明版渐变：无砖面，只有提亮的笔弧与更亮的核心。"""
    p = prefix
    body = (
        f'    <linearGradient id="{p}ink" gradientUnits="userSpaceOnUse" x1="60" y1="52" x2="200" y2="210">\n'
        f'      <stop offset="0%" stop-color="{ON_DARK_HI}"/>\n'
        f'      <stop offset="46%" stop-color="{ON_DARK}"/>\n'
        f'      <stop offset="100%" stop-color="{ON_DARK_LO}"/>\n'
        '    </linearGradient>\n'
        f'    <radialGradient id="{p}core" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">\n'
        f'      <stop offset="0%" stop-color="{CORE_DK_HI}"/>\n'
        f'      <stop offset="44%" stop-color="{CORE_DK_MID}"/>\n'
        f'      <stop offset="100%" stop-color="{CORE_DK_LO}"/>\n'
        '    </radialGradient>\n'
    )
    if material:
        body += _material_defs(p)
    return '<defs>\n' + body + '  </defs>'


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


def symbol_body(prefix="", on_dark=False, invert=False):
    """符号的完整图层序列（含玻璃光效），生成器直接嵌进 <svg> 即可。

    浅底砖版：砖 → 斜扫光 → 主光斑 → 砖底反光 → 外缘暗线 → 砖顶内高光
              → 笔弧 → 核 → 窄边缘光 → 镜面点 → 核底反光
    深底透明版：提亮笔弧 → 斜向受光 → 轮廓光 → 核 → 窄边缘光 → 镜面点 → 核底反光
    invert=True 为反白（白砖 + 品牌主色笔弧），用于照片与深色底/浅底互转的反相场景。

    图层顺序即显隐——后面的盖在前面上；全部用渐变与描边完成，不用 filter。
    外缘暗线只加在砖版：左上越亮越像玻璃，但边界也越容易「融化」进浅底，
    用一条左上几乎无、右下压重的暗线把轮廓托住。
    """
    p = prefix
    out = []
    if on_dark:
        out.append(f'<path fill="url(#{p}ink)" d="{BAND}"/>')
        out.append(f'<path fill="url(#{p}sheen)" d="{BAND}"/>')
        out.append(f'<path fill="none" stroke="url(#{p}edge)" stroke-width="1.4" d="{BAND}"/>')
        rim_w, sx, sy = 1.0, 7.5, 6
    elif invert:
        out.append(f'<path fill="url(#{p}tile)" d="{TILE}"/>')
        out.append(f'<path fill="none" stroke="url(#{p}topHL)" stroke-width="2" d="{TILE}"/>')
        out.append(f'<path fill="url(#{p}ink)" d="{BAND}"/>')
        rim_w, sx, sy = 1.5, 9, 7
    else:
        out.append(f'<path fill="url(#{p}ink)" d="{TILE}"/>')
        out.append(f'<path fill="url(#{p}sweep)" d="{TILE}"/>')
        out.append(f'<path fill="url(#{p}spot)" d="{TILE}"/>')
        out.append(f'<path fill="url(#{p}bounce)" d="{TILE}"/>')
        out.append(f'<path fill="none" stroke="url(#{p}edgeLine)" stroke-width="1.6" d="{TILE}"/>')
        out.append(f'<path fill="none" stroke="url(#{p}topHL)" stroke-width="2" d="{TILE}"/>')
        out.append(f'<path fill="#FFFFFF" stroke="url(#{p}bandLine)" stroke-width="0.9" d="{BAND}"/>')
        rim_w, sx, sy = 1.0, 7.5, 6
    out.append(f'<path fill="url(#{p}core)" d="{CORE_D}"/>')
    out.append(f'<circle cx="128" cy="128" r="21.3" fill="none" stroke="url(#{p}rim)" stroke-width="{rim_w}"/>')
    spec_cy = 114 if invert else 113
    out.append(f'<ellipse cx="119" cy="{spec_cy}" rx="{sx}" ry="{sy}" fill="url(#{p}spec)"/>')
    if not invert:
        out.append(f'<ellipse cx="128" cy="141" rx="12" ry="4" fill="url(#{p}cbounce)"/>')
    return "\n  ".join(out)
