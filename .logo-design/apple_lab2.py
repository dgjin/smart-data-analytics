#!/usr/bin/env python3
"""第二轮：确定材质强度。色相不动，只改「怎么打光」。

第一轮的结论：
- 浅化（#AEA7FF）先把色饱和度冲掉了——这是「发灰」的真正来源，不是亮度低；
- 大径向光斑（spot .16）是大面积抬灰的第二个来源，删掉；
- 明暗幅度一旦过大就变成「玻璃按钮」，不是 Apple——Apple 的亮度差是克制的。

所以本轮的配方只有三件事，并且全部靠「边」而不是「面」：
1. 砖顶一条贴边亮线（1.4–1.6px 描边，垂直渐变），这是机加工的倒角；
2. 砖身极缓的上下渐变，高光端保持高彩度（#7C6FFF 而不是 #AEA7FF）；
3. 右下背光面轻压 + 外缘 1.4px 暗线收口，把边界「切」出来。

材质从轻到重四档 + 一个纯平面档，用真实尺寸（顶栏 56px）定夺。
"""
import io

import cairosvg
from PIL import Image, ImageDraw, ImageFont

import geom

FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
W, H = 2100, 1310
COL = 420
LIGHT_BG = (245, 246, 250)
DARK_BG = (15, 23, 42)
GREY = (108, 116, 134)
CAPTION = (99, 102, 241)

DARK_INK = ("#E4E0FF", "#A79FFF", "#7E75F8")
DARK_CORE = ("#FFFFFF", "#9CF4FF", "#22D6EF")
CORE = ("#F2FFFF", "#8AF0FD", "#1FC5E6")

SCHEMES = [
    dict(
        key="H · 现状", note="淡紫渐变 + 大光斑",
        ink=[("#AEA7FF", 0), ("#5B54F2", 46), ("#3F37D2", 100)],
        bezel=(0, 0, 0), soft=(104, 0.62), shade=0.0, bounce=0.24, edge=0.30,
    ),
    dict(
        key="M1 · 轻材质", note="只加倒角亮线",
        ink=[("#6F64FF", 0), ("#5B54F2", 45), ("#453DD8", 100)],
        bezel=(44, 0.50, 1.4), soft=(56, 0.16), shade=0.10, bounce=0.12, edge=0.22,
    ),
    dict(
        key="M2 · 中材质", note="倒角 + 缓降，推荐",
        ink=[("#7C6FFF", 0), ("#5B54F2", 45), ("#332CA8", 100)],
        bezel=(46, 0.70, 1.5), soft=(64, 0.26), shade=0.18, bounce=0.10, edge=0.28,
    ),
    dict(
        key="M3 · 重材质", note="再压一档",
        ink=[("#8B7EFF", 0), ("#5B54F2", 42), ("#2A2390", 100)],
        bezel=(50, 0.85, 1.6), soft=(72, 0.34), shade=0.26, bounce=0.08, edge=0.34,
    ),
    dict(
        key="F · 纯平面", note="零渐变，只留倒角与利边",
        ink=[("#5B54F2", 0), ("#5B54F2", 100)],
        bezel=(40, 0.55, 1.5), soft=(0, 0), shade=0.0, bounce=0.0, edge=0.30,
    ),
]


def lum(hex_color):
    c = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast_white(hex_color):
    return 1.05 / (lum(hex_color) + 0.05)


def mid_stop(p):
    for c, o in p["ink"]:
        if o >= 34:
            return c
    return p["ink"][-1][0]


