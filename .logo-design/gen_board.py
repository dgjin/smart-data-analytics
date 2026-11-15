#!/usr/bin/env python3
"""交付总览图：符号三态 / 满版 app icon / 横竖锁合 / 尺寸阶梯。

所有素材来自 kit/ 与 public/favicon.svg（站点实际使用的彩色 favicon），
保证总览图与交付文件同源。
"""
import io

import cairosvg
from PIL import Image, ImageDraw, ImageFont

BG = (246, 247, 250)
DARK = (17, 20, 40)
GREY = (108, 116, 134)
INK = (79, 70, 229)

FONT = "/System/Library/Fonts/Helvetica.ttc"
W, H = 1600, 1010


def render(path, width, height=None):
    if path.lower().endswith(".png"):
        return Image.open(path).convert("RGBA").resize((width, height or width), Image.LANCZOS)
    if height:
        png = cairosvg.svg2png(url=path, output_width=width, output_height=height)
    else:
        png = cairosvg.svg2png(url=path, output_width=width)  # 保持原始宽高比
    return Image.open(io.BytesIO(png)).convert("RGBA")


def label(draw, x, y, text, color=GREY, size=15):
    draw.text((x, y), text, font=ImageFont.truetype(FONT, size), fill=color)


canvas = Image.new("RGBA", (W, H), BG + (255,))
d = ImageDraw.Draw(canvas)

# ---- 行 1：符号三态（彩色 / 单色黑 / 反白）----
y = 40
label(d, 80, y, "SYMBOL · colour / mono / reversed", INK, 16)
iy = y + 36

canvas.alpha_composite(render("kit/symbol-duo.svg", 200), (80, iy))
label(d, 80, iy + 206, "symbol-duo.svg")

canvas.alpha_composite(render("kit/symbol.svg", 200), (330, iy))
label(d, 330, iy + 206, "symbol.svg (currentColor)")

tile = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
ImageDraw.Draw(tile).rounded_rectangle((0, 0, 199, 199), radius=28, fill=DARK + (255,))
tile.alpha_composite(render("kit/symbol-reversed.svg", 176), (12, 12))
canvas.alpha_composite(tile, (580, iy))
label(d, 580, iy + 206, "symbol-reversed.svg")

# ---- 行 2：满版 icon / 横版锁合 / 竖版锁合 ----
y2 = 350
label(d, 80, y2, "APP ICON · LOCKUPS", INK, 16)
ROW2_BOTTOM = y2 + 36 + 224  # 三件底边对齐

app = render("kit/export/app-icon-1024.png", 170)
# 模拟 iOS 系统圆角裁切（满版图本身无圆角，圆角由系统施加）
mask = Image.new("L", app.size, 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, app.width - 1, app.height - 1), radius=int(app.width * 0.225), fill=255)
app.putalpha(mask)
canvas.alpha_composite(app, (80, ROW2_BOTTOM - app.height))
label(d, 80, ROW2_BOTTOM + 8, "app-icon (full bleed)")

lk = render("kit/lockup-horizontal-duo.svg", 560)
canvas.alpha_composite(lk, (320, ROW2_BOTTOM - lk.height))
label(d, 320, ROW2_BOTTOM + 8, "lockup-horizontal-duo.svg")

lv = render("kit/lockup-vertical-duo.svg", 180)
canvas.alpha_composite(lv, (940, ROW2_BOTTOM - lv.height))
label(d, 940, ROW2_BOTTOM + 8, "lockup-vertical-duo.svg")

# ---- 行 3：尺寸阶梯（站点实际使用的彩色 favicon，底边对齐）----
y3 = 700
label(d, 80, y3, "SCALE TEST · 16-256 PX", INK, 16)
base = y3 + 40
bottom = base + 200

x = 80
for size in (16, 24, 32, 48, 64, 96, 128, 192):
    canvas.alpha_composite(render("../public/favicon.svg", size), (x, bottom - size))
    d.text((x, bottom + 8), f"{size}", font=ImageFont.truetype(FONT, 14), fill=GREY)
    x += size + 40

canvas.convert("RGB").save("renders/final-board.png")
print("wrote renders/final-board.png", canvas.size)
