#!/usr/bin/env python3
"""苹果式质感实验：把砖当成一块真实的固态表面来打光。

诊断——Apple 的记号看起来「贵」，不是颜色更艳，是三条物理纪律：

1. **明暗双向**：有受光面，也一定有背光面。我们上一版把所有暗端设成 0
   （注释原话「光效只做加法」），于是砖上只剩几层加白的薄雾：没有体积，
   看起来平、发灰、不突出。
2. **高光是窄带，不是大光斑**：Apple 的 specular 贴着转折边，衰减极快。
   大半径径向光斑只会把砖整片抬灰——这正是上一轮 F 方案的失败原因。
3. **边缘要利**：一圈细暗线 + 一条贴边的窄亮线收口。不用 glow、不用 filter。

所以本轮把「只做加法」改成「双向 + 窄高光 + 利边」，并测试笔弧本身该不该
也做成材质（E 组）：现代 Apple 是「平面字形 + 材质表面」，经典 Apple 是
「金属字形」。两条路都能叫 Apple，观感差很远。

镜面窄带收在 y16→64：笔弧最上缘在 y≈88，高光绝不侵入笔弧足迹，
白弧的对比度因此不会被自己的高光吃掉。
"""
import io

import cairosvg
from PIL import Image, ImageDraw, ImageFont

import geom

FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
W, H = 2100, 1250
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
        key="H · 现状",
        note="单向加白，暗端归零",
        ink=[("#AEA7FF", 0), ("#5B54F2", 46), ("#3F37D2", 100)],
        spec=(104, 0.62), shade=0.0, shadeColor="#221C6E",
        spot=(66, 130, 0.16), bounce=0.24, edge=0.30, rimlight=0.0,
        core=CORE, arc="solid",
    ),
    dict(
        key="A · 铝面",
        note="四段金属带，背光面 .20",
        ink=[("#A9A3FF", 0), ("#6E68F8", 34), ("#4A43DF", 72), ("#5A53EC", 100)],
        spec=(64, 0.52), shade=0.20, shadeColor="#1B1550",
        spot=None, bounce=0.10, edge=0.28, rimlight=0.0,
        core=CORE, arc="solid",
    ),
    dict(
        key="B · 深空",
        note="压得更深，镜面更亮",
        ink=[("#6E67FF", 0), ("#4A43E8", 38), ("#241E8C", 100)],
        spec=(60, 0.62), shade=0.24, shadeColor="#120C3A",
        spot=None, bounce=0.08, edge=0.34, rimlight=0.0,
        core=CORE, arc="solid",
    ),
    dict(
        key="C · 玻璃",
        note="柔光缓降，明暗差最小",
        ink=[("#7C76FF", 0), ("#5D56F4", 42), ("#4740D6", 100)],
        spec=(96, 0.38), shade=0.10, shadeColor="#2A2480",
        spot=(70, 110, 0.10), bounce=0.16, edge=0.18, rimlight=0.0,
        core=CORE, arc="solid",
    ),
    dict(
        key="D · 石墨",
        note="近黑底 + 紫色倒角光",
        ink=[("#3B34B8", 0), ("#241E7A", 40), ("#12103F", 100)],
        spec=(46, 0.30), shade=0.28, shadeColor="#0A0824",
        spot=None, bounce=0.06, edge=0.40, rimlight=0.55,
        core=CORE, arc="solid",
    ),
    dict(
        key="E · 银弧",
        note="B 的砖 + 金属笔弧",
        ink=[("#6E67FF", 0), ("#4A43E8", 38), ("#241E8C", 100)],
        spec=(60, 0.62), shade=0.24, shadeColor="#120C3A",
        spot=None, bounce=0.08, edge=0.34, rimlight=0.0,
        core=CORE, arc="metal",
    ),
]


def lum(hex_color):
    c = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast_white(hex_color):
    return 1.05 / (lum(hex_color) + 0.05)


def mid_stop(p):
    """取 40% 附近的那一档当代表色——笔弧主体落在这个亮度区间。"""
    for c, o in p["ink"]:
        if o >= 34:
            return c
    return p["ink"][0][0]


