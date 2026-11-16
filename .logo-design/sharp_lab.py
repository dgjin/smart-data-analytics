#!/usr/bin/env python3
"""亮度与锐度实验：现状 D vs E（基色提亮）vs F（高光爆亮 + 玻璃质感）。

只动色值与光效层，不动几何。三列同一几何、同一底色，直接横向比。

诊断：D 之所以显得「暗」，是因为砖的中段 #6366F1 明度只有 65%，
白笔弧要跳出来又要求砖不能太浅——两头夹住了。破法是拉大砖的
「受光跨度」（左上接近白紫、右下仍饱和），而不是整体加白。
"""
import io

import cairosvg
from PIL import Image, ImageDraw, ImageFont

import geom

FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
W, H = 1500, 1180
COL = 500
LIGHT_BG = (246, 247, 250)
DARK_BG = (15, 23, 42)
GREY = (108, 116, 134)
CAPTION = (99, 102, 241)

SCHEMES = [
    dict(
        key="D · 现状",
        note="#6366F1 · sweep .24/.10",
        ink=("#918BFF", "#6366F1", "#5658EA"),
        tile=("#FFFFFF", "#FDFDFF", "#F1F2FF"),
        core=("#EEFFFF", "#7BEEFB", "#1FC3E2"),
        dark=("#C0BBFF", "#8B85FA", "#6C63F0"),
        core_dark=("#F6FFFF", "#8AF0FC", "#22CEE8"),
        glass=False,
    ),
    dict(
        key="E · 基色提亮",
        note="#7375F8 · 同跨度整体 +8",
        ink=("#B0AAFF", "#7375F8", "#5C5EF2"),
        tile=("#FFFFFF", "#FDFDFF", "#F2F3FF"),
        core=("#F2FFFF", "#86F0FD", "#1FC9E8"),
        dark=("#D2CDFF", "#9B93FF", "#7A72F7"),
        core_dark=("#FAFFFF", "#96F2FE", "#22D2EC"),
        glass=False,
    ),
    dict(
        key="F · 爆亮 + 玻璃",
        note="左上接白 + 轮廓光 + 底部反光",
        ink=("#C9C4FF", "#7B7AF9", "#5A5CF0"),
        tile=("#FFFFFF", "#FDFDFF", "#F2F3FF"),
        core=("#F6FFFF", "#8CF2FE", "#1FCBE9"),
        dark=("#E4E0FF", "#A79FFF", "#7E75F8"),
        core_dark=("#FFFFFF", "#9CF4FF", "#22D6EF"),
        glass=True,
    ),
]


