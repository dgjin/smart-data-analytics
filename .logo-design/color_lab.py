#!/usr/bin/env python3
"""配色实验：同一几何，四套配色 × 浅底砖版 / 深底透明版。

只做色彩与材质层的对照，不动几何。A/B/C 分别对应三条优化路线：
A 提亮收窄（干净明亮）· B 发光核（对比拉满）· C 釉面/金属/玻璃（质感）。
"""
import io

import cairosvg
from PIL import Image, ImageDraw, ImageFont

import geom

FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
W, H = 1900, 820
LIGHT_BG = (246, 247, 250)
DARK_BG = (15, 23, 42)
GREY = (108, 116, 134)
CAPTION = (79, 70, 229)

PALETTES = [
    dict(
        key="现状",
        note="#4F46E5 · 渐变 24 档",
        ink=("#7A73F5", "#4F46E5", "#4033C4"),
        tile=("#FFFFFF", "#FBFBFF", "#EBEEFC"),
        core=("#C7F9FE", "#5FE9F6", "#1FC4E4"),
        dark=("#ABA6FC", "#7C74F5", "#5B51E8"),
        core_dark=("#D9FCFF", "#5FE9F6", "#22D3EE"),
    ),
    dict(
        key="A · 提亮",
        note="#6366F1 · 渐变收窄到 13 档",
        ink=("#9A94FF", "#6366F1", "#5658EA"),
        tile=("#FFFFFF", "#FDFDFF", "#F1F2FF"),
        core=("#EEFFFF", "#7BEEFB", "#1FC3E2"),
        dark=("#C0BBFF", "#8B85FA", "#6C63F0"),
        core_dark=("#F6FFFF", "#8AF0FC", "#22CEE8"),
    ),
    dict(
        key="B · 发光核",
        note="砖不动，核中心纯白 + 外辉光",
        ink=("#7A73F5", "#4F46E5", "#4033C4"),
        tile=("#FFFFFF", "#FBFBFF", "#EBEEFC"),
        core=("#FFFFFF", "#8CF2FF", "#06B6D4"),
        dark=("#ABA6FC", "#7C74F5", "#5B51E8"),
        core_dark=("#FFFFFF", "#93F5FF", "#0EA5E9"),
        halo=True,
    ),
    dict(
        key="C · 材质",
        note="釉面扫光 + 笔触暗面 + 核边缘光",
        ink=("#928CFF", "#5A53EE", "#473CD6"),
        tile=("#FFFFFF", "#FCFCFF", "#EAEDFF"),
        core=("#E4FFFF", "#6CEAF8", "#12BBDC"),
        dark=("#B7B1FF", "#847DF8", "#655CEE"),
        core_dark=("#F6FFFF", "#7EEDFB", "#18C2DF"),
        material=True,
    ),
    dict(
        key="D · 提亮 + 轻材质",
        note="A 的色值，材质只留一层薄光",
        ink=("#918BFF", "#6366F1", "#5658EA"),
        tile=("#FFFFFF", "#FDFDFF", "#F1F2FF"),
        core=("#EEFFFF", "#7BEEFB", "#1FC3E2"),
        dark=("#C0BBFF", "#8B85FA", "#6C63F0"),
        core_dark=("#F6FFFF", "#8AF0FC", "#22CEE8"),
        material="lite",
    ),
]


def material_defs(lite=False, core_cy=114):
    sw_hi, sw_lo = ("0.24", "0.10") if lite else ("0.42", "0.22")
    sh_hi, sh_lo = ("0.38", "0.12") if lite else ("0.55", "0.22")
    thl = "0.50" if lite else "0.75"
    rim = "0.55" if lite else "0.90"
    spec = "0.70" if lite else "0.95"
    return f'''
  <clipPath id="bc"><path d="{geom.BAND}"/></clipPath>
  <clipPath id="tc"><path d="{geom.TILE}"/></clipPath>
  <linearGradient id="sweep" gradientUnits="userSpaceOnUse" x1="36" y1="18" x2="214" y2="250">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{sw_hi}"/>
    <stop offset="38%" stop-color="#FFFFFF" stop-opacity="0"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="{sw_lo}"/>
  </linearGradient>
  <linearGradient id="sheen" gradientUnits="userSpaceOnUse" x1="62" y1="54" x2="198" y2="208">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{sh_hi}"/>
    <stop offset="38%" stop-color="#FFFFFF" stop-opacity="0.05"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="{sh_lo}"/>
  </linearGradient>
  <linearGradient id="band" gradientUnits="userSpaceOnUse" x1="72" y1="92" x2="188" y2="190">
    <stop offset="0%" stop-color="#FFFFFF"/>
    <stop offset="100%" stop-color="#E7EBFB"/>
  </linearGradient>
  <linearGradient id="topHL" gradientUnits="userSpaceOnUse" x1="128" y1="16" x2="128" y2="104">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{thl}"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="rim" gradientUnits="userSpaceOnUse" x1="128" y1="104" x2="128" y2="152">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{rim}"/>
    <stop offset="46%" stop-color="#FFFFFF" stop-opacity="0.16"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="spec" gradientUnits="userSpaceOnUse" cx="119" cy="{core_cy}" r="10">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{spec}"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </radialGradient>'''


def halo_def(color="#22D3EE", op="0.38"):
    """核的外部辉光：深底上才看得出，浅底上会脏。"""
    return (f'\n  <radialGradient id="halo" gradientUnits="userSpaceOnUse" cx="128" cy="128" r="52">'
            f'\n    <stop offset="40%" stop-color="{color}" stop-opacity="{op}"/>'
            f'\n    <stop offset="100%" stop-color="{color}" stop-opacity="0"/>'
            f'\n  </radialGradient>')


