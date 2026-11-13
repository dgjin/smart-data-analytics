#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""由《系统功能说明书》Markdown 单一事实源生成正式版 Word 交付件。

用法：
    python3 scripts/generate-spec-docx.py [--md docs/核心文档/系统功能说明书.md] [--out 输出.docx]

产物结构：封面 → 文档信息 / 修订记录 → 目录（TOC 域，打开时自动更新）
        → 正文第 1~8 章 → 附录 A 版本变更记录（本次更新 / 近期摘要 / 全量索引）。
"""

import argparse
import re
import sys
from datetime import date
from pathlib import Path

from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

# ---------------------------------------------------------------- 版式常量
BODY_EA = "宋体"
BODY_ASCII = "Times New Roman"
HEAD_EA = "微软雅黑"
MONO = "Consolas"
NAVY = RGBColor(0x1F, 0x38, 0x64)
INK = RGBColor(0x22, 0x26, 0x2E)
GRAY = RGBColor(0x6B, 0x72, 0x80)
ACCENT = RGBColor(0x1F, 0x4E, 0x79)
CONTENT_W = Cm(16.0)

INLINE = re.compile(r"(`[^`]+`|\*\*.+?\*\*|\[[^\]]+\]\([^)]+\))")
BULLET_MARKS = ["\u2022", "\u25e6", "\u25aa"]


# ---------------------------------------------------------------- 底层工具
def set_run_font(run, ea=BODY_EA, ascii_font=BODY_ASCII, size=None, bold=None,
                 color=None, italic=None):
    run.font.name = ascii_font
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), ascii_font)
    rfonts.set(qn("w:hAnsi"), ascii_font)
    rfonts.set(qn("w:eastAsia"), ea)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if italic is not None:
        run.font.italic = italic
    if color is not None:
        run.font.color.rgb = color


def shade_run(run, fill="F1F3F7"):
    rpr = run._element.get_or_add_rPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    rpr.append(shd)


def shade_cell(cell, fill):
    tcpr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tcpr.append(shd)


def shade_paragraph(paragraph, fill):
    ppr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    ppr.append(shd)


def border_paragraph(paragraph, edge="bottom", color="1F3864", size=8, space=2):
    ppr = paragraph._p.get_or_add_pPr()
    pbdr = ppr.find(qn("w:pBdr"))
    if pbdr is None:
        pbdr = OxmlElement("w:pBdr")
        ppr.append(pbdr)
    el = OxmlElement("w:" + edge)
    el.set(qn("w:val"), "single")
    el.set(qn("w:sz"), str(size))
    el.set(qn("w:space"), str(space))
    el.set(qn("w:color"), color)
    pbdr.append(el)


def add_field(paragraph, instr, placeholder="", size=8.5, color=GRAY):
    run = paragraph.add_run()
    set_run_font(run, size=size, color=color)
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr_el = OxmlElement("w:instrText")
    instr_el.set(qn("xml:space"), "preserve")
    instr_el.text = instr
    sep = OxmlElement("w:fldChar")
    sep.set(qn("w:fldCharType"), "separate")
    text_el = OxmlElement("w:t")
    text_el.text = placeholder
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for node in (begin, instr_el, sep, text_el, end):
        run._r.append(node)


def set_update_fields(document):
    settings = document.settings.element
    upd = OxmlElement("w:updateFields")
    upd.set(qn("w:val"), "true")
    anchor = None
    for tag in ("w:compat", "w:rsids", "w:mathPr", "w:themeFontLang"):
        anchor = settings.find(qn(tag))
        if anchor is not None:
            break
    if anchor is not None:
        anchor.addprevious(upd)
    else:
        settings.append(upd)


def table_borders(table, color="C9D2E0", size=4):
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement("w:" + edge)
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), str(size))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), color)
        borders.append(el)
    return borders


def format_table(table, widths_cm):
    """按 OOXML 架构顺序写入 tblW / tblBorders / tblLayout / tblCellMar，并重建 tblGrid。"""
    tbl = table._tbl
    tblpr = tbl.tblPr
    for tag in ("tblW", "tblBorders", "tblLayout", "tblCellMar", "jc"):
        for el in tblpr.findall(qn("w:" + tag)):
            tblpr.remove(el)

    total_tw = int(sum(widths_cm) * 567)
    width = OxmlElement("w:tblW")
    width.set(qn("w:type"), "dxa")
    width.set(qn("w:w"), str(total_tw))
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    mar = OxmlElement("w:tblCellMar")
    for edge, val in (("top", 40), ("left", 90), ("bottom", 40), ("right", 90)):
        el = OxmlElement("w:" + edge)
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")
        mar.append(el)

    anchor = tblpr.find(qn("w:tblLook"))
    for el in (width, table_borders(table), layout, mar):
        if anchor is not None:
            anchor.addprevious(el)
        else:
            tblpr.append(el)

    grid = tbl.find(qn("w:tblGrid"))
    if grid is not None:
        tbl.remove(grid)
    grid = OxmlElement("w:tblGrid")
    for value in widths_cm:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(int(value * 567)))
        grid.append(col)
    tblpr.addnext(grid)

    for row in table.rows:
        for idx, cell in enumerate(row.cells):
            cell.width = Cm(widths_cm[idx])


def repeat_header(row):
    trpr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:tblHeader")
    el.set(qn("w:val"), "true")
    trpr.append(el)


# ---------------------------------------------------------------- 行内排版
def add_inline(paragraph, text, size=10.5, color=INK, bold=False, ea=BODY_EA):
    """解析 **粗体** / `代码` / [链接](地址)；粗体内嵌代码递归处理。"""
    for token in INLINE.split(text):
        if not token:
            continue
        if token.startswith("`") and token.endswith("`") and len(token) > 2:
            run = paragraph.add_run(token[1:-1])
            set_run_font(run, ea=MONO, ascii_font=MONO, size=size - 1.0,
                         bold=bold, color=RGBColor(0x1A, 0x3A, 0x5E))
            shade_run(run)
        elif token.startswith("**") and token.endswith("**") and len(token) > 4:
            add_inline(paragraph, token[2:-2], size=size, color=color, bold=True, ea=ea)
        elif token.startswith("[") and "](" in token:
            label = token[1:token.index("](")]
            url = token[token.index("](") + 2:-1]
            run = paragraph.add_run(label)
            set_run_font(run, ea=ea, size=size, bold=bold, color=ACCENT)
            run.font.underline = True
            hint = paragraph.add_run("（%s）" % url)
            set_run_font(hint, ea=ea, size=size - 2.0, color=GRAY)
        else:
            run = paragraph.add_run(token)
            set_run_font(run, ea=ea, size=size, bold=bold, color=color)


# ---------------------------------------------------------------- 文档骨架
def build_styles(document):
    normal = document.styles["Normal"]
    normal.font.name = BODY_ASCII
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = INK
    rpr = normal.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), BODY_ASCII)
    rfonts.set(qn("w:hAnsi"), BODY_ASCII)
    rfonts.set(qn("w:eastAsia"), BODY_EA)
    pf = normal.paragraph_format
    pf.line_spacing = 1.45
    pf.space_before = Pt(0)
    pf.space_after = Pt(5)

    specs = {
        "Heading 1": (18, True, NAVY, 16, 8),
        "Heading 2": (14.5, True, NAVY, 12, 5),
        "Heading 3": (12, True, ACCENT, 9, 4),
    }
    for name, (size, bold, color, before, after) in specs.items():
        style = document.styles[name]
        style.font.name = HEAD_EA
        style.font.size = Pt(size)
        style.font.bold = bold
        style.font.color.rgb = color
        style.font.italic = False
        rpr = style.element.get_or_add_rPr()
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is None:
            rfonts = OxmlElement("w:rFonts")
            rpr.append(rfonts)
        rfonts.set(qn("w:ascii"), HEAD_EA)
        rfonts.set(qn("w:hAnsi"), HEAD_EA)
        rfonts.set(qn("w:eastAsia"), HEAD_EA)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.line_spacing = 1.25
        style.paragraph_format.keep_with_next = True


def build_section(document):
    section = document.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.5)
    section.bottom_margin = Cm(2.2)
    section.left_margin = Cm(2.6)
    section.right_margin = Cm(2.4)
    section.header_distance = Cm(1.4)
    section.footer_distance = Cm(1.2)
    section.different_first_page_header_footer = True

    header = section.header.paragraphs[0]
    header.paragraph_format.tab_stops.add_tab_stop(Cm(16.0), WD_TAB_ALIGNMENT.RIGHT)
    head_left = header.add_run("智能问数分析系统 · 功能说明书")
    set_run_font(head_left, ea=HEAD_EA, ascii_font=HEAD_EA, size=8.5, color=GRAY)
    header.add_run("\t")
    head_right = header.add_run("NL2SQL Pro v0.9.119")
    set_run_font(head_right, ea=HEAD_EA, ascii_font=HEAD_EA, size=8.5, color=GRAY)
    border_paragraph(header, "bottom", "C9D2E0", 4, 4)

    footer = section.footer.paragraphs[0]
    footer.paragraph_format.tab_stops.add_tab_stop(Cm(16.0), WD_TAB_ALIGNMENT.RIGHT)
    left = footer.add_run("内部资料 · 请勿外传")
    set_run_font(left, size=8.5, color=GRAY)
    footer.add_run("\t")
    pre = footer.add_run("第 ")
    set_run_font(pre, size=8.5, color=GRAY)
    add_field(footer, " PAGE ", "1")
    mid = footer.add_run(" 页 / 共 ")
    set_run_font(mid, size=8.5, color=GRAY)
    add_field(footer, " NUMPAGES ", "1")
    post = footer.add_run(" 页")
    set_run_font(post, size=8.5, color=GRAY)


def add_cover(document):
    for _ in range(3):
        document.add_paragraph()

    org = document.add_paragraph()
    org.alignment = WD_ALIGN_PARAGRAPH.LEFT
    run = org.add_run("智能问数分析系统")
    set_run_font(run, ea=HEAD_EA, ascii_font=HEAD_EA, size=20, bold=True, color=ACCENT)
    org.paragraph_format.space_after = Pt(6)

    title = document.add_paragraph()
    run = title.add_run("功能说明书")
    set_run_font(run, ea=HEAD_EA, ascii_font=HEAD_EA, size=40, bold=True, color=NAVY)
    title.paragraph_format.space_after = Pt(2)

    sub = document.add_paragraph()
    run = sub.add_run("Functional Specification")
    set_run_font(run, ea=HEAD_EA, ascii_font=HEAD_EA, size=13, color=GRAY)
    sub.paragraph_format.space_after = Pt(10)

    line = document.add_paragraph()
    border_paragraph(line, "bottom", "1F3864", 12, 6)
    line.paragraph_format.space_after = Pt(18)

    tag = document.add_paragraph()
    run = tag.add_run("NL2SQL Pro v0.9.119")
    set_run_font(run, ea=HEAD_EA, ascii_font=HEAD_EA, size=14, bold=True, color=ACCENT)
    tag.paragraph_format.space_after = Pt(4)

    desc = document.add_paragraph()
    run = desc.add_run("本文档是系统的单一事实源功能说明书（面向开发与评审）")
    set_run_font(run, size=10.5, color=GRAY)

    for _ in range(6):
        document.add_paragraph()

    meta = [
        ("文档版本", "2026.11"),
        ("适用系统版本", "NL2SQL Pro v0.9.119"),
        ("文档状态", "正式发布"),
        ("密级", "内部"),
        ("编制", "产品与研发中心"),
        ("发布日期", date.today().strftime("%Y 年 %m 月 %d 日")),
    ]
    table = document.add_table(rows=0, cols=2)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    table.autofit = False
    for key, value in meta:
        row = table.add_row()
        c0, c1 = row.cells
        p0 = c0.paragraphs[0]
        r0 = p0.add_run(key)
        set_run_font(r0, ea=HEAD_EA, ascii_font=HEAD_EA, size=9.5, color=GRAY)
        p1 = c1.paragraphs[0]
        r1 = p1.add_run(value)
        set_run_font(r1, ea=HEAD_EA, ascii_font=HEAD_EA, size=9.5, bold=True, color=INK)
        for cell in (c0, c1):
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            cell.paragraphs[0].paragraph_format.space_after = Pt(3)
    format_table(table, [3.4, 8.0])


def add_info_pages(document, today):
    def pseudo_heading(text, new_page=False):
        p = document.add_paragraph()
        run = p.add_run(text)
        set_run_font(run, ea=HEAD_EA, ascii_font=HEAD_EA, size=15, bold=True, color=NAVY)
        p.paragraph_format.space_before = Pt(4)
        p.paragraph_format.space_after = Pt(8)
        p.paragraph_format.keep_with_next = True
        p.paragraph_format.page_break_before = new_page
        border_paragraph(p, "bottom", "1F3864", 6, 4)
        return p

    pseudo_heading("文档信息", new_page=True)

    info = [
        ("文档名称", "智能问数分析系统 · 功能说明书"),
        ("文档编号", "NL2SQL-SPEC-2026-11"),
        ("文档版本", "2026.11（首个 Word 交付版）"),
        ("适用系统版本", "NL2SQL Pro v0.9.119"),
        ("文档状态", "正式发布"),
        ("密级", "内部"),
        ("编制", "产品与研发中心"),
        ("发布日期", today),
        ("适用范围", "系统功能评审、开发实现、测试设计与运维交付"),
        ("目标读者", "产品、研发、测试、运维与评审人员；终端用户请参阅《用户使用指南》"),
        ("事实源", "docs/核心文档/系统功能说明书.md（Markdown）"),
        ("相关文档", "《用户使用指南》《更新日志》《业务本体功能与操作手册》《混沌工程演练手册》"),
    ]
    table = document.add_table(rows=0, cols=2)
    table.autofit = False
    for key, value in info:
        row = table.add_row()
        c0, c1 = row.cells
        shade_cell(c0, "EDF1F8")
        r0 = c0.paragraphs[0].add_run(key)
        set_run_font(r0, ea=HEAD_EA, ascii_font=HEAD_EA, size=9, bold=True, color=NAVY)
        r1 = c1.paragraphs[0].add_run(value)
        set_run_font(r1, size=9, color=INK)
        for cell in (c0, c1):
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            cell.paragraphs[0].paragraph_format.line_spacing = 1.25
            cell.paragraphs[0].paragraph_format.space_after = Pt(1)
    table_borders(table)
    format_table(table, [3.6, 12.4])

    document.add_paragraph()
    pseudo_heading("修订记录")
    rows = [
        ("版本", "日期", "修订说明", "修订人"),
        ("2026.11", today, "首个 Word 交付版：对齐 NL2SQL Pro v0.9.119，补充双核浏览器兼容与金额单位服务端确定性换算；"
                      "按正式交付件重构封面、文档信息、目录、页眉页脚与表格样式；正文第 9 章变更记录改以附录 A 呈现"
                      "（本次更新 / 近期摘要 / 全量版本索引）。", "系统"),
        ("—", "—", "此前各版本以 Markdown 单一事实源维护，逐版本明细见附录 A.3 与《更新日志》。", "系统"),
    ]
    table = document.add_table(rows=0, cols=4)
    table.autofit = False
    for idx, row_data in enumerate(rows):
        row = table.add_row()
        for j, text in enumerate(row_data):
            cell = row.cells[j]
            p = cell.paragraphs[0]
            run = p.add_run(text)
            set_run_font(run, ea=HEAD_EA if idx == 0 else BODY_EA,
                         ascii_font=HEAD_EA if idx == 0 else BODY_ASCII,
                         size=8.5, bold=(idx == 0), color=NAVY if idx == 0 else INK)
            p.paragraph_format.line_spacing = 1.2
            p.paragraph_format.space_after = Pt(1)
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            if idx == 0:
                shade_cell(cell, "DCE4F2")
    table_borders(table)
    repeat_header(table.rows[0])
    format_table(table, [1.7, 2.1, 10.4, 1.8])

    document.add_paragraph()
    note = document.add_paragraph()
    note.paragraph_format.left_indent = Cm(0.3)
    note.paragraph_format.space_before = Pt(4)
    run = note.add_run("说明：")
    set_run_font(run, ea=HEAD_EA, ascii_font=HEAD_EA, size=9, bold=True, color=ACCENT)
    run = note.add_run("本文件由仓库中的 Markdown 单一事实源自动排版生成，正文功能描述与源文件逐节对应；"
                       "第 9 章「变更记录」在交付版中收敛为附录 A，完整逐版本明细请以源文件为准。"
                       "目录为 Word 域，打开文档时自动更新（如未更新，可全选后按 F9）。")
    set_run_font(run, size=9, color=GRAY)
    shade_paragraph(note, "F5F7FA")
    border_paragraph(note, "left", "1F3864", 12, 6)


def add_toc(document):
    p = document.add_paragraph()
    run = p.add_run("目　录")
    set_run_font(run, ea=HEAD_EA, ascii_font=HEAD_EA, size=18, bold=True, color=NAVY)
    p.paragraph_format.space_after = Pt(10)
    p.paragraph_format.page_break_before = True
    border_paragraph(p, "bottom", "1F3864", 6, 4)

    toc_para = document.add_paragraph()
    add_field(toc_para, ' TOC \\o "1-2" \\h \\z \\u ',
              "目录将在打开文档时自动生成（亦可全选后按 F9 更新域）", size=9.5)


# ---------------------------------------------------------------- 正文渲染
def add_heading(document, text, level):
    p = document.add_paragraph(style="Heading %d" % level)
    add_inline(p, text, size=18 if level == 1 else 14.5,
               color=NAVY, bold=True, ea=HEAD_EA)
    return p


def add_body(document, text):
    p = document.add_paragraph()
    p.paragraph_format.space_after = Pt(5)
    add_inline(p, text)
    return p


def add_bullet(document, text, level):
    p = document.add_paragraph()
    pf = p.paragraph_format
    pf.left_indent = Cm(0.72 + 0.62 * level)
    pf.first_line_indent = Cm(-0.45)
    pf.space_before = Pt(1)
    pf.space_after = Pt(3)
    mark = p.add_run(BULLET_MARKS[min(level, len(BULLET_MARKS) - 1)] + " ")
    set_run_font(mark, ea=BODY_EA, size=10.5, bold=True, color=ACCENT)
    add_inline(p, text, size=10.5)
    return p


def add_ordered(document, number, text):
    p = document.add_paragraph()
    pf = p.paragraph_format
    pf.left_indent = Cm(0.86)
    pf.first_line_indent = Cm(-0.6)
    pf.space_before = Pt(1)
    pf.space_after = Pt(3)
    mark = p.add_run("%s. " % number)
    set_run_font(mark, ea=HEAD_EA, ascii_font=HEAD_EA, size=10, bold=True, color=ACCENT)
    add_inline(p, text, size=10.5)
    return p


def add_quote(document, text):
    p = document.add_paragraph()
    pf = p.paragraph_format
    pf.left_indent = Cm(0.35)
    pf.space_before = Pt(4)
    pf.space_after = Pt(6)
    add_inline(p, text, size=9.5, color=RGBColor(0x3D, 0x44, 0x50))
    shade_paragraph(p, "F5F7FA")
    border_paragraph(p, "left", "8FA8C8", 12, 6)
    return p


def add_code(document, lines):
    p = document.add_paragraph()
    pf = p.paragraph_format
    pf.left_indent = Cm(0.35)
    pf.space_before = Pt(4)
    pf.space_after = Pt(8)
    pf.line_spacing = 1.15
    for idx, code_line in enumerate(lines):
        run = p.add_run(code_line)
        set_run_font(run, ea=MONO, ascii_font=MONO, size=8.5, color=RGBColor(0x1A, 0x2B, 0x3C))
        if idx != len(lines) - 1:
            run.add_break()
    shade_paragraph(p, "F2F4F7")
    border_paragraph(p, "left", "8FA8C8", 12, 6)
    return p


def add_table(document, header, rows, widths=None, font_size=9.0):
    table = document.add_table(rows=0, cols=len(header))
    table.autofit = False
    head_row = table.add_row()
    for idx, text in enumerate(header):
        cell = head_row.cells[idx]
        shade_cell(cell, "DCE4F2")
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(1)
        p.paragraph_format.line_spacing = 1.2
        run = p.add_run(text)
        set_run_font(run, ea=HEAD_EA, ascii_font=HEAD_EA, size=font_size,
                     bold=True, color=NAVY)
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
    for values in rows:
        row = table.add_row()
        for idx, text in enumerate(values):
            cell = row.cells[idx]
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(1)
            p.paragraph_format.line_spacing = 1.25
            add_inline(p, text, size=font_size)
            if idx == 0 and len(header) == 2:
                for run in p.runs:
                    run.font.bold = True
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
    table_borders(table)
    repeat_header(table.rows[0])
    if widths is None:
        widths = [3.2, 12.8] if len(header) == 2 else [16.0 / len(header)] * len(header)
    format_table(table, widths)
    spacer = document.add_paragraph()
    spacer.paragraph_format.space_after = Pt(2)
    return table


def parse_table(lines, start):
    rows = []
    idx = start
    while idx < len(lines) and lines[idx].lstrip().startswith("|"):
        raw = lines[idx].strip()
        cells = [c.strip() for c in raw.strip("|").split("|")]
        if not all(re.fullmatch(r":?-{3,}:?", c) for c in cells if c):
            rows.append(cells)
        idx += 1
    return rows, idx


def render_body(document, md_lines):
    idx = 0
    while idx < len(md_lines):
        line = md_lines[idx].rstrip()

        if line.startswith("## 9. 变更记录"):
            break
        if line.startswith("# "):
            idx += 1
            continue
        if not line.strip():
            idx += 1
            continue
        if line.strip() == "---":
            idx += 1
            continue

        if line.startswith("## ") or line.startswith("### "):
            level = 1 if line.startswith("## ") else 2
            text = line[level + 2:].strip()
            heading = add_heading(document, text, level)
            if level == 1:
                heading.paragraph_format.page_break_before = True
            idx += 1
            continue

        if line.startswith(">"):
            add_quote(document, line.lstrip("> ").strip())
            idx += 1
            continue

        if line.startswith("```"):
            fence = []
            idx += 1
            while idx < len(md_lines) and not md_lines[idx].strip().startswith("```"):
                fence.append(md_lines[idx].rstrip())
                idx += 1
            idx += 1
            add_code(document, fence or [""])
            continue

        if line.lstrip().startswith("|"):
            rows, idx = parse_table(md_lines, idx)
            if rows:
                header = rows[0]
                body = rows[1:]
                widths = None
                if header[0] == "角色" and len(header) == 7:
                    widths = [2.4, 2.0, 1.8, 1.9, 2.9, 1.9, 3.1]
                add_table(document, header, body, widths)
            continue

        bullet = re.match(r"^(\s*)-\s+(.*)$", line)
        if bullet:
            level = len(bullet.group(1)) // 2
            add_bullet(document, bullet.group(2), level)
            idx += 1
            continue

        ordered = re.match(r"^(\d+)\.\s+(.*)$", line)
        if ordered:
            add_ordered(document, ordered.group(1), ordered.group(2))
            idx += 1
            continue

        add_body(document, line.strip())
        idx += 1


# ---------------------------------------------------------------- 附录
RECENT = [
    ("v0.9.119（维护）", "2026-11-02", "双核浏览器兼容（360 极速版白屏）；金额单位由提示词约定升级为服务端确定性换算"),
    ("v0.9.119", "2026-10-23", "帮助中心「业务本体」页签与检索语料扩展；累计式幂等数据库升级脚本"),
    ("v0.9.118", "2026-10-22", "Redis 访问认证与连接串修复（requirepass、连接串校验）"),
    ("v0.9.117", "2026-10-22", "Redis AOF 兜底与巡检告警覆盖"),
    ("v0.9.116", "2026-10-22", "Redis 落盘陈旧巡检端点 /api/health/persistence"),
    ("v0.9.115", "2026-10-22", "混沌工程演练脚本与手册（依赖断连 8 项断言）"),
    ("v0.9.114", "2026-10-22", "轻量链路追踪与单请求耗时瀑布查询 API"),
    ("v0.9.113", "2026-10-21", "业务本体注入全局开关（热更、无需重启）"),
    ("v0.9.112", "2026-10-21", "业务本体智能预填 auto-build 规则引擎与管理端弹窗"),
    ("v0.9.111", "2026-10-21", "业务本体维护易用性（批量值域、层级编辑器、版本摘要）"),
    ("v0.9.110", "2026-10-21", "业务本体 M1/M2 落地（实体、绑定、值域、关系、层级、版本与回滚）"),
]

UPDATE_ITEMS = [
    ("双核浏览器兼容", "缺陷修复", "全站用户（360 极速版等双核浏览器）",
     "index.html 增加 renderer=webkit 与 X-UA-Compatible 强制 Chromium 内核；构建目标降至 chrome95；"
     "Tailwind v4 oklch 色板经 @supports 回退 sRGB（94 个变量）"),
    ("金额单位确定性换算", "口径修复", "问数、报表、报告模式",
     "新增 applyAmountUnitToRows / detectSqlDivisor 服务端兜底；阶段一 amountKeys 声明金额列；"
     "档位不一致按比例纠正、比率列不换算；结果徽标按实际换算状态表述"),
    ("依赖与服务治理（近 10 版）", "能力增强", "运维与评审",
     "链路追踪（v0.9.114）、混沌演练（v0.9.115）、Redis 落盘巡检 / AOF / 认证（v0.9.116~118）、"
     "业务本体（v0.9.110~113）、帮助中心本体页签与升级脚本（v0.9.119）"),
]


def theme_of(content):
    text = re.sub(r"（[^（）]*）", "", content)
    text = re.sub(r"\([^()]*\)", "", text)
    for sep in ("：", ":", "；", ";"):
        if sep in text:
            text = text.split(sep, 1)[0]
    text = text.replace("**", "").replace("`", "").strip(" ·-—")
    return text[:46] + ("…" if len(text) > 46 else "")


def parse_changelog(md_text):
    rows = []
    in_changelog = False
    for line in md_text.split("\n"):
        if line.startswith("## 9. 变更记录"):
            in_changelog = True
            continue
        if in_changelog and line.startswith("| 20"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) >= 3:
                rows.append((cells[0], cells[1], cells[2]))
    return rows


def add_appendix(document, md_text):
    heading = add_heading(document, "附录 A　版本变更记录", 1)
    heading.paragraph_format.page_break_before = True

    intro = add_body(document, "本附录收录本次交付的变更要点、近期版本摘要与全量版本索引。"
                             "系统自 v0.1 起累计发布 150 余个版本，逐版本完整变更明细见单一事实源"
                             "《系统功能说明书》第 9 章与《更新日志》。")

    add_heading(document, "A.1 本次交付更新要点", 2)
    add_table(
        document,
        ["变更项", "类型", "影响面", "说明"],
        [list(item) for item in UPDATE_ITEMS],
        [2.4, 1.6, 3.2, 8.8],
        font_size=8.5,
    )

    add_heading(document, "A.2 近期版本摘要（v0.9.110 ~ v0.9.119）", 2)
    add_table(
        document,
        ["版本", "日期", "摘要"],
        [list(item) for item in RECENT],
        [2.6, 2.4, 11.0],
        font_size=8.5,
    )

    add_heading(document, "A.3 全量版本索引", 2)
    rows = parse_changelog(md_text)
    if rows:
        add_table(
            document,
            ["日期", "版本", "主题"],
            [[d, v, theme_of(c)] for d, v, c in rows],
            [2.4, 2.6, 11.0],
            font_size=8.0,
        )
    tail = document.add_paragraph()
    run = tail.add_run("注：主题由各版本变更内容首句提炼，仅供检索定位；完整描述以源文件为准。")
    set_run_font(run, size=8.5, color=GRAY)


# ---------------------------------------------------------------- 主流程
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--md", default="docs/核心文档/系统功能说明书.md")
    parser.add_argument("--out", default="docs/核心文档/智能问数分析系统-功能说明书-v0.9.119.docx")
    args = parser.parse_args()

    md_path = Path(args.md)
    if not md_path.exists():
        sys.exit("未找到 Markdown 源文件：%s" % md_path)
    md_text = md_path.read_text(encoding="utf-8")
    md_lines = md_text.split("\n")

    document = Document()
    build_styles(document)
    build_section(document)
    set_update_fields(document)

    today = date.today().strftime("%Y-%m-%d")
    add_cover(document)
    add_info_pages(document, today)
    add_toc(document)
    render_body(document, md_lines)
    add_appendix(document, md_text)

    core = document.core_properties
    core.title = "智能问数分析系统 · 功能说明书"
    core.subject = "NL2SQL Pro v0.9.119 功能说明书（正式交付版）"
    core.author = "产品与研发中心"
    core.category = "功能说明书"
    core.comments = "由 docs/核心文档/系统功能说明书.md 生成"

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    document.save(str(out_path))
    print("已生成：%s" % out_path)
    print("段落 %d / 表格 %d" % (len(document.paragraphs), len(document.tables)))


if __name__ == "__main__":
    main()