def defs(p):
    base = "".join(f'<stop offset="{o}%" stop-color="{c}"/>' for c, o in p["ink"])
    out = [
        f'<linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="42" y1="18" x2="214" y2="238">{base}</linearGradient>',
        # 背光面：右下压深，这是「体积」的来源
        f'<linearGradient id="shade" gradientUnits="userSpaceOnUse" x1="52" y1="48" x2="238" y2="240">'
        f'<stop offset="0%" stop-color="{p["shadeColor"]}" stop-opacity="0"/>'
        f'<stop offset="50%" stop-color="{p["shadeColor"]}" stop-opacity="0"/>'
        f'<stop offset="100%" stop-color="{p["shadeColor"]}" stop-opacity="{p["shade"]}"/></linearGradient>',
        # 镜面窄带：贴砖顶，衰减到 y=64 以前结束，不侵入笔弧
        f'<linearGradient id="spec" gradientUnits="userSpaceOnUse" x1="128" y1="16" x2="128" y2="{p["spec"][0]}">'
        f'<stop offset="0%" stop-color="#FFFFFF" stop-opacity="{p["spec"][1]}"/>'
        f'<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>',
        # 砖面左上柔光（只有柔光组用）
        '<radialGradient id="spot" gradientUnits="userSpaceOnUse" cx="82" cy="66" r="130">'
        f'<stop offset="0%" stop-color="#FFFFFF" stop-opacity="{(p["spot"][2] if p["spot"] else 0)}"/>'
        '<stop offset="55%" stop-color="#FFFFFF" stop-opacity="0.03"/>'
        '<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>',
        # 砖底冷反光
        '<linearGradient id="bounce" gradientUnits="userSpaceOnUse" x1="128" y1="180" x2="128" y2="240">'
        f'<stop offset="0%" stop-color="#C8DEFF" stop-opacity="0"/>'
        f'<stop offset="100%" stop-color="#C8DEFF" stop-opacity="{p["bounce"]}"/></linearGradient>',
        # 外缘暗线：顺时针压重，左上几乎无
        '<linearGradient id="edgeLine" gradientUnits="userSpaceOnUse" x1="40" y1="40" x2="232" y2="232">'
        f'<stop offset="0%" stop-color="{p["shadeColor"]}" stop-opacity="0.06"/>'
        f'<stop offset="55%" stop-color="{p["shadeColor"]}" stop-opacity="{p["edge"] * 0.7:.3f}"/>'
        f'<stop offset="100%" stop-color="{p["shadeColor"]}" stop-opacity="{p["edge"]}"/></linearGradient>',
        # 核心球面
        '<radialGradient id="core" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">'
        f'<stop offset="0%" stop-color="{p["core"][0]}"/><stop offset="44%" stop-color="{p["core"][1]}"/>'
        f'<stop offset="100%" stop-color="{p["core"][2]}"/></radialGradient>',
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
        # 深底透明版（本轮不动）
        f'<linearGradient id="inkDark" gradientUnits="userSpaceOnUse" x1="60" y1="52" x2="200" y2="210">'
        f'<stop offset="0%" stop-color="{DARK_INK[0]}"/><stop offset="46%" stop-color="{DARK_INK[1]}"/>'
        f'<stop offset="100%" stop-color="{DARK_INK[2]}"/></linearGradient>',
        f'<radialGradient id="coreDark" gradientUnits="userSpaceOnUse" cx="120" cy="117" r="30">'
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
    # 倒角亮线（D 组）：只亮左上，像机加工出来的倒角
    if p["rimlight"]:
        out.append(
            '<linearGradient id="chamfer" gradientUnits="userSpaceOnUse" x1="24" y1="20" x2="196" y2="196">'
            f'<stop offset="0%" stop-color="#A79FFF" stop-opacity="{p["rimlight"]}"/>'
            f'<stop offset="45%" stop-color="#8B83FF" stop-opacity="{p["rimlight"] * 0.35:.3f}"/>'
            '<stop offset="100%" stop-color="#8B83FF" stop-opacity="0"/></linearGradient>'
        )
    # 金属笔弧（E 组）
    if p["arc"] == "metal":
        out.append(
            '<linearGradient id="arcMetal" gradientUnits="userSpaceOnUse" x1="80" y1="60" x2="190" y2="200">'
            '<stop offset="0%" stop-color="#FFFFFF"/><stop offset="55%" stop-color="#F0EEFF"/>'
            '<stop offset="100%" stop-color="#CFC9FF"/></linearGradient>'
        )
    return "<defs>" + "".join(out) + "</defs>"


def core_top():
    return ('<circle cx="128" cy="128" r="21.3" fill="none" stroke="url(#rim)" stroke-width="1"/>'
            '<ellipse cx="119" cy="113" rx="7.5" ry="6" fill="url(#cspec)"/>'
            '<ellipse cx="128" cy="141" rx="12" ry="4" fill="url(#cbounce)"/>')


def svg_tile(p):
    band = "#FFFFFF" if p["arc"] == "solid" else "url(#arcMetal)"
    layers = [
        f'<path fill="url(#ink)" d="{geom.TILE}"/>',
        f'<path fill="url(#shade)" d="{geom.TILE}"/>',
        f'<path fill="url(#spec)" d="{geom.TILE}"/>',
    ]
    if p["spot"]:
        cy, r, op = p["spot"]
        layers.insert(2, f'<path fill="url(#spot)" d="{geom.TILE}"/>')
    layers.append(f'<path fill="url(#bounce)" d="{geom.TILE}"/>')
    layers.append(f'<path fill="none" stroke="url(#edgeLine)" stroke-width="1.4" d="{geom.TILE}"/>')
    if p["rimlight"]:
        layers.append(f'<path fill="none" stroke="url(#chamfer)" stroke-width="1.6" d="{geom.TILE}"/>')
    layers.append(f'<path fill="{band}" d="{geom.BAND}"/>')
    layers.append(f'<path fill="url(#core)" d="{geom.CORE_D}"/>')
    layers.append(core_top())
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">{defs(p)}'
            + "".join(layers) + "</svg>")


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
d.text((40, 22), "苹果式质感实验 · 明暗双向 / 窄镜面 / 利边",
       font=ImageFont.truetype(FONT, 21), fill=(30, 32, 48))