def defs(p):
    """色板 + 光效层。glass=False 走 D 的 lite 材质，glass=True 换成只加光不加暗。"""
    ihi, imd, ilo = p["ink"]
    thi, tmd, tlo = p["tile"]
    chi, cmd, clo = p["core"]
    hi, md, lo = p["dark"]
    dhi, dmd, dlo = p["core_dark"]
    glass = p["glass"]
    sweep = ("0.34", "0") if glass else ("0.24", "0.10")
    sheen = ("0.46", "0") if glass else ("0.38", "0.12")
    extra = ""
    if glass:
        # 主光斑：左上聚光，像玻璃球的高光区；底部反光模拟环境回弹
        extra += ('''
  <radialGradient id="spot" gradientUnits="userSpaceOnUse" cx="82" cy="66" r="130">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.24"/>
    <stop offset="55%" stop-color="#FFFFFF" stop-opacity="0.07"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="bounce" gradientUnits="userSpaceOnUse" x1="128" y1="168" x2="128" y2="240">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0"/>
    <stop offset="100%" stop-color="#C8DEFF" stop-opacity="0.22"/>
  </linearGradient>
  <linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="128" y1="48" x2="128" y2="204">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.80"/>
    <stop offset="52%" stop-color="#FFFFFF" stop-opacity="0.18"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="cbounce" gradientUnits="userSpaceOnUse" cx="128" cy="144" r="15">
    <stop offset="0%" stop-color="#9CF4FF" stop-opacity="0.50"/>
    <stop offset="100%" stop-color="#9CF4FF" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="edgeLine" gradientUnits="userSpaceOnUse" x1="40" y1="40" x2="232" y2="232">
    <stop offset="0%" stop-color="#3F3AA8" stop-opacity="0.10"/>
    <stop offset="55%" stop-color="#3F3AA8" stop-opacity="0.22"/>
    <stop offset="100%" stop-color="#322D8C" stop-opacity="0.38"/>
  </linearGradient>''')
    return f'''<defs>
  <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="42" y1="18" x2="214" y2="238">
    <stop offset="0%" stop-color="{ihi}"/><stop offset="46%" stop-color="{imd}"/><stop offset="100%" stop-color="{ilo}"/>
  </linearGradient>
  <linearGradient id="tile" gradientUnits="userSpaceOnUse" x1="44" y1="20" x2="198" y2="240">
    <stop offset="0%" stop-color="{thi}"/><stop offset="58%" stop-color="{tmd}"/><stop offset="100%" stop-color="{tlo}"/>
  </linearGradient>
  <radialGradient id="core" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">
    <stop offset="0%" stop-color="{chi}"/><stop offset="44%" stop-color="{cmd}"/><stop offset="100%" stop-color="{clo}"/>
  </radialGradient>
  <linearGradient id="inkDark" gradientUnits="userSpaceOnUse" x1="60" y1="52" x2="200" y2="210">
    <stop offset="0%" stop-color="{hi}"/><stop offset="46%" stop-color="{md}"/><stop offset="100%" stop-color="{lo}"/>
  </linearGradient>
  <radialGradient id="coreDark" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">
    <stop offset="0%" stop-color="{dhi}"/><stop offset="44%" stop-color="{dmd}"/><stop offset="100%" stop-color="{dlo}"/>
  </radialGradient>
  <linearGradient id="sweep" gradientUnits="userSpaceOnUse" x1="36" y1="18" x2="214" y2="250">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{sweep[0]}"/>
    <stop offset="38%" stop-color="#FFFFFF" stop-opacity="0"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="{sweep[1]}"/>
  </linearGradient>
  <linearGradient id="sheen" gradientUnits="userSpaceOnUse" x1="62" y1="54" x2="198" y2="208">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{sheen[0]}"/>
    <stop offset="38%" stop-color="#FFFFFF" stop-opacity="0.05"/>
    <stop offset="100%" stop-color="#000000" stop-opacity="{sheen[1]}"/>
  </linearGradient>
  <linearGradient id="topHL" gradientUnits="userSpaceOnUse" x1="128" y1="16" x2="128" y2="104">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{0.62 if glass else 0.50}"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="rim" gradientUnits="userSpaceOnUse" x1="128" y1="104" x2="128" y2="152">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{0.88 if glass else 0.55}"/>
    <stop offset="46%" stop-color="#FFFFFF" stop-opacity="0.20"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="spec" gradientUnits="userSpaceOnUse" cx="119" cy="113" r="{8 if glass else 10}">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="{0.96 if glass else 0.70}"/>
    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
  </radialGradient>{extra}
</defs>'''


def glass_layers(p, on_dark):
    """F 的玻璃层：主光斑 / 底部反光 / 笔弧轮廓光 / 核底反光。"""
    if not p["glass"]:
        return ""
    if on_dark:
        return ('\n  <path fill="none" stroke="url(#edge)" stroke-width="1.4" d="' + geom.BAND + '"/>'
                '\n  <path fill="url(#coreDark)" d="' + geom.CORE_D + '"/>')
    return ('\n  <path fill="url(#spot)" d="' + geom.TILE + '"/>'
            '\n  <path fill="url(#bounce)" d="' + geom.TILE + '"/>'
            '\n  <path fill="none" stroke="url(#edgeLine)" stroke-width="1.6" d="' + geom.TILE + '"/>'
            '\n  <path fill="none" stroke="url(#topHL)" stroke-width="2" d="' + geom.TILE + '"/>'
            '\n  <path fill="#FFFFFF" d="' + geom.BAND + '"/>'
            '\n  <path fill="url(#core)" d="' + geom.CORE_D + '"/>')


def core_top(p):
    """核的玻璃顶：窄边缘光 + 小镜面点（F 再加底部反光）。"""
    g = p["glass"]
    out = (f'\n  <circle cx="128" cy="128" r="21.3" fill="none" stroke="url(#rim)" '
           f'stroke-width="{1 if g else 1.5}"/>'
           f'\n  <ellipse cx="119" cy="113" rx="{7.5 if g else 9}" ry="{6 if g else 7}" fill="url(#spec)"/>')
    if g:
        out += '\n  <ellipse cx="128" cy="141" rx="12" ry="4" fill="url(#cbounce)"/>'
    return out


