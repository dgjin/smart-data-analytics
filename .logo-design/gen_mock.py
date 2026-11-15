#!/usr/bin/env python3
"""UI 实景对照：顶栏（56px）/ 登录页（80px）/ 尺寸阶梯 / 浅底砖版资产。

顶栏与登录页直接用 kit/symbol-on-dark.svg（透明、无砖），验证徽章与背景同色域、
不再出现「贴了一层色块」的叠加感；浅底部分仍用砖版（app icon / favicon）。
"""
import io

import cairosvg
from PIL import Image, ImageDraw, ImageFont

FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
W, H = 1240, 780

HEADER_BG = (15, 23, 42)      # slate-900
PAGE_BG = (2, 6, 23)          # slate-950
LIGHT_BG = (246, 247, 250)
GREY = (108, 116, 134)
DIM = (148, 163, 184)


def render(path, width):
    if path.lower().endswith(".png"):
        return Image.open(path).convert("RGBA").resize((width, width), Image.LANCZOS)
    png = cairosvg.svg2png(url=path, output_width=width)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def text(draw, xy, s, size, fill=DIM, anchor=None):
    draw.text(xy, s, font=ImageFont.truetype(FONT, size), fill=fill, anchor=anchor)


canvas = Image.new("RGBA", (W, H), PAGE_BG + (255,))
d = ImageDraw.Draw(canvas)

# ---- 顶栏：h-16，徽章 56px（w-14），副标 leading-none + 文字块下移 6px ----
d.rectangle((0, 0, W, 64), fill=HEADER_BG + (255,))
d.line((0, 64, W, 64), fill=(30, 41, 59, 255))
canvas.alpha_composite(render("kit/symbol-on-dark.svg", 56), (16, 4))
title = "智能问数分析系统"
text(d, (84, 22), title, 18, (241, 245, 249))
text(d, (84, 44), "多源数据集成 • 自然语言交互 • 自动可视化与决策简报", 12, DIM)
# 版本胶囊与标题同行（真实布局：h1 与胶囊同一条 flex items-center）
bx = int(84 + d.textlength(title, font=ImageFont.truetype(FONT, 18)) + 8)
d.rounded_rectangle((bx, 22, bx + 116, 42), radius=11, outline=(129, 140, 248, 150))
text(d, (bx + 8, 26), "NL2SQL Pro v0.9.119", 11, (165, 180, 252))

# ---- 登录页：80px（w-20），slate-950 底 ----
canvas.alpha_composite(render("kit/symbol-on-dark.svg", 80), (W // 2 - 40, 104))
text(d, (W // 2, 208), "智能问数分析系统", 28, (241, 245, 249), "mt")
text(d, (W // 2, 258), "多源数据集成 • 自然语言交互 • 自动可视化", 13, DIM, "mt")

# ---- 尺寸阶梯：同一枚透明徽章，16→80px，底边对齐 ----
text(d, (120, 330), "SCALE · transparent on slate-950", 13, (129, 140, 248))
base = 470
x = 120
for size in (16, 24, 32, 48, 56, 80):
    canvas.alpha_composite(render("kit/symbol-on-dark.svg", size), (x, base - size))
    text(d, (x, base + 10), f"{size}px", 12)
    x += size + 64

# ---- 浅底资产：砖版 app icon / 双色符号 / 标签页 favicon ----
d.rectangle((0, 560, W, H), fill=LIGHT_BG + (255,))
text(d, (120, 578), "ON LIGHT · tiled versions (app icon / symbol / favicon)", 13, (79, 70, 229))
bottom = 752

app = render("kit/export/app-icon-1024.png", 150)
mask = Image.new("L", app.size, 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, app.width - 1, app.height - 1),
                                       radius=int(app.width * 0.225), fill=255)
app.putalpha(mask)
canvas.alpha_composite(app, (120, bottom - 150))
text(d, (120, bottom + 8), "app-icon 150px", 12, GREY)

canvas.alpha_composite(render("kit/symbol-duo.svg", 160), (330, bottom - 160))
text(d, (330, bottom + 8), "symbol-duo 160px", 12, GREY)

x = 560
for size in (16, 32, 48):
    canvas.alpha_composite(render("../public/favicon.svg", size), (x, bottom - size))
    text(d, (x, bottom + 8), f"favicon {size}", 12, GREY)
    x += size + 70

canvas.convert("RGB").save("renders/ui-mock.png")
print("wrote renders/ui-mock.png", canvas.size)
