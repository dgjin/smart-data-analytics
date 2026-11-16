#!/usr/bin/env python3
"""透明版（无砖）的 Apple 化实验。

砖版的质感来自两道描边：倒角亮线负责「转折」，外缘暗线负责「边界」。
透明版没有砖，但笔弧本身就是一件金属件——它有外缘和内缘两条棱。
所以同一套纪律可以直接翻译过来：

1. 明暗双向：右下压一层背光面（shade），不再只有 ink 渐变；
2. 窄镜面：受光收成 1.5px 沿棱的窄带，不是整面斜向加白；
3. 利边：一支对角渐变描边同时画两条棱——左上白色（受光棱）、
   右下深靛（背光棱收口），一笔一攻一守。

另一个悬而未决的问题是笔弧色：深底透明版一直是「提亮紫」（#E4E0FF→#7E75F8），
在白底上几乎看不见；换成品牌紫（#7C6FFF→#332CA8）则在白底与深底都站得住。
本轮把这一点一并放进对比。
"""
import io

import cairosvg
from PIL import Image, ImageDraw, ImageFont

import geom

FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
LABEL_W, CELL_W, HEAD_H = 300, 400, 130
CELL_H = 300
BGS = [
    ("纯白 #FFFFFF", (255, 255, 255), (30, 41, 59)),
    ("浅灰 #F8FAFC", (248, 250, 252), (30, 41, 59)),
    ("slate-900", (15, 23, 42), (226, 232, 240)),
    ("深靛 #1E1B4B", (30, 27, 75), (226, 232, 240)),
]

BRAND_INK = ("#7C6FFF", "#5B54F2", "#332CA8")
HI_INK = ("#E4E0FF", "#A79FFF", "#7E75F8")
CORE_LIGHT = ("#F2FFFF", "#8AF0FD", "#1FC5E6")
CORE_DARK = ("#FFFFFF", "#9CF4FF", "#22D6EF")

# arcEdge：一笔两棱。左上半段白色受光，右下段深靛收口
ARC = ("#FFFFFF", 0.95, 0.38, "#0B0730", 0.50)


def lum(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


SCHEMES = [
    dict(key="H · 现状", note="提亮紫 + 整面斜光 + 白轮廓",
         ink=HI_INK, core=CORE_DARK, sheen=0.46, shade=0.0, arc=None, edge=(0.80, 0.18)),
    dict(key="A · 只换品牌紫", note="同结构，色改回品牌紫",
         ink=BRAND_INK, core=CORE_LIGHT, sheen=0.46, shade=0.0, arc=None, edge=(0.80, 0.18)),
    dict(key="B · 单笔双棱", note="品牌紫 + arcEdge，去掉整面光",
         ink=BRAND_INK, core=CORE_LIGHT, sheen=0.0, shade=0.0, arc=ARC, edge=None),
    dict(key="C · 双棱+背光面", note="再加 shade .16 与收窄 sheen .24",
         ink=BRAND_INK, core=CORE_LIGHT, sheen=0.24, shade=0.16, arc=ARC, edge=None),
    dict(key="D · 提亮+双棱", note="保留深底发光感，补利边",
         ink=HI_INK, core=CORE_DARK, sheen=0.34, shade=0.10, arc=ARC, edge=None),
]


def svg_bare(p):
    ink_hi, ink_md, ink_lo = p["ink"]
    core_hi, core_md, core_lo = p["core"]
    d = []
    d.append('<defs>')
    d.append(f'<linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="60" y1="52" x2="200" y2="210">'
             f'<stop offset="0%" stop-color="{ink_hi}"/><stop offset="46%" stop-color="{ink_md}"/>'
             f'<stop offset="100%" stop-color="{ink_lo}"/></linearGradient>')
    d.append(f'<radialGradient id="core" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">'
             f'<stop offset="0%" stop-color="{core_hi}"/><stop offset="44%" stop-color="{core_md}"/>'
             f'<stop offset="100%" stop-color="{core_lo}"/></radialGradient>')
    if p["sheen"]:
        d.append(f'<linearGradient id="sheen" gradientUnits="userSpaceOnUse" x1="62" y1="54" x2="198" y2="208">'
                 f'<stop offset="0%" stop-color="#FFFFFF" stop-opacity="{p["sheen"]}"/>'
                 f'<stop offset="38%" stop-color="#FFFFFF" stop-opacity="0.05"/>'
                 f'<stop offset="100%" stop-color="#000000" stop-opacity="0"/></linearGradient>')
    if p["shade"]:
        d.append(f'<linearGradient id="shade" gradientUnits="userSpaceOnUse" x1="62" y1="54" x2="200" y2="210">'
                 f'<stop offset="0%" stop-color="#140E45" stop-opacity="0"/>'
                 f'<stop offset="46%" stop-color="#140E45" stop-opacity="0"/>'
                 f'<stop offset="100%" stop-color="#140E45" stop-opacity="{p["shade"]}"/></linearGradient>')
    if p["arc"]:
        w_hi, o_hi, o_mid, dark, o_dark = p["arc"]
        d.append(f'<linearGradient id="arc" gradientUnits="userSpaceOnUse" x1="62" y1="50" x2="206" y2="212">'
                 f'<stop offset="0%" stop-color="{w_hi}" stop-opacity="{o_hi}"/>'
                 f'<stop offset="24%" stop-color="{w_hi}" stop-opacity="{o_mid}"/>'
                 f'<stop offset="50%" stop-color="{w_hi}" stop-opacity="0"/>'
                 f'<stop offset="72%" stop-color="{dark}" stop-opacity="0"/>'
                 f'<stop offset="100%" stop-color="{dark}" stop-opacity="{o_dark}"/></linearGradient>')
    if p["edge"]:
        e_hi, e_mid = p["edge"]
        d.append(f'<linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="128" y1="48" x2="128" y2="204">'
                 f'<stop offset="0%" stop-color="#FFFFFF" stop-opacity="{e_hi}"/>'
                 f'<stop offset="52%" stop-color="#FFFFFF" stop-opacity="{e_mid}"/>'
                 f'<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>')
    d.append(f'<linearGradient id="rim" gradientUnits="userSpaceOnUse" x1="128" y1="104" x2="128" y2="152">'
             f'<stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.88"/>'
             f'<stop offset="46%" stop-color="#FFFFFF" stop-opacity="0.20"/>'
             f'<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>')
    d.append('<radialGradient id="spec" gradientUnits="userSpaceOnUse" cx="119" cy="113" r="8">'
             '<stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.96"/>'
             '<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>')
    d.append('<radialGradient id="cbounce" gradientUnits="userSpaceOnUse" cx="128" cy="144" r="15">'
             '<stop offset="0%" stop-color="#9CF4FF" stop-opacity="0.50"/>'
             '<stop offset="100%" stop-color="#9CF4FF" stop-opacity="0"/></radialGradient>')
    d.append('</defs>')

    body = [f'<path fill="url(#ink)" d="{geom.BAND}"/>']
    if p["sheen"]:
        body.append(f'<path fill="url(#sheen)" d="{geom.BAND}"/>')
    if p["shade"]:
        body.append(f'<path fill="url(#shade)" d="{geom.BAND}"/>')
    if p["arc"]:
        body.append(f'<path fill="none" stroke="url(#arc)" stroke-width="1.5" d="{geom.BAND}"/>')
    if p["edge"]:
        body.append(f'<path fill="none" stroke="url(#edge)" stroke-width="1.4" d="{geom.BAND}"/>')
    body.append(f'<path fill="url(#core)" d="{geom.CORE_D}"/>')
    body.append('<circle cx="128" cy="128" r="21.3" fill="none" stroke="url(#rim)" stroke-width="1"/>')
    body.append('<ellipse cx="119" cy="113" rx="7.5" ry="6" fill="url(#spec)"/>')
    body.append('<ellipse cx="128" cy="141" rx="12" ry="4" fill="url(#cbounce)"/>')

    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="44 44 168 168" width="256" height="256">'
            + "".join(d) + "".join(body) + '</svg>')