def defs(p):
    base = "".join(f'<stop offset="{o}%" stop-color="{c}"/>' for c, o in p["ink"])
    by, bop, bw = p["bezel"]
    sy, sop = p["soft"]
    out = [
        f'<linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="42" y1="18" x2="214" y2="238">{base}</linearGradient>',
        # 倒角亮线：整条路径描边，但只有顶端一段落在渐变里
        f'<linearGradient id="bezel" gradientUnits="userSpaceOnUse" x1="128" y1="16" x2="128" y2="{max(by, 17)}">'
        f'<stop offset="0%" stop-color="#FFFFFF" stop-opacity="{bop}"/>'
        f'<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>',
        # 砖身柔光：低强度、宽衰减
        f'<linearGradient id="soft" gradientUnits="userSpaceOnUse" x1="128" y1="16" x2="128" y2="{max(sy, 17)}">'
        f'<stop offset="0%" stop-color="#FFFFFF" stop-opacity="{sop}"/>'
        f'<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>',
        # 背光面：右下压深
        '<linearGradient id="shade" gradientUnits="userSpaceOnUse" x1="52" y1="48" x2="238" y2="240">'
        '<stop offset="0%" stop-color="#1B1550" stop-opacity="0"/>'
        '<stop offset="50%" stop-color="#1B1550" stop-opacity="0"/>'
        f'<stop offset="100%" stop-color="#1B1550" stop-opacity="{p["shade"]}"/></linearGradient>',
        # 砖底冷反光
        '<linearGradient id="bounce" gradientUnits="userSpaceOnUse" x1="128" y1="180" x2="128" y2="240">'
        '<stop offset="0%" stop-color="#C8DEFF" stop-opacity="0"/>'
        f'<stop offset="100%" stop-color="#C8DEFF" stop-opacity="{p["bounce"]}"/></linearGradient>',
        # 外缘暗线
        '<linearGradient id="edgeLine" gradientUnits="userSpaceOnUse" x1="40" y1="40" x2="232" y2="232">'
        '<stop offset="0%" stop-color="#221C6E" stop-opacity="0.05"/>'
        f'<stop offset="55%" stop-color="#221C6E" stop-opacity="{p["edge"] * 0.65:.3f}"/>'
        f'<stop offset="100%" stop-color="#1A1458" stop-opacity="{p["edge"]}"/></linearGradient>',
        '<radialGradient id="core" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">'
        f'<stop offset="0%" stop-color="{CORE[0]}"/><stop offset="44%" stop-color="{CORE[1]}"/>'
        f'<stop offset="100%" stop-color="{CORE[2]}"/></radialGradient>',
        '<linearGradient id="rim" gradientUnits="userSpaceOnUse" x1="128" y1="104" x2="128" y2="152">'
        '<stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.88"/>'
        '<stop offset="46%" stop-color="#FFFFFF" stop-opacity="0.2"/>'
        '<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>',
        '<radialGradient id="cspec" gradientUnits="userSpaceOnUse" cx="119" cy="113" r="8">'
        '<stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.96"/>'
        '<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>',
        '<radialGradient id="cbounce" gradientUnits="userSpaceOnUse" cx="128" cy="144" r="15">'
        '<stop offset="0%" stop-color="#9CF4FF" stop-opacity="0.5"/>'
        '<stop offset="100%" stop-color="#9CF4FF" stop-opacity="0"/></radialGradient>',
        # 深底透明版（不动）
        '<linearGradient id="inkDark" gradientUnits="userSpaceOnUse" x1="60" y1="52" x2="200" y2="210">'
        f'<stop offset="0%" stop-color="{DARK_INK[0]}"/><stop offset="46%" stop-color="{DARK_INK[1]}"/>'
        f'<stop offset="100%" stop-color="{DARK_INK[2]}"/></linearGradient>',
        '<radialGradient id="coreDark" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">'
        f'<stop offset="0%" stop-color="{DARK_CORE[0]}"/><stop offset="44%" stop-color="{DARK_CORE[1]}"/>'
        f'<stop offset="100%" stop-color="{DARK_CORE[2]}"/></radialGradient>',
        '<linearGradient id="sheen" gradientUnits="userSpaceOnUse" x1="62" y1="54" x2="198" y2="208">'
        '<stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.46"/>'
        '<stop offset="38%" stop-color="#FFFFFF" stop-opacity="0.05"/>'
        '<stop offset="100%" stop-color="#000000" stop-opacity="0"/></linearGradient>',
        '<linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="128" y1="48" x2="128" y2="204">'
        '<stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.8"/>'
        '<stop offset="52%" stop-color="#FFFFFF" stop-opacity="0.18"/>'
        '<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>',
    ]
    return "<defs>" + "".join(out) + "</defs>"


def core_top():
    return ('<circle cx="128" cy="128" r="21.3" fill="none" stroke="url(#rim)" stroke-width="1"/>'
            '<ellipse cx="119" cy="113" rx="7.5" ry="6" fill="url(#cspec)"/>'
            '<ellipse cx="128" cy="141" rx="12" ry="4" fill="url(#cbounce)"/>')


def svg_tile(p):
    by, bop, bw = p["bezel"]
    layers = [f'<path fill="url(#ink)" d="{geom.TILE}"/>']
    if p["soft"][1]:
        layers.append(f'<path fill="url(#soft)" d="{geom.TILE}"/>')
    if p["shade"]:
        layers.append(f'<path fill="url(#shade)" d="{geom.TILE}"/>')
    if p["bounce"]:
        layers.append(f'<path fill="url(#bounce)" d="{geom.TILE}"/>')
    layers.append(f'<path fill="none" stroke="url(#edgeLine)" stroke-width="1.4" d="{geom.TILE}"/>')
    if bop:
        layers.append(f'<path fill="none" stroke="url(#bezel)" stroke-width="{bw}" d="{geom.TILE}"/>')
    layers += [
        f'<path fill="#FFFFFF" d="{geom.BAND}"/>',
        f'<path fill="url(#core)" d="{geom.CORE_D}"/>',
        core_top(),
    ]
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">{defs(p)}' + "".join(layers) + "</svg>"


