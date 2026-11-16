#!/usr/bin/env python3
"""砖色深度实验：F 现状 vs G/H/I 三档更深的靛。

诊断校正：用户说的「整体偏暗、不突出」不是亮度不够，而是砖的左上被高光
抬到接近白，白笔弧在白/浅紫砖上不跳——砖越浅、笔弧越糊。破法是**加深砖**，
把白笔弧与砖的对比从 3.6:1 拉到 5:1 以上，而不是继续加白。

光效同步收敛：砖变深后，扫光/主光斑若维持原强度会把砖重新抬灰，
因此 SW 0.34→0.22、SPOT 0.24→0.16，只留砖顶内高光、底反光与轮廓暗线做质感。
"""
import io

import cairosvg
from PIL import Image, ImageDraw, ImageFont

import geom

FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
W, H = 1800, 1210
COL = 440
LIGHT_BG = (246, 247, 250)
DARK_BG = (15, 23, 42)
GREY = (108, 116, 134)
CAPTION = (99, 102, 241)

# 深底透明版没有砖，本轮不动
DARK_INK = ("#E4E0FF", "#A79FFF", "#7E75F8")
DARK_CORE = ("#FFFFFF", "#9CF4FF", "#22D6EF")

SCHEMES = [
    dict(key="F · 现状", ink=("#C9C4FF", "#7B7AF9", "#5A5CF0"),
         core=("#F6FFFF", "#8CF2FE", "#1FCBE9")),
    dict(key="G · 浅靛", ink=("#BDB7FF", "#6A66F5", "#4A44E0"),
         core=("#F6FFFF", "#8CF2FE", "#1FCBE9")),
    dict(key="H · 标准靛", ink=("#AEA7FF", "#5B54F2", "#3F37D2"),
         core=("#F2FFFF", "#8AF0FD", "#1FC5E6")),
    dict(key="I · 深靛", ink=("#A097FF", "#4C45EA", "#332BBE"),
         core=("#EEFFFF", "#84EEFC", "#1ABBDD")),
]

# 砖面光效（本轮统一收敛）
SW_HI, SW_LO = 0.22, 0.0
SPOT = 0.16
BOUNCE = 0.24
TOPHL = 0.62
LINELO, LINEHI = 0.08, 0.30
RIM, SPEC, CBOUNCE = 0.88, 0.96, 0.50


def lum(hex_color):
    c = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast_white(hex_color):
    return 1.05 / (lum(hex_color) + 0.05)


def defs(p):
    ihi, imd, ilo = p["ink"]
    chi, cmd, clo = p["core"]
    return f'''<defs>
  <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="42" y1="18" x2="214" y2="238">
    <stop offset="0%" stop-color="{ihi}"/><stop offset="46%" stop-color="{imd}"/><stop offset="100%" stop-color="{ilo}"/>
  </linearGradient>
  <linearGradient id="inkDark" gradientUnits="userSpaceOnUse" x1="60" y1="52" x2="200" y2="210">
    <stop offset="0%" stop-color="{DARK_INK[0]}"/><stop offset="46%" stop-color="{DARK_INK[1]}"/><stop offset="100%" stop-color="{DARK_INK[2]}"/>
  </linearGradient>
  <radialGradient id="core" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">
    <stop offset="0%" stop-color="{chi}"/><stop offset="44%" stop-color="{cmd}"/><stop offset="100%" stop-color="{clo}"/>
  </radialGradient>
  <radialGradient id="coreDark" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">
    <stop offset="0%" stop-color="{DARK_CORE[0]}"/><stop offset="44%" stop-color="{DARK_CORE[1]}"/><stop offset="100%" stop-color="{DARK_CORE[2]}"/>
  </radialGradient>
  <linearGradient id="sweep" gradientUnits="userSpaceOnUse" x1="36" y1="18" x2="214" y2="250">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{SW_HI}"/>
    <stop offset="38%" stop-color="#FFFFFF" stop-opacity="0"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="{SW_LO}"/>
  </linearGradient>
  <radialGradient id="spot" gradientUnits="userSpaceOnUse" cx="82" cy="66" r="130">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{SPOT}"/>
    <stop offset="55%" stop-color="#FFFFFF" stop-opacity="0.05"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="bounce" gradientUnits="userSpaceOnUse" x1="128" y1="168" x2="128" y2="240">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0"/>
    <stop offset="100%" stop-color="#C8DEFF" stop-opacity="{BOUNCE}"/>
  </linearGradient>
  <linearGradient id="topHL" gradientUnits="userSpaceOnUse" x1="128" y1="16" x2="128" y2="104">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{TOPHL}"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="edgeLine" gradientUnits="userSpaceOnUse" x1="40" y1="40" x2="232" y2="232">
    <stop offset="0%" stop-color="#2A2480" stop-opacity="{LINELO}"/>
    <stop offset="55%" stop-color="#2A2480" stop-opacity="0.20"/>
    <stop offset="100%" stop-color="#221C6E" stop-opacity="{LINEHI}"/>
  </linearGradient>
  <linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="128" y1="48" x2="128" y2="204">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.80"/>
    <stop offset="52%" stop-color="#FFFFFF" stop-opacity="0.18"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="sheen" gradientUnits="userSpaceOnUse" x1="62" y1="54" x2="198" y2="208">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.46"/>
    <stop offset="38%" stop-color="#FFFFFF" stop-opacity="0.05"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="rim" gradientUnits="userSpaceOnUse" x1="128" y1="104" x2="128" y2="152">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{RIM}"/>
    <stop offset="46%" stop-color="#FFFFFF" stop-opacity="0.20"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="spec" gradientUnits="userSpaceOnUse" cx="119" cy="113" r="8">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{SPEC}"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="cbounce" gradientUnits="userSpaceOnUse" cx="128" cy="144" r="15">
    <stop offset="0%" stop-color="#9CF4FF" stop-opacity="{CBOUNCE}"/>
    <stop offset="100%" stop-color="#9CF4FF" stop-opacity="0"/>
  </radialGradient>
</defs>'''