d.text((40, 54), "第一行浅底砖版 220px · 第二行小尺寸 48/32/16 + 平面 favicon · 第三行 2 倍细节 · 第四行深底透明版（本轮不动）",
       font=ImageFont.truetype(FONT, 12), fill=GREY)

for i, p in enumerate(SCHEMES):
    x0 = i * COL
    ratio = contrast_white(mid_stop(p))
    d.text((x0 + 22, 86), p["key"], font=ImageFont.truetype(FONT, 17), fill=CAPTION)
    d.text((x0 + 22, 108), f"{mid_stop(p)} · 白弧 {ratio:.1f}:1 · {p['note']}",
           font=ImageFont.truetype(FONT, 11), fill=GREY)

    d.rounded_rectangle((x0 + 22, 132, x0 + 398, 396), radius=14, fill=LIGHT_BG)
    canvas.alpha_composite(render(svg_tile(p), 220), (x0 + 100, 154))

    # 小尺寸
    base_y = 470
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
    crop = zoom.crop((86, 86, 358, 358))
    d.rounded_rectangle((x0 + 22, 512, x0 + 398, 788), radius=14, fill=LIGHT_BG)
    canvas.alpha_composite(crop, (x0 + 94, 522))

    # 深底透明版
    d.rounded_rectangle((x0 + 22, 808, x0 + 398, 1088), radius=14, fill=DARK_BG)
    canvas.alpha_composite(render(svg_dark(), 200), (x0 + 110, 848))

canvas.convert("RGB").save("renders/apple-lab.png")
print("wrote renders/apple-lab.png", canvas.size)
for p in SCHEMES:
    print(f"  {p['key']}: {mid_stop(p)} 白弧 {contrast_white(mid_stop(p)):.2f}:1")