def svg_dark():
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{geom.BARE_VIEWBOX}">{defs(SCHEMES[0])}'
            f'<path fill="url(#inkDark)" d="{geom.BAND}"/>'
            f'<path fill="url(#sheen)" d="{geom.BAND}"/>'
            f'<path fill="none" stroke="url(#edge)" stroke-width="1.4" d="{geom.BAND}"/>'
            f'<path fill="url(#coreDark)" d="{geom.CORE_D}"/>{core_top()}</svg>')


def svg_flat(p):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">'
            f'<path fill="{mid_stop(p)}" d="{geom.TILE}"/>'
            f'<path fill="#FFFFFF" d="{geom.FAV_BAND}"/>'
            f'<path fill="{geom.ACCENT}" d="{geom.FAV_CORE}"/></svg>')


def render(svg, size):
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")


canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255))
d = ImageDraw.Draw(canvas)
d.text((40, 22), "材质强度定档 · 色相不动，只改打光", font=ImageFont.truetype(FONT, 21), fill=(30, 32, 48))
d.text((40, 54), "220px 砖版 · 顶栏实景 56px（深/浅）· 小尺寸 48/32/16 · 2 倍细节",
       font=ImageFont.truetype(FONT, 12), fill=GREY)

for i, p in enumerate(SCHEMES):
    x0 = i * COL
    d.text((x0 + 22, 86), p["key"], font=ImageFont.truetype(FONT, 17), fill=CAPTION)
    d.text((x0 + 22, 108), f"{mid_stop(p)} · 白弧 {contrast_white(mid_stop(p)):.1f}:1 · {p['note']}",
           font=ImageFont.truetype(FONT, 11), fill=GREY)

    d.rounded_rectangle((x0 + 22, 132, x0 + 398, 380), radius=14, fill=LIGHT_BG)
    canvas.alpha_composite(render(svg_tile(p), 210), (x0 + 106, 150))

    # 顶栏实景：56px，深底（实际用法）与浅底
    d.rounded_rectangle((x0 + 22, 396, x0 + 398, 470), radius=10, fill=DARK_BG)
    canvas.alpha_composite(render(svg_tile(p), 56), (x0 + 38, 405))
    d.text((x0 + 106, 416), "智能问数分析系统", font=ImageFont.truetype(FONT, 13), fill=(226, 232, 240))
    d.text((x0 + 106, 438), "NL2SQL PRO", font=ImageFont.truetype(FONT, 9), fill=(148, 163, 184))

    d.rounded_rectangle((x0 + 22, 482, x0 + 398, 556), radius=10, fill=(255, 255, 255), outline=(226, 232, 240))
    canvas.alpha_composite(render(svg_tile(p), 56), (x0 + 38, 491))
    d.text((x0 + 106, 502), "智能问数分析系统", font=ImageFont.truetype(FONT, 13), fill=(30, 41, 59))
    d.text((x0 + 106, 524), "NL2SQL PRO", font=ImageFont.truetype(FONT, 9), fill=(100, 116, 139))

    # 小尺寸
    base_y = 610
    x = x0 + 26
    for size in (48, 32, 16):
        canvas.alpha_composite(render(svg_tile(p), size), (x, base_y - size))
        x += size + 20
    d.text((x0 + 26, base_y + 8), "砖版", font=ImageFont.truetype(FONT, 10), fill=GREY)
    x = x0 + 190
    for size in (48, 32, 16):
        canvas.alpha_composite(render(svg_flat(p), size), (x, base_y - size))
        x += size + 20
    d.text((x0 + 190, base_y + 8), "平面", font=ImageFont.truetype(FONT, 10), fill=GREY)

    # 2x 细节
    zoom = render(svg_tile(p), 440)
    crop = zoom.crop((90, 90, 354, 354))
    d.rounded_rectangle((x0 + 22, 652, x0 + 398, 918), radius=14, fill=LIGHT_BG)
    canvas.alpha_composite(crop, (x0 + 99, 660))

    # 深底透明版
    d.rounded_rectangle((x0 + 22, 934, x0 + 398, 1206), radius=14, fill=DARK_BG)
    canvas.alpha_composite(render(svg_dark(), 200), (x0 + 110, 972))

canvas.convert("RGB").save("renders/apple-lab2.png")
print("wrote renders/apple-lab2.png", canvas.size)
for p in SCHEMES:
    print(f"  {p['key']}: {mid_stop(p)} 白弧 {contrast_white(mid_stop(p)):.2f}:1")