def core_top():
    return ('\n  <circle cx="128" cy="128" r="21.3" fill="none" stroke="url(#rim)" stroke-width="1"/>'
            '\n  <ellipse cx="119" cy="113" rx="7.5" ry="6" fill="url(#spec)"/>'
            '\n  <ellipse cx="128" cy="141" rx="12" ry="4" fill="url(#cbounce)"/>')


def svg_light(p):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">{defs(p)}'
            f'\n  <path fill="url(#ink)" d="{geom.TILE}"/>'
            f'\n  <path fill="url(#sweep)" d="{geom.TILE}"/>'
            f'\n  <path fill="url(#spot)" d="{geom.TILE}"/>'
            f'\n  <path fill="url(#bounce)" d="{geom.TILE}"/>'
            f'\n  <path fill="none" stroke="url(#edgeLine)" stroke-width="1.6" d="{geom.TILE}"/>'
            f'\n  <path fill="none" stroke="url(#topHL)" stroke-width="2" d="{geom.TILE}"/>'
            f'\n  <path fill="#FFFFFF" d="{geom.BAND}"/>'
            f'\n  <path fill="url(#core)" d="{geom.CORE_D}"/>{core_top()}\n</svg>')


def svg_dark():
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{geom.BARE_VIEWBOX}">{defs({"ink": DARK_INK, "core": DARK_CORE})}'
            f'\n  <path fill="url(#inkDark)" d="{geom.BAND}"/>'
            f'\n  <path fill="url(#sheen)" d="{geom.BAND}"/>'
            f'\n  <path fill="none" stroke="url(#edge)" stroke-width="1.4" d="{geom.BAND}"/>'
            f'\n  <path fill="url(#coreDark)" d="{geom.CORE_D}"/>{core_top()}\n</svg>')


def svg_flat(p):
    """小尺寸平面版（favicon）：无渐变，纯底色 + 白弧 + 青核。"""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">'
            f'\n  <path fill="{p["ink"][1]}" d="{geom.TILE}"/>'
            f'\n  <path fill="#FFFFFF" d="{geom.FAV_BAND}"/>'
            f'\n  <path fill="{geom.ACCENT}" d="{geom.FAV_CORE}"/>\n</svg>')


def render(svg, size):
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")


canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255))
d = ImageDraw.Draw(canvas)
d.text((40, 22), "砖色深度实验 · 同一几何，只加深深度", font=ImageFont.truetype(FONT, 20), fill=(30, 32, 48))
d.text((40, 50), "第一行浅底砖版（220px）· 第二行深底透明版（本轮不动）· 第三行小尺寸砖版与平面 favicon · 第四行 2 倍细节",
       font=ImageFont.truetype(FONT, 12), fill=GREY)

for i, p in enumerate(SCHEMES):
    x0 = i * COL
    ratio = contrast_white(p["ink"][1])
    d.text((x0 + 24, 78), p["key"], font=ImageFont.truetype(FONT, 17), fill=CAPTION)
    d.text((x0 + 24, 100), f"{p['ink'][1]} · 白弧对比 {ratio:.1f}:1",
           font=ImageFont.truetype(FONT, 11.5), fill=GREY)

    # 浅底砖版
    d.rounded_rectangle((x0 + 24, 124, x0 + 416, 392), radius=14, fill=LIGHT_BG)
    canvas.alpha_composite(render(svg_light(p), 220), (x0 + 110, 148))

    # 深底透明版（不动）
    d.rounded_rectangle((x0 + 24, 404, x0 + 416, 672), radius=14, fill=DARK_BG)
    canvas.alpha_composite(render(svg_dark(), 220), (x0 + 110, 428))

    # 小尺寸：砖版 / 平面版
    base = 760
    x = x0 + 30
    for size in (48, 32, 16):
        canvas.alpha_composite(render(svg_light(p), size), (x, base - size))
        x += size + 22
    d.text((x0 + 30, base + 8), "砖版 48/32/16", font=ImageFont.truetype(FONT, 11), fill=GREY)
    x = x0 + 226
    for size in (48, 32, 16):
        canvas.alpha_composite(render(svg_flat(p), size), (x, base - size))
        x += size + 22
    d.text((x0 + 226, base + 8), "平面 48/32/16", font=ImageFont.truetype(FONT, 11), fill=GREY)

    # 2x 细节
    zoom = render(svg_light(p), 440)
    crop = zoom.crop((96, 96, 344, 344))
    d.rounded_rectangle((x0 + 24, 800, x0 + 416, 1150), radius=14, fill=LIGHT_BG)
    canvas.alpha_composite(crop, (x0 + 110, 812))
    d.text((x0 + 24, 1160), "2x detail", font=ImageFont.truetype(FONT, 11), fill=GREY)

canvas.convert("RGB").save("renders/deep-lab.png")
print("wrote renders/deep-lab.png", canvas.size)
for p in SCHEMES:
    print(f"  {p['key']}: {p['ink'][1]} 白弧对比 {contrast_white(p['ink'][1]):.2f}:1")
