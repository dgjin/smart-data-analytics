#!/usr/bin/env python3
"""App icon / maskable：满版品牌色瓷面渐变底（含斜扫光）+ 白笔弧 + 球面高光核（内容放大到 ~70%）。

export_variants 的 app-icon 是「mark 叠在色块上」，对实心砖标记会套成两层；
这里直接按满版构图生成。favicon 保持平面色——16px 上看不出渐变，反而拖累清晰度。
"""
import io
import subprocess
import sys

import cairosvg
from PIL import Image

from geom import ACCENT, BAND, CORE_D, FAV_BAND, FAV_CORE, INK, TILE, defs

SCALE = 1.15

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="智能问数">
  <title>智能问数 — app icon</title>
  <!-- 满版构图：品牌色瓷面渐变底（{INK} 为中段，叠斜扫光 + 左上主光斑 + 底部反光）
       + 白笔弧 + 球面高光核，内容缩放 {SCALE}（占画布约 70%，满足 maskable 安全区）。
       iOS 的圆角由系统裁切，因此不做圆角；也不加砖顶内高光与外缘暗线（会被裁成亮边）。 -->
  {defs()}
  <rect width="256" height="256" fill="url(#ink)"/>
  <rect width="256" height="256" fill="url(#sweep)"/>
  <rect width="256" height="256" fill="url(#spot)"/>
  <rect width="256" height="256" fill="url(#bounce)"/>
  <g transform="translate(128 128) scale({SCALE}) translate(-128 -128)">
    <path fill="#FFFFFF" d="{BAND}"/>
    <path fill="url(#core)" d="{CORE_D}"/>
    <circle cx="128" cy="128" r="21.3" fill="none" stroke="url(#rim)" stroke-width="1"/>
    <ellipse cx="119" cy="113" rx="7.5" ry="6" fill="url(#spec)"/>
    <ellipse cx="128" cy="141" rx="12" ry="4" fill="url(#cbounce)"/>
  </g>
</svg>
'''
open("kit/app-icon.svg", "w", encoding="utf-8").write(svg)
print("wrote kit/app-icon.svg")

for size, out in [(1024, "kit/export/app-icon-1024.png"), (512, "kit/export/icon-512.png"),
                  (512, "kit/export/maskable-512.png"), (192, "kit/export/icon-192.png"),
                  (192, "kit/export/maskable-192.png"), (180, "kit/export/apple-touch-icon.png")]:
    r = subprocess.run([sys.executable, "/Users/dgjin/.agents/skills/logo-design/scripts/render_png.py",
                        "kit/app-icon.svg", "-o", out, "--width", str(size), "--height", str(size)],
                       capture_output=True, text=True)
    print(r.stdout.strip() or r.stderr.strip()[-200:])

# 浏览器标签用的彩色 favicon.svg：简化几何（核 24 / 间隙 16）+ 砖铺满画布（裁掉 16px 白边）。
# 16px 不铺渐变：平面靛蓝在像素网格上更规整，也避免缩图时出现色带。
fav = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="智能问数">
  <title>智能问数</title>
  <!-- 标签页图标：小尺寸几何（核 24、间隙 16），砖铺满画布。
       彩色版确保 16px 下也能认出品牌；单色场景用 favicon.svg 的 currentColor 版。 -->
  <g transform="translate(-12.42 -12.42) scale(1.097)">
    <path fill="{INK}" d="{TILE}"/>
    <path fill="#FFFFFF" d="{FAV_BAND}"/>
    <path fill="{ACCENT}" d="{FAV_CORE}"/>
  </g>
</svg>
'''
open("kit/export/favicon-color.svg", "w", encoding="utf-8").write(fav)
print("wrote kit/export/favicon-color.svg")

# 多尺寸 .ico（16/32/48）：从同一份 favicon-color.svg 渲出，保证与标签页图标同源。
png = cairosvg.svg2png(url="kit/export/favicon-color.svg", output_width=48)
ico = Image.open(io.BytesIO(png)).convert("RGBA")
ico.save("kit/export/favicon.ico", sizes=[(48, 48), (32, 32), (16, 16)])
print("wrote kit/export/favicon.ico")
