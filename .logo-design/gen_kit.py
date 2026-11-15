#!/usr/bin/env python3
"""生成交付 kit：符号（单色 / 双色·光泽 / 反白·光泽）、favicon 简化版、横版与竖版锁合。

几何与配色全部来自 geom.py（单一真源）：
- 主标：R 78→38，尖端半径 32，核 22（核与笔弧间隙 10）
- favicon：R 80→40，尖端半径 40，核 24（间隙 16，小尺寸不糊）
"""
import os

from geom import (ACCENT, BAND, BARE_VIEWBOX, CN, CN_FONT, CORE_D, EN, EN_FONT, FAV_BAND,
                  FAV_CORE, INK, TILE, defs, defs_on_dark, symbol_body)

os.makedirs("kit", exist_ok=True)


def write(name, text):
    open(f"kit/{name}", "w", encoding="utf-8").write(text)
    print("wrote kit/" + name)


def mark(band, core, fill="currentColor"):
    return (f'<path fill="{fill}" fill-rule="evenodd"\n'
            f'          d="{TILE}\n           {band}\n           {core}"/>')


# 1) 纯符号（负形透明，浅底直接用；颜色随 currentColor）
write("symbol.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="{CN}">
  <title>{CN}</title>
  <!-- 一笔：粗端带宽 40 自右下起笔，逆时针盘绕 305° 收成尖，中心落一颗核（r22）。
       负形透明（evenodd），砖与笔弧同色；深底用 symbol-on-dark.svg（无砖透明版），
       照片/背景杂色用 symbol-reversed.svg（白砖）。 -->
  {mark(BAND, CORE_D)}
</svg>
''')

# 2) 双色·光泽（砖=斜向瓷面渐变 + 斜扫光 + 砖顶内高光，笔弧=白，核=球面高光 + 边缘光）
write("symbol-duo.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="{CN}">
  <title>{CN}</title>
  <!-- 双色·光泽（D 方案）：砖面斜向瓷面渐变（{INK} 为渐变中段）/ 白笔弧 / 核心球面高光。
       薄光材质：砖面斜扫光 + 砖顶 2px 内高光 + 核边缘光 + 镜面高光点——全用渐变，无 filter。
       核是全标唯一的彩色点——数据汇聚成判断，判断被点亮。
       单色场景退回 symbol.svg；16–32px 用 favicon-source.svg 的平面色。 -->
  {defs()}
  {symbol_body()}
</svg>
''')

# 3) 反白·光泽（白砖渐变 + 品牌主色笔弧渐变 + 青核，深底用）
write("symbol-reversed.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="{CN}">
  <title>{CN}</title>
  <!-- 反白·光泽：白砖瓷面渐变 + 品牌主色金属渐变笔弧 + 青核球面高光，用于深色底/照片。
       三层显式上色（不依赖背景透出），与 symbol-duo.svg 构成正/反白对。 -->
  {defs()}
  {symbol_body(invert=True)}
</svg>
''')

# 4) 透明版（无砖：笔弧提亮 + 更亮的核，直接落在深色背景上）
write("symbol-on-dark.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{BARE_VIEWBOX}" role="img" aria-label="{CN}">
  <title>{CN}</title>
  <!-- 透明版：不画砖，笔弧与核直接落在深色背景上（顶栏 / 登录页实际使用）。
       砖退场后靠提亮撑对比度：#C0BBFF→#6C63F0 在 slate-900 上 10.2:1→3.9:1。
       笔弧叠一层斜向受光 + 核边缘光 + 镜面高光点，保住质感又不压暗。
       viewBox 收到笔弧外接框（{BARE_VIEWBOX}），避免无砖后视觉尺寸缩水。 -->
  {defs_on_dark()}
  {symbol_body(on_dark=True)}
</svg>
''')

# 5) favicon 简化版（间隙 16、核 24，16px 不糊）
write("favicon-source.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="{CN}">
  <title>{CN} — small size</title>
  <!-- 小尺寸版本：核 24、核与笔弧间隙 16、笔弧略外扩（R80/40）。16–32px 使用。 -->
  <path fill="currentColor" fill-rule="evenodd"
        d="{TILE}
           {FAV_BAND}
           {FAV_CORE}"/>
</svg>
''')

# 6) 横版锁合
write("lockup-horizontal.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 256" role="img" aria-label="{CN} {EN}">
  <title>{CN} — horizontal lockup</title>
  <!-- 横版：符号 192 + 中文 78/700 + 英文副行 22/700（字距 5）。两行视觉中心对符号中线。
       字体：中文 PingFang SC / 思源黑体 Bold；英文 Helvetica Neue / Arial Bold。生产环境用 Logo.tsx 排字。 -->
  <svg x="28" y="32" width="192" height="192" viewBox="0 0 256 256">
    {mark(BAND, CORE_D)}
  </svg>
  <text x="252" y="138" font-family="{CN_FONT}" font-size="78" font-weight="700"
        fill="currentColor" letter-spacing="2">{CN}</text>
  <text x="257" y="190" font-family="{EN_FONT}" font-size="22" font-weight="700"
        fill="currentColor" letter-spacing="5">{EN}</text>
</svg>
''')

# 7) 竖版锁合
write("lockup-vertical.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 420" role="img" aria-label="{CN} {EN}">
  <title>{CN} — vertical lockup</title>
  <!-- 竖版：符号 224 居中，中文 76/700，英文副行 22/700。 -->
  <svg x="88" y="26" width="224" height="224" viewBox="0 0 256 256">
    {mark(BAND, CORE_D)}
  </svg>
  <text x="200" y="332" text-anchor="middle" font-family="{CN_FONT}" font-size="76"
        font-weight="700" fill="currentColor" letter-spacing="2">{CN}</text>
  <text x="200" y="376" text-anchor="middle" font-family="{EN_FONT}" font-size="22"
        font-weight="700" fill="currentColor" letter-spacing="5">{EN}</text>
</svg>
''')

print("kit written")