def render(svg, px):
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=px, output_height=px)
    return Image.open(io.BytesIO(png)).convert("RGBA")


W = LABEL_W + CELL_W * len(BGS)
H = HEAD_H + CELL_H * len(SCHEMES)
img = Image.new("RGB", (W, H), (252, 252, 253))
dr = ImageDraw.Draw(img)
font_t = ImageFont.truetype(FONT, 30)
font_s = ImageFont.truetype(FONT, 20)
font_c = ImageFont.truetype(FONT, 17)

dr.text((28, 26), "透明版（无砖）Apple 化对照 — 5 变体 × 4 底色", font=font_t, fill=(17, 24, 39))
dr.text((28, 70), "每格：96px 看质感 / 56px 看真实顶栏尺寸；笔弧色与「边」的做法是两条独立变量",
        font=font_s, fill=(100, 116, 139))

for ci, (name, bg, fg) in enumerate(BGS):
    x = LABEL_W + ci * CELL_W
    dr.rectangle([x + 4, HEAD_H - 46, x + CELL_W - 4, H - 8], fill=bg)
    dr.text((x + 20, HEAD_H - 40), name, font=font_c, fill=fg)

for ri, p in enumerate(SCHEMES):
    y = HEAD_H + ri * CELL_H
    dr.text((28, y + 90), p["key"], font=font_t, fill=(17, 24, 39))
    dr.text((28, y + 132), p["note"], font=font_s, fill=(100, 116, 139))
    svg = svg_bare(p)
    for ci, (_, bg, _) in enumerate(BGS):
        x = LABEL_W + ci * CELL_W
        big = render(svg, 96)
        img.paste(big, (x + 60, y + 40), big)
        small = render(svg, 56)
        img.paste(small, (x + 210, y + 60), small)
        # 对比度标注（取渐变中段）
        c = contrast(p["ink"][1], "#%02X%02X%02X" % bg)
        dr.text((x + 210, y + 128), f"{c:.2f}:1", font=font_c, fill=(160, 168, 182))

img.save("renders/bare-lab.png")
print("wrote renders/bare-lab.png", img.size)
