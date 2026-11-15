#!/usr/bin/env python3
"""生成三稿的锁合：符号（192）+ 中文名（84）+ 英文副行（24），模仿参考图的两行结构。"""
import subprocess

TEXT_CN = "智能问数"
TEXT_EN = "NL2SQL PRO"

def lockup(sym_paths, title, out):
    body = "\n".join(f"    {p}" for p in sym_paths)
    out.write(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 256" role="img" aria-label="{title} lockup">
  <title>{title} lockup</title>
  <!-- 概念阶段锁合：中文名用系统字（PingFang SC Semibold），英文副行加宽字距；定稿需转曲。 -->
  <svg x="32" y="32" width="192" height="192" viewBox="16 16 224 224">
{body}
  </svg>
  <text x="256" y="138" font-family="PingFang SC, Hiragino Sans GB, Heiti SC, sans-serif"
        font-size="84" font-weight="700" fill="#000" letter-spacing="2">{TEXT_CN}</text>
  <text x="260" y="184" font-family="Helvetica Neue, Arial, PingFang SC, sans-serif"
        font-size="24" font-weight="600" fill="#000" letter-spacing="6">{TEXT_EN}</text>
</svg>
''')

TILE = '<path fill="#000" fill-rule="evenodd" d="M56 16H200A40 40 0 0 1 240 56V200A40 40 0 0 1 200 240H56A40 40 0 0 1 16 200V56A40 40 0 0 1 56 16ZM'

def read_sym(path):
    """取符号文件里 path 的 d，拆成「砖 + 负形」两段。"""
    src = open(path, encoding="utf-8").read()
    d = src.split('d="', 1)[1].split('"', 1)[0]
    d = " ".join(d.split())
    return d

SET = [
    ("concept-q-right.svg", "Embrace Orbit", "concept-q-right-lockup.svg"),
    ("concept-t-brush.svg", "Embrace Brush", "concept-t-brush-lockup.svg"),
    ("concept-r-square.svg", "Embrace Square", "concept-r-square-lockup.svg"),
]

for sym, title, out in SET:
    d = read_sym(sym)
    lockup([f'<path fill="#000" fill-rule="evenodd" d="{d}"/>'], title, open(out, "w", encoding="utf-8"))
    print("wrote", out)

print(subprocess.run(["ls", "-1"], capture_output=True, text=True).stdout)
