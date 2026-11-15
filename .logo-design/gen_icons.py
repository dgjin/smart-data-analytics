#!/usr/bin/env python3
"""App icon / maskable：满版品牌底 + 白笔弧 + 青核（内容放大到 ~70%）。

export_variants 的 app-icon 是「mark 叠在色块上」，对实心砖标记会套成两层；
这里直接按满版构图生成。
"""
import subprocess
import sys

from geom import ACCENT, BAND, CORE_D, FAV_BAND, FAV_CORE, INK, TILE

SCALE = 1.15

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="智能问数">
  <title>智能问数 — app icon</title>
  <!-- 满版构图：{INK} 底 + 白笔弧 + {ACCENT} 核，内容缩放 {SCALE}（占画布约 70%，满足 maskable 安全区）。
       iOS 的圆角由系统裁切，因此不做圆角。 -->
  <rect width="256" height="256" fill="{INK}"/>
  <g transform="translate(128 128) scale({SCALE}) translate(-128 -128)">
    <path fill="#FFFFFF" d="{BAND}"/>
    <path fill="{ACCENT}" d="{CORE_D}"/>
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
fav = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="{'智能问数'}">
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
