#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v0.5.3 报告 PDF 服务端生成（ReportLab 原生排版，替代前端 html2canvas 截图方案）。
输入：stdin 读取 JSON（结构与 /api/report/export PPTX 一致）
  {
    "title": str, "summary": str, "createdAt": str, "templateType": str,
    "kpiList": [{label, value, change?, status?}],
    "insights": [{title, type?, content, actionItem?}],
    "charts": [{"title": str, "commentary"?: str, "imageBase64"?: str}],
    "orientation"?: "portrait" | "landscape"
  }
输出：stdout 写入 PDF 二进制；失败时 stderr 写错误信息并以非 0 退出码结束。
中文：使用 ReportLab 内置 Adobe CID 字体 STSong-Light（无需外部字体文件）。
"""
import sys
import json
import base64
import io
import re

from reportlab.lib.pagesizes import A4, landscape as landscape_pagesize
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Image, Table, TableStyle, PageBreak,
)
from reportlab.lib.styles import ParagraphStyle

# ---------- 配色（与系统深色报表卡片一致的靛青体系） ----------
NAVY = HexColor('#0F172A')
SLATE = HexColor('#334155')
TEXT = HexColor('#1E293B')
MUTED = HexColor('#64748B')
INDIGO = HexColor('#4F46E5')
CYAN = HexColor('#0891B2')
GOOD = HexColor('#059669')
BAD = HexColor('#DC2626')
AMBER = HexColor('#D97706')
DIVIDER = HexColor('#E2E8F0')
BG_LIGHT = HexColor('#F8FAFC')

INSIGHT_TAG = {
    'positive': ('利好', GOOD),
    'warning': ('预警', AMBER),
    'critical': ('风险', BAD),
    'info': ('洞察', CYAN),
}

FONT = 'STSong-Light'


def register_fonts():
    pdfmetrics.registerFont(UnicodeCIDFont(FONT))


def esc(s):
    """转义 Paragraph 的 XML 特殊字符"""
    if s is None:
        return ''
    s = str(s)
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def styles():
    return {
        'title': ParagraphStyle('title', fontName=FONT, fontSize=22, leading=30, textColor=NAVY, spaceAfter=4),
        'meta': ParagraphStyle('meta', fontName=FONT, fontSize=9, leading=14, textColor=MUTED),
        'h2': ParagraphStyle('h2', fontName=FONT, fontSize=14, leading=20, textColor=NAVY, spaceBefore=14, spaceAfter=6),
        'body': ParagraphStyle('body', fontName=FONT, fontSize=10.5, leading=17, textColor=TEXT),
        'small': ParagraphStyle('small', fontName=FONT, fontSize=9, leading=14, textColor=MUTED),
        'kpi_label': ParagraphStyle('kpi_label', fontName=FONT, fontSize=9, leading=13, textColor=MUTED, alignment=TA_CENTER),
        'kpi_value': ParagraphStyle('kpi_value', fontName=FONT, fontSize=15, leading=20, textColor=NAVY, alignment=TA_CENTER),
        'kpi_change': ParagraphStyle('kpi_change', fontName=FONT, fontSize=8.5, leading=12, textColor=CYAN, alignment=TA_CENTER),
        'chart_title': ParagraphStyle('chart_title', fontName=FONT, fontSize=12, leading=17, textColor=NAVY, spaceBefore=10, spaceAfter=4),
        'insight_title': ParagraphStyle('insight_title', fontName=FONT, fontSize=11, leading=16, textColor=NAVY),
    }


def header_footer_factory(page_w, page_h, title_text, watermark=''):
    """页眉：报告标题（左）+ 系统名（右）；页脚：分隔线 + 页码 + DLP 导出水印"""
    def on_page(canvas, doc):
        canvas.saveState()
        canvas.setFont(FONT, 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(18 * mm, page_h - 12 * mm, title_text[:40])
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


def build_kpi_table(kpi_list, st, avail_w):
    """KPI 网格：每行最多 4 个卡片（label/value/change 纵向堆叠）"""
    if not kpi_list:
        return []
    per_row = 4
    cell_w = avail_w / per_row
    rows = []
    for i in range(0, len(kpi_list), per_row):
        chunk = kpi_list[i:i + per_row]
        cells = []
        for k in chunk:
            inner = Table(
                [
                    [Paragraph(esc(k.get('label', '')), st['kpi_label'])],
                    [Paragraph(esc(k.get('value', '')), st['kpi_value'])],
                    [Paragraph(esc(k.get('change', '')), st['kpi_change'])],
                ],
                colWidths=[cell_w - 10],
            )
            inner.setStyle(TableStyle([
                ('TOPPADDING', (0, 0), (-1, 0), 6),
                ('BOTTOMPADDING', (0, -1), (-1, -1), 6),
                ('TOPPADDING', (0, 1), (-1, 1), 2),
                ('BOTTOMPADDING', (0, 0), (-1, 0), 2),
            ]))
            cells.append(inner)
        # 不足 4 个补空
        while len(cells) < per_row:
            cells.append('')
        t = Table([cells], colWidths=[cell_w] * per_row)
        t.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), BG_LIGHT),
            ('BOX', (0, 0), (-1, -1), 0.5, DIVIDER),
            ('LINEBEFORE', (1, 0), (-1, -1), 0.5, DIVIDER),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ]))
        rows.append(t)
        rows.append(Spacer(1, 4))
    return rows


def hexs(c):
    """HexColor → '#RRGGBB' 字符串（Paragraph font color 标签要求井号前缀）"""
    return '#%02x%02x%02x' % (int(c.red * 255), int(c.green * 255), int(c.blue * 255))


def build_insights(insights, st, avail_w):
    """洞察列表：类型标签 + 标题 + 内容 + 行动建议（KeepTogether 防跨页断裂错位）"""
    from reportlab.platypus import KeepTogether
    flow = []
    for ins in insights:
        tag_label, tag_color = INSIGHT_TAG.get(ins.get('type', 'info'), INSIGHT_TAG['info'])
        head = Table(
            [[
                Paragraph(f'<font color="{hexs(tag_color)}">【{esc(tag_label)}】</font> {esc(ins.get("title", ""))}', st['insight_title']),
            ]],
            colWidths=[avail_w],
        )
        head.setStyle(TableStyle([
            ('LEFTPADDING', (0, 0), (-1, -1), 8),
            ('TOPPADDING', (0, 0), (-1, -1), 5),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
            ('LINEBEFORE', (0, 0), (0, -1), 2, tag_color),
        ]))
        body_parts = [head]
        if ins.get('content'):
            body_parts.append(Paragraph(esc(ins['content']), ParagraphStyle('ins_c', parent=st['body'], leftIndent=8)))
        if ins.get('actionItem'):
            body_parts.append(Paragraph(f'▸ 建议：{esc(ins["actionItem"])}', ParagraphStyle('ins_a', parent=st['small'], leftIndent=8, textColor=CYAN)))
        body_parts.append(Spacer(1, 4))
        flow.append(KeepTogether(body_parts))
    return flow


def build_charts(charts, st, avail_w, avail_h):
    """每图：标题 + PNG 图片（等比缩放适配页宽）+ 解读"""
    from reportlab.platypus import KeepTogether
    flow = []
    max_img_h = avail_h * 0.52  # 图片最大高度，防单图占满整页
    for ch in charts:
        block = [Paragraph(esc(ch.get('title', '图表')), st['chart_title'])]
        img_b64 = ch.get('imageBase64') or ''
        if img_b64:
            try:
                if ',' in img_b64:
                    img_b64 = img_b64.split(',', 1)[1]
                raw = base64.b64decode(img_b64)
                buf = io.BytesIO(raw)
                img = Image(buf)
                # 等比缩放：先适配页宽，再限制最大高度
                iw, ih = img.imageWidth, img.imageHeight
                if iw > 0 and ih > 0:
                    scale = avail_w / iw if iw > avail_w else 1.0
                    if ih * scale > max_img_h:
                        scale = max_img_h / ih
                    img.drawWidth = iw * scale
                    img.drawHeight = ih * scale
                block.append(img)
            except Exception as e:
                print(f'[pdf] 图表图片解析失败（跳过图片仅留标题）: {e}', file=sys.stderr)
        if ch.get('commentary'):
            block.append(Spacer(1, 3))
            block.append(Paragraph(esc(ch['commentary']), st['small']))
        block.append(Spacer(1, 8))
        flow.append(KeepTogether(block))
    return flow


def build_pdf(data):
    orientation = data.get('orientation')
    page_size = landscape_pagesize(A4) if orientation == 'landscape' else A4
    page_w, page_h = page_size
    margin = 18 * mm
    avail_w = page_w - margin * 2
    avail_h = page_h - margin * 2 - 16 * mm  # 预留页眉页脚

    register_fonts()
    st = styles()

    out = io.BytesIO()
    doc = BaseDocTemplate(
        out, pagesize=page_size,
        leftMargin=margin, rightMargin=margin, topMargin=22 * mm, bottomMargin=20 * mm,
        title=str(data.get('title', '分析报告')), author='NL2SQL Pro',
    )
    frame = Frame(margin, 20 * mm, avail_w, page_h - 42 * mm, id='main')
    doc.addPageTemplates([PageTemplate(id='page', frames=[frame], onPage=header_footer_factory(page_w, page_h, str(data.get('title', '')), str(data.get('watermark', ''))))])

    story = []
    # 标题区
    story.append(Paragraph(esc(data.get('title', '分析报告')), st['title']))
    meta_parts = []
    if data.get('createdAt'):
        meta_parts.append(f'报告日期：{esc(data["createdAt"])}')
    if data.get('templateType'):
        meta_parts.append(f'模板：{esc(data["templateType"])}')
    if meta_parts:
        story.append(Paragraph('　·　'.join(meta_parts), st['meta']))
    story.append(Spacer(1, 4))
    story.append(Table([['']], colWidths=[avail_w], rowHeights=[1.5], style=TableStyle([('BACKGROUND', (0, 0), (-1, -1), INDIGO)])))

    # 高管摘要
    if data.get('summary'):
        story.append(Paragraph('高管摘要', st['h2']))
        story.append(Paragraph(esc(data['summary']), st['body']))

    # KPI
    kpis = data.get('kpiList') or []
    if kpis:
        story.append(Paragraph('核心指标', st['h2']))
        story.extend(build_kpi_table(kpis, st, avail_w))

    # 洞察
    insights = data.get('insights') or []
    if insights:
        story.append(Paragraph('战略洞察与建议', st['h2']))
        story.extend(build_insights(insights, st, avail_w))

    # 图表
    charts = data.get('charts') or []
    if charts:
        story.append(PageBreak())
        story.append(Paragraph('图表分析', st['h2']))
        story.extend(build_charts(charts, st, avail_w, avail_h))

    doc.build(story)
    return out.getvalue()


def main():
    try:
        raw = sys.stdin.buffer.read()
        data = json.loads(raw.decode('utf-8'))
    except Exception as e:
        print(f'[pdf] 输入 JSON 解析失败: {e}', file=sys.stderr)
        sys.exit(2)
    if not isinstance(data, dict) or not data.get('title'):
        print('[pdf] 缺少报告标题', file=sys.stderr)
        sys.exit(2)
    try:
        pdf_bytes = build_pdf(data)
    except Exception as e:
        print(f'[pdf] PDF 生成失败: {e}', file=sys.stderr)
        sys.exit(3)
    sys.stdout.buffer.write(pdf_bytes)


if __name__ == '__main__':
    main()