def svg_light(p):
    body = defs(p)
    if p["glass"]:
        inner = glass_layers(p, False) + core_top(p)
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">{body}'
                f'\n  <path fill="url(#ink)" d="{geom.TILE}"/>'
                f'\n  <path fill="url(#sweep)" d="{geom.TILE}"/>{inner}\n</svg>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">{body}'
            f'\n  <path fill="url(#ink)" d="{geom.TILE}"/>'
            f'\n  <path fill="url(#sweep)" d="{geom.TILE}"/>'
            f'\n  <path fill="none" stroke="url(#topHL)" stroke-width="2" d="{geom.TILE}"/>'
            f'\n  <path fill="#FFFFFF" d="{geom.BAND}"/>'
            f'\n  <path fill="url(#core)" d="{geom.CORE_D}"/>{core_top(p)}\n</svg>')


def svg_dark(p):
    body = defs(p)
    if p["glass"]:
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{geom.BARE_VIEWBOX}">{body}'
                f'\n  <path fill="url(#inkDark)" d="{geom.BAND}"/>'
                f'\n  <path fill="url(#sheen)" d="{geom.BAND}"/>'
                f'\n  <path fill="none" stroke="url(#edge)" stroke-width="1.4" d="{geom.BAND}"/>'
                f'\n  <path fill="url(#coreDark)" d="{geom.CORE_D}"/>{core_top(p)}\n</svg>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{geom.BARE_VIEWBOX}">{body}'
            f'\n  <path fill="url(#inkDark)" d="{geom.BAND}"/>'
            f'\n  <path fill="url(#sheen)" d="{geom.BAND}"/>'
            f'\n  <path fill="url(#coreDark)" d="{geom.CORE_D}"/>{core_top(p)}\n</svg>')


def render(svg, size):
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def mean_lum(img):
    """笔弧区域的平均相对亮度（0..1），用于量化「亮了多少」。"""
    px = img.convert("RGB").resize((64, 64), Image.LANCZOS).load()
    vals = []
    for y in range(10, 54):
        for x in range(10, 54):
            r, g, b = px[x, y]
            if b > 90 and b > r + 20:  # 只取紫色笔弧，跳过青色核
                vals.append((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255)
    return sum(vals) / len(vals) if vals else 0.0


canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255))
d = ImageDraw.Draw(canvas)
d.text((40, 22), "亮度 / 锐度实验 · 同一几何，三套光效", font=ImageFont.truetype(FONT, 20), fill=(30, 32, 48))
d.text((40, 50), "上行浅底砖版 · 中行深底透明版（括号内为笔弧平均亮度）· 下行小尺寸 + 2 倍细节",
       font=ImageFont.truetype(FONT, 12), fill=GREY)

for i, p in enumerate(SCHEMES):
    x0 = i * COL
    d.text((x0 + 40, 86), p["key"], font=ImageFont.truetype(FONT, 16), fill=CAPTION)
    d.text((x0 + 40, 108), p["note"], font=ImageFont.truetype(FONT, 11), fill=GREY)

    # 浅底
    d.rounded_rectangle((x0 + 40, 132, x0 + 460, 420), radius=16, fill=LIGHT_BG)
    canvas.alpha_composite(render(svg_light(p), 220), (x0 + 140, 166))

    # 深底
    d.rounded_rectangle((x0 + 40, 436, x0 + 460, 724), radius=16, fill=DARK_BG)
    big = render(svg_dark(p), 220)
    canvas.alpha_composite(big, (x0 + 140, 470))
    lum = mean_lum(big)
    d.text((x0 + 40, 730), f"笔弧平均亮度 {lum * 100:.0f}%", font=ImageFont.truetype(FONT, 12), fill=CAPTION)

    # 小尺寸（贴在深底块内右下，不压标题）
    for size, sx in ((56, 330), (32, 396)):
        canvas.alpha_composite(render(svg_dark(p), size), (x0 + sx, 724 - size - 8))

    # 2 倍细节：核与笔弧的接缝（渲染 440px 时核心在 220,220）
    zoom = render(svg_dark(p), 440)
    crop = zoom.crop((96, 96, 344, 344))
    d.rounded_rectangle((x0 + 40, 756, x0 + 460, 1104), radius=16, fill=DARK_BG)
    canvas.alpha_composite(crop, (x0 + 130, 770))
    d.text((x0 + 40, 1116), "2x detail", font=ImageFont.truetype(FONT, 11), fill=GREY)

canvas.convert("RGB").save("renders/sharp-lab.png")
print("wrote renders/sharp-lab.png", canvas.size)
