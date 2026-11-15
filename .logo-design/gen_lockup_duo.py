#!/usr/bin/env python3
"""彩色锁合（横版 / 竖版 / 反白）：符号三层光泽上色 + 文字品牌靛蓝。

lockup-*.svg 用 currentColor，跟随上下文（单色印刷、深底反白）；
这三份是显式彩色的版本，用于网页、展示与需要固定品牌色的场景。
渐变 id（ink / tile / core）在每个文件内定义一次，嵌套 <svg> 按自身
256 用户坐标系解析，因此符号缩放后无需改坐标。
"""
from geom import (BARE_VIEWBOX, CN, CN_FONT, EN, EN_FONT, INK, defs, defs_on_dark,
                  symbol_body)


def symbol(x, y, size, flip=False):
    """flip=True：无砖透明版（笔弧提亮 + 青核），直接落在深色底上。

    图层（含薄光材质）来自 geom.symbol_body，与单枚符号、Logo.tsx 同源。
    """
    if flip:
        return (f'<svg x="{x}" y="{y}" width="{size}" height="{size}" viewBox="{BARE_VIEWBOX}">\n'
                f'    {symbol_body(on_dark=True)}\n'
                f'  </svg>')
    return (f'<svg x="{x}" y="{y}" width="{size}" height="{size}" viewBox="0 0 256 256">\n'
            f'    {symbol_body()}\n'
            f'  </svg>')


def write(name, text):
    open(f"kit/{name}", "w", encoding="utf-8").write(text)
    print("wrote kit/" + name)


write("lockup-horizontal-duo.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 256" role="img" aria-label="{CN} {EN}">
  <title>{CN} — horizontal lockup (colour)</title>
  <!-- 彩色横版：符号 192 + 中文 78/700 + 英文副行 22/700（字距 5）。
       砖面瓷面渐变（含斜扫光与砖顶内高光）/ 白笔弧 / 青核（含边缘光与镜面点），文字用品牌主色 {INK}。
       单色与反白请用 lockup-horizontal.svg（currentColor）。 -->
  {defs()}
  {symbol(28, 32, 192)}
  <text x="252" y="138" font-family="{CN_FONT}" font-size="78" font-weight="700"
        fill="{INK}" letter-spacing="2">{CN}</text>
  <text x="257" y="190" font-family="{EN_FONT}" font-size="22" font-weight="700"
        fill="{INK}" letter-spacing="5">{EN}</text>
</svg>
''')

write("lockup-vertical-duo.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 420" role="img" aria-label="{CN} {EN}">
  <title>{CN} — vertical lockup (colour)</title>
  <!-- 彩色竖版：符号 224 居中，中文 76/700，英文副行 22/700。 -->
  {defs()}
  {symbol(88, 26, 224)}
  <text x="200" y="332" text-anchor="middle" font-family="{CN_FONT}" font-size="76"
        font-weight="700" fill="{INK}" letter-spacing="2">{CN}</text>
  <text x="200" y="376" text-anchor="middle" font-family="{EN_FONT}" font-size="22"
        font-weight="700" fill="{INK}" letter-spacing="5">{EN}</text>
</svg>
''')

write("lockup-horizontal-reversed.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 256" role="img" aria-label="{CN} {EN}">
  <title>{CN} — horizontal lockup (on dark)</title>
  <!-- 深底透明横版：无砖，笔弧提亮 + 青核 + 白字，与顶栏徽章同一形态。
       符号 180×180 居中于 y=128；文字 x 与 duo 版对齐。 -->
  {defs_on_dark()}
  {symbol(34, 38, 180, flip=True)}
  <text x="252" y="138" font-family="{CN_FONT}" font-size="78" font-weight="700"
        fill="#FFFFFF" letter-spacing="2">{CN}</text>
  <text x="257" y="190" font-family="{EN_FONT}" font-size="22" font-weight="700"
        fill="#FFFFFF" letter-spacing="5">{EN}</text>
</svg>
''')