def material_top(p):
    """核的玻璃层：边缘光 + 镜面高光点（纯渐变，无 filter）。"""
    if not p.get("material"):
        return ""
    return ('\n  <circle cx="128" cy="128" r="21.3" fill="none" stroke="url(#rim)" stroke-width="1.5"/>'
            '\n  <ellipse cx="119" cy="114" rx="9" ry="7" fill="url(#spec)"/>')


def svg_light(p):
    ihi, imd, ilo = p["ink"]
    thi, tmd, tlo = p["tile"]
    chi, cmd, clo = p["core"]
    mat = p.get("material", False)
    lite = mat == "lite"
    halo = p.get("halo", False)
    extra = (material_defs(lite) if mat else "") + (halo_def(op="0.26") if halo else "")
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="42" y1="18" x2="214" y2="238">
      <stop offset="0%" stop-color="{ihi}"/><stop offset="46%" stop-color="{imd}"/><stop offset="100%" stop-color="{ilo}"/>
    </linearGradient>
    <linearGradient id="tile" gradientUnits="userSpaceOnUse" x1="44" y1="20" x2="198" y2="240">
      <stop offset="0%" stop-color="{thi}"/><stop offset="58%" stop-color="{tmd}"/><stop offset="100%" stop-color="{tlo}"/>
    </linearGradient>
    <radialGradient id="core" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">
      <stop offset="0%" stop-color="{chi}"/><stop offset="44%" stop-color="{cmd}"/><stop offset="100%" stop-color="{clo}"/>
    </radialGradient>{extra}
  </defs>
  <path fill="url(#ink)" d="{geom.TILE}"/>
  {'<g clip-path="url(#tc)"><rect x="16" y="16" width="224" height="224" fill="url(#sweep)"/></g>' if mat else ""}
  {'<path fill="none" stroke="url(#topHL)" stroke-width="2" d="' + geom.TILE + '"/>' if mat else ""}
  <path fill="{'url(#band)' if mat is True else '#FFFFFF'}" d="{geom.BAND}"/>
  {'<circle cx="128" cy="128" r="52" fill="url(#halo)"/>' if halo else ""}
  <path fill="url(#core)" d="{geom.CORE_D}"/>{material_top(p)}
</svg>'''


def svg_dark(p):
    hi, md, lo = p["dark"]
    chi, cmd, clo = p["core_dark"]
    mat = p.get("material", False)
    lite = mat == "lite"
    halo = p.get("halo", False)
    extra = (material_defs(lite) if mat else "") + (halo_def() if halo else "")
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{geom.BARE_VIEWBOX}">
  <defs>
    <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="60" y1="52" x2="200" y2="210">
      <stop offset="0%" stop-color="{hi}"/><stop offset="46%" stop-color="{md}"/><stop offset="100%" stop-color="{lo}"/>
    </linearGradient>
    <radialGradient id="core" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">
      <stop offset="0%" stop-color="{chi}"/><stop offset="44%" stop-color="{cmd}"/><stop offset="100%" stop-color="{clo}"/>
    </radialGradient>{extra}
  </defs>
  <path fill="url(#ink)" d="{geom.BAND}"/>
  {'<g clip-path="url(#bc)"><rect x="44" y="44" width="168" height="168" fill="url(#sheen)"/></g>' if mat else ""}
  {'<circle cx="128" cy="128" r="52" fill="url(#halo)"/>' if halo else ""}
  <path fill="url(#core)" d="{geom.CORE_D}"/>{material_top(p)}
</svg>'''


def render(svg, size):
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")


canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255))
d = ImageDraw.Draw(canvas)
d.text((40, 24), "配色实验 · 同一几何，四套配色", font=ImageFont.truetype(FONT, 20), fill=(30, 32, 48))
d.text((40, 52), "上行浅底砖版（网页浅色区 / 打印），下行深底透明版（顶栏 / 登录页，56/32/16px）",
       font=ImageFont.truetype(FONT, 12), fill=GREY)

COL = 378
for i, p in enumerate(PALETTES):
    x0 = i * COL

    # 浅底砖版
    d.rounded_rectangle((x0 + 40, 92, x0 + 340, 368), radius=16, fill=LIGHT_BG)
    canvas.alpha_composite(render(svg_light(p), 180), (x0 + 100, 140))
    d.text((x0 + 40, 376), p["key"], font=ImageFont.truetype(FONT, 15), fill=CAPTION)
    d.text((x0 + 40, 396), p["note"], font=ImageFont.truetype(FONT, 11), fill=GREY)

    # 深底透明版
    d.rounded_rectangle((x0 + 40, 420, x0 + 340, 696), radius=16, fill=DARK_BG)
    canvas.alpha_composite(render(svg_dark(p), 180), (x0 + 100, 468))
    d.text((x0 + 40, 704), p["key"], font=ImageFont.truetype(FONT, 15), fill=CAPTION)
    d.text((x0 + 40, 724), p["note"], font=ImageFont.truetype(FONT, 11), fill=GREY)
    for size, sx in ((56, 40), (32, 108), (16, 152)):
        canvas.alpha_composite(render(svg_dark(p), size), (x0 + sx, 802 - size))

canvas.convert("RGB").save("renders/color-lab.png")
print("wrote renders/color-lab.png", canvas.size)
