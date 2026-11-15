#!/usr/bin/env python3
"""彩色锁合（横版 / 竖版）：符号三层上色 + 文字品牌深靛。

lockup-*.svg 用 currentColor，跟随上下文（单色印刷、深底反白）；
这两份是显式彩色的版本，用于网页、展示与需要固定品牌色的场景。
"""
from geom import ACCENT, BAND, CN, CN_FONT, CORE_D, EN, EN_FONT, INK, TILE


def symbol(x, y, size):
    return (f'<svg x="{x}" y="{y}" width="{size}" height="{size}" viewBox="0 0 256 256">\n'
            f'    <path fill="{INK}" d="{TILE}"/>\n'
            f'    <path fill="#FFFFFF" d="{BAND}"/>\n'
            f'    <path fill="{ACCENT}" d="{CORE_D}"/>\n'
            f'  </svg>')


def write(name, text):
    open(f"kit/{name}", "w", encoding="utf-8").write(text)
    print("wrote kit/" + name)


write("lockup-horizontal-duo.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 256" role="img" aria-label="{CN} {EN}">
  <title>{CN} — horizontal lockup (colour)</title>
  <!-- 彩色横版：符号 192 + 中文 78/700 + 英文副行 22/700（字距 5）。
       砖 {INK} / 笔弧 #FFFFFF / 核 {ACCENT}，文字与砖同色。
       单色与反白请用 lockup-horizontal.svg（currentColor）。 -->
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
  {symbol(88, 26, 224)}
  <text x="200" y="332" text-anchor="middle" font-family="{CN_FONT}" font-size="76"
        font-weight="700" fill="{INK}" letter-spacing="2">{CN}</text>
  <text x="200" y="376" text-anchor="middle" font-family="{EN_FONT}" font-size="22"
        font-weight="700" fill="{INK}" letter-spacing="5">{EN}</text>
</svg>
''')

write("lockup-horizontal-reversed.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 256" role="img" aria-label="{CN} {EN}">
  <title>{CN} — horizontal lockup (reversed)</title>
  <!-- 反白横版：白砖 + 品牌蓝笔弧 + 青核 + 白字，用于深色底/照片。
       与 lockup-horizontal-duo.svg 构成正/反白对。 -->
  <svg x="28" y="32" width="192" height="192" viewBox="0 0 256 256">
    <path fill="#FFFFFF" d="{TILE}"/>
    <path fill="{INK}" d="{BAND}"/>
    <path fill="{ACCENT}" d="{CORE_D}"/>
  </svg>
  <text x="252" y="138" font-family="{CN_FONT}" font-size="78" font-weight="700"
        fill="#FFFFFF" letter-spacing="2">{CN}</text>
  <text x="257" y="190" font-family="{EN_FONT}" font-size="22" font-weight="700"
        fill="#FFFFFF" letter-spacing="5">{EN}</text>
</svg>
''')
