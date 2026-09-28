#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v0.9.82 问数结果 PDF 服务端生成（ReportLab 原生排版）。
输入：stdin 读取 JSON（结构与 server/query/queryExport.ts 的 QueryExportData 一致）
  {
    "title": str, "dataSourceName": str, "provenanceLabel": str,
    "createdAt": str, "exportedBy": str, "sql": str, "aiExplanation": str,
    "kpiMetrics": [{"label", "value", "note"}],
    "keyInsights": [str],
    "chartTitle": str, "chartImageBase64"?: str,
    "columns": [str], "rows": [[str]], "totalCount": int, "truncated": bool
  }
输出：stdout 写入 PDF 二进制；失败时 stderr 写错误信息并以非 0 退出码结束。
中文：使用 ReportLab 内置 Adobe CID 字体 STSong-Light（无需外部字体文件）。
"""
import sys
import json
import base64
import io
import re

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Image, Table, TableStyle,
)
from reportlab.lib.styles import ParagraphStyle

# ---------- 配色（与系统深色界面一致的靛青体系） ----------
NAVY = HexColor('#0F172A')
SLATE = HexColor('#334155')
TEXT = HexColor('#1E293B')
MUTED = HexColor('#64748B')
INDIGO = HexColor('#4F46E5')
DIVIDER = HexColor('#E2E8F0')
BG_LIGHT = HexColor('#F8FAFC')

FONT = 'STSong-Light'


def register_fonts():
    pdfmetrics.registerFont(UnicodeCIDFont(FONT))


def esc(s):
    """转义 Paragraph 的 XML 特殊字符"""
    if s is None:
        return ''
    s = str(s)
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def hexs(c):
    """HexColor → '#RRGGBB' 字符串（Paragraph font color 标签要求井号前缀）"""
    return '#%02x%02x%02x' % (int(c.red * 255), int(c.green * 255), int(c.blue * 255))


def styles():
    return {
        'title': ParagraphStyle('title', fontName=FONT, fontSize=18, leading=26, textColor=NAVY, spaceAfter=4),
        'meta': ParagraphStyle('meta', fontName=FONT, fontSize=9, leading=14, textColor=MUTED),
        'watermark': ParagraphStyle('watermark', fontName=FONT, fontSize=8.5, leading=13, textColor=MUTED),
        'h2': ParagraphStyle('h2', fontName=FONT, fontSize=13, leading=19, textColor=NAVY, spaceBefore=14, spaceAfter=6),
        'body': ParagraphStyle('body', fontName=FONT, fontSize=10.5, leading=17, textColor=TEXT),
        'small': ParagraphStyle('small', fontName=FONT, fontSize=9, leading=14, textColor=MUTED),
        'cell': ParagraphStyle('cell', fontName=FONT, fontSize=7.5, leading=10.5, textColor=TEXT),
        'cell_head': ParagraphStyle('cell_head', fontName=FONT, fontSize=8, leading=11, textColor=white),
        'sql': ParagraphStyle('sql', fontName=FONT, fontSize=8.5, leading=13, textColor=SLATE,
                              backColor=BG_LIGHT, borderPadding=6, borderColor=DIVIDER, borderWidth=0.5),
        'insight_num': ParagraphStyle('insight_num', fontName=FONT, fontSize=11, leading=16, textColor=NAVY),
    }


def header_footer_factory(page_w, page_h, title_text, watermark=''):
    """页眉：提问（左）+ 系统名（右）；页脚：分隔线 + 页码 + DLP 导出水印"""
    def on_page(canvas, doc):
        canvas.saveState()
        canvas.setFont(FONT, 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(18 * mm, page_h - 12 * mm, title_text[:44])
        canvas.drawRightString(page_w - 18 * mm, page_h - 12 * mm, 'NL2SQL Pro · 智能问数分析系统')
        canvas.setStrokeColor(DIVIDER)
        canvas.setLineWidth(0.5)
        canvas.line(18 * mm, page_h - 14 * mm, page_w - 18 * mm, page_h - 14 * mm)
        canvas.line(18 * mm, 14 * mm, page_w - 18 * mm, 14 * mm)
        canvas.drawCentredString(page_w / 2, 9 * mm, f'第 {doc.page} 页')
        # P2-12 DLP 导出水印：页脚右侧（泄漏可溯源）
        if watermark:
            canvas.drawRightString(page_w - 18 * mm, 9 * mm, watermark[:80])
        canvas.restoreState()
    return on_page


def build_kpi_table(kpis, st, avail_w):
    """核心指标表：指标 / 数值 / 说明（列宽 26/24/50）。首行深底白字，其余浅底"""
    if not kpis:
        return []
    head = st['cell_head']
    cell = st['cell']
    data = [[
        Paragraph('指标', head), Paragraph('数值', head), Paragraph('说明', head),
    ]]
    for k in kpis:
        data.append([
            Paragraph(f'<b>{esc(k.get("label", ""))}</b>', cell),
            Paragraph(f'<b>{esc(k.get("value", ""))}</b>', cell),
            Paragraph(esc(k.get('note', '')), cell),
        ])
    t = Table(data, colWidths=[avail_w * 0.26, avail_w * 0.24, avail_w * 0.50])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), NAVY),
        ('GRID', (0, 0), (-1, -1), 0.5, DIVIDER),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    return [t, Spacer(1, 4)]


def build_insights(insights, st, avail_w):
    """AI 归因分析与决策提示：编号 + 文本（KeepTogether 防跨页断裂）"""
    from reportlab.platypus import KeepTogether
    flow = []
    for i, text in enumerate(insights):
        p = Paragraph(
            f'<font color="{hexs(INDIGO)}"><b>{i + 1}.</b></font>  {esc(text)}',
            ParagraphStyle('ins', parent=st['body'], leftIndent=14, firstLineIndent=-14),
        )
        flow.append(KeepTogether([p, Spacer(1, 4)]))
    return flow


def build_chart(data, st, avail_w, avail_h):
    """图表：标题 + PNG 等比缩放（限页宽的 70%，防单图占满整页）"""
    img_b64 = data.get('chartImageBase64') or ''
    if not img_b64:
        return []
    from reportlab.platypus import KeepTogether
    block = [Paragraph(esc(f'图表：{data.get("chartTitle") or "可视化"}'), st['h2'])]
    try:
        if ',' in img_b64:
            img_b64 = img_b64.split(',', 1)[1]
        raw = base64.b64decode(img_b64)
        buf = io.BytesIO(raw)
        img = Image(buf)
        iw, ih = img.imageWidth, img.imageHeight
        max_w = avail_w
        max_h = avail_h * 0.55
        if iw > 0 and ih > 0:
            scale = min(max_w / iw, max_h / ih, 1.0)
            img.drawWidth = iw * scale
            img.drawHeight = ih * scale
        block.append(img)
    except Exception as e:
        print(f'[query-pdf] 图表图片解析失败（跳过图片仅留标题）: {e}', file=sys.stderr)
    block.append(Spacer(1, 8))
    return [KeepTogether(block)]


def build_detail_table(columns, rows, total_count, truncated, st, avail_w):
    """明细数据表：中文表头深底白字，数据行自动折行；repeatRows=1 跨页重复表头"""
    if not columns or not rows:
        return []
    n = len(columns)
    col_w = avail_w / n
    head = st['cell_head']
    cell = st['cell']
    data = [[Paragraph(esc(c), head) for c in columns]]
    for r in rows:
        data.append([Paragraph(esc(v), cell) for v in r])
    t = Table(data, colWidths=[col_w] * n, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), NAVY),
        ('GRID', (0, 0), (-1, -1), 0.4, DIVIDER),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
    ]))
    return [t]


def build_pdf(data):
    page_size = A4
    page_w, page_h = page_size
    margin = 18 * mm
    avail_w = page_w - margin * 2
    avail_h = page_h - margin * 2 - 16 * mm  # 预留页眉页脚

    register_fonts()
    st = styles()

    watermark = ''
    if data.get('exportedBy'):
        watermark = f'导出人: {data["exportedBy"]} · 严禁外传'

    out = io.BytesIO()
    doc = BaseDocTemplate(
        out, pagesize=page_size,
        leftMargin=margin, rightMargin=margin, topMargin=22 * mm, bottomMargin=20 * mm,
        title=str(data.get('title', '问数结果')), author='NL2SQL Pro',
    )
    frame = Frame(margin, 20 * mm, avail_w, page_h - 42 * mm, id='main')
    doc.addPageTemplates([PageTemplate(
        id='page', frames=[frame],
        onPage=header_footer_factory(page_w, page_h, str(data.get('title', '')), watermark),
    )])

    story = []
    # 标题区（提问原文）+ 元信息 + 水印行 + 靛青分隔线
    story.append(Paragraph(esc(data.get('title', '问数结果')), st['title']))
    meta_parts = []
    if data.get('dataSourceName'):
        meta_parts.append(f'数据源：{esc(data["dataSourceName"])}')
    if data.get('provenanceLabel'):
        meta_parts.append(f'数据来源：{esc(data["provenanceLabel"])}')
    if data.get('createdAt'):
        meta_parts.append(f'导出时间：{esc(data["createdAt"])}')
    if meta_parts:
        story.append(Paragraph('　·　'.join(meta_parts), st['meta']))
    if data.get('exportedBy'):
        story.append(Paragraph(f'导出人：{esc(data["exportedBy"])} · 本文件含访问水印，严禁外传', st['watermark']))
    story.append(Spacer(1, 4))
    story.append(Table([['']], colWidths=[avail_w], rowHeights=[1.5], style=TableStyle([('BACKGROUND', (0, 0), (-1, -1), INDIGO)])))

    # AI 解读
    if (data.get('aiExplanation') or '').strip():
        story.append(Paragraph('AI 解读', st['h2']))
        story.append(Paragraph(esc(data['aiExplanation']).replace('\n', '<br/>'), st['body']))

    # 核心指标
    kpis = data.get('kpiMetrics') or []
    if kpis:
        story.append(Paragraph('核心指标', st['h2']))
        story.extend(build_kpi_table(kpis, st, avail_w))

    # AI 归因分析与决策提示
    insights = data.get('keyInsights') or []
    if insights:
        story.append(Paragraph('AI 归因分析与决策提示', st['h2']))
        story.extend(build_insights(insights, st, avail_w))

    # 生成的 SQL
    if (data.get('sql') or '').strip():
        story.append(Paragraph('生成的 SQL', st['h2']))
        story.append(Paragraph(esc(data['sql']).replace('\n', '<br/>'), st['sql']))

    # 图表
    story.extend(build_chart(data, st, avail_w, avail_h))

    # 明细数据
    columns = data.get('columns') or []
    rows = data.get('rows') or []
    if columns and rows:
        if data.get('truncated'):
            note = f'（共 {int(data.get("totalCount") or len(rows))} 行，展示前 {len(rows)} 行）'
        else:
            note = f'（共 {len(rows)} 行）'
        story.append(Paragraph(f'明细数据{note}', st['h2']))
        story.extend(build_detail_table(columns, rows, data.get('totalCount'), data.get('truncated'), st, avail_w))

    doc.build(story)
    return out.getvalue()


def main():
    try:
        raw = sys.stdin.buffer.read()
        data = json.loads(raw.decode('utf-8'))
    except Exception as e:
        print(f'[query-pdf] 输入 JSON 解析失败: {e}', file=sys.stderr)
        sys.exit(2)
    if not isinstance(data, dict) or not data.get('title'):
        print('[query-pdf] 缺少提问内容', file=sys.stderr)
        sys.exit(2)
    try:
        pdf_bytes = build_pdf(data)
    except Exception as e:
        print(f'[query-pdf] PDF 生成失败: {e}', file=sys.stderr)
        sys.exit(3)
    sys.stdout.buffer.write(pdf_bytes)


if __name__ == '__main__':
    main()
