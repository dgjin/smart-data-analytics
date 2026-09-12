/**
 * P0-2 报告导出（Word）：服务端组装 DOCX（docx）。
 * 结构：标题与生成信息（含水印）→ 执行摘要 → 核心 KPI 表格 → 图表与解读（嵌入 PNG，无图走文字兜底）→ 结论与建议。
 * 纯构建函数 buildReportWord 可单测；路由在 server/routes/report.ts（POST /api/report/export-word）。
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { isPngDataUri, type ReportExportData } from './reportExport';

const C = {
  navy: '0F172A',
  indigo: '4F46E5',
  text: '1E293B',
  muted: '64748B',
  good: '059669',
  bad: 'DC2626',
  amber: 'D97706',
  divider: 'E2E8F0',
  white: 'FFFFFF',
};

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  good: { label: '达标', color: C.good },
  bad: { label: '预警', color: C.bad },
  neutral: { label: '—', color: C.muted },
};

const INSIGHT_LABEL: Record<string, { label: string; color: string }> = {
  positive: { label: '利好', color: C.good },
  warning: { label: '预警', color: C.amber },
  critical: { label: '风险', color: C.bad },
  info: { label: '洞察', color: C.muted },
};

/** 图表 PNG 在 Word 中的嵌入尺寸（像素 @96dpi；A4 内容区约 650px 宽） */
const CHART_IMG_W = 580;
const CHART_IMG_H = 326;

/** 中文字体声明（docx 仅声明字体名，不要求服务端具备该字体） */
const FONT = '微软雅黑';

function heading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 280, after: 120 },
    children: [new TextRun({ text, bold: true, size: 28, color: C.indigo, font: FONT })],
  });
}

function body(text: string, opts: { size?: number; color?: string; italics?: boolean } = {}): Paragraph {
  return new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text, size: opts.size ?? 21, color: opts.color ?? C.text, italics: opts.italics, font: FONT })],
  });
}

function cell(text: string, opts: { bold?: boolean; color?: string; fill?: string; width: number }): TableCell {
  return new TableCell({
    width: { size: opts.width, type: WidthType.PERCENTAGE },
    shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        spacing: { after: 0 },
        children: [new TextRun({ text: text || '', size: 20, bold: opts.bold, color: opts.color ?? C.text, font: FONT })],
      }),
    ],
  });
}

const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 1, color: C.divider } as const;
const TABLE_BORDERS = {
  top: TABLE_BORDER,
  bottom: TABLE_BORDER,
  left: TABLE_BORDER,
  right: TABLE_BORDER,
  insideHorizontal: TABLE_BORDER,
  insideVertical: TABLE_BORDER,
};

/** 组装 DOCX 并返回 Buffer */
export async function buildReportWord(data: ReportExportData): Promise<Buffer> {
  const kpis = data.kpiList || [];
  const insights = data.insights || [];
  const charts = data.charts || [];
  const watermark = `本文件由智能问数据分析系统生成${data.exportedBy ? ` · 导出人: ${data.exportedBy}` : ''} · 含访问水印，严禁外传`;

  const children: (Paragraph | Table)[] = [];

  // ---------- 1. 标题与生成信息 ----------
  children.push(
    new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({ text: data.title, bold: true, size: 40, color: C.text, font: FONT })],
    })
  );
  children.push(
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({ text: `生成日期：${data.createdAt || ''}`, size: 19, color: C.muted, font: FONT }),
        ...(data.templateType
          ? [new TextRun({ text: `    报告模板：${data.templateType}`, size: 19, color: C.muted, font: FONT })]
          : []),
      ],
    })
  );
  children.push(
    new Paragraph({
      spacing: { after: 160 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.indigo, space: 4 } },
      children: [new TextRun({ text: watermark, size: 16, color: C.muted, italics: true, font: FONT })],
    })
  );

  // ---------- 2. 执行摘要 ----------
  children.push(heading('一、执行摘要'));
  children.push(body(data.summary || '本报告由 AI 基于数据源自动生成，供管理层快速掌握经营全貌。', { size: 22 }));

  // ---------- 3. 核心 KPI 表格 ----------
  children.push(heading('二、核心 KPI 指标'));
  if (kpis.length === 0) {
    children.push(body('本报告未包含 KPI 指标。', { color: C.muted }));
  } else {
    const rows: TableRow[] = [
      new TableRow({
        tableHeader: true,
        children: [
          cell('指标', { bold: true, color: C.white, fill: C.navy, width: 22 }),
          cell('数值', { bold: true, color: C.white, fill: C.navy, width: 18 }),
          cell('环比变化', { bold: true, color: C.white, fill: C.navy, width: 14 }),
          cell('状态', { bold: true, color: C.white, fill: C.navy, width: 12 }),
          cell('异常提示', { bold: true, color: C.white, fill: C.navy, width: 34 }),
        ],
      }),
    ];
    for (const k of kpis) {
      const status = STATUS_LABEL[k.status || 'neutral'] || STATUS_LABEL.neutral;
      rows.push(
        new TableRow({
          children: [
            cell(k.label, { bold: true, width: 22 }),
            cell(k.value || '—', { bold: true, width: 18 }),
            cell(k.change || '—', { color: status.color, width: 14 }),
            cell(status.label, { bold: true, color: status.color, width: 12 }),
            cell(k.anomalyNote || '', { color: C.amber, width: 34 }),
          ],
        })
      );
    }
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: TABLE_BORDERS, rows }));
  }

  // ---------- 4. 图表与解读 ----------
  if (charts.length > 0) {
    children.push(heading('三、图表与解读'));
    for (const chart of charts) {
      children.push(
        new Paragraph({
          spacing: { before: 160, after: 80 },
          children: [new TextRun({ text: chart.title, bold: true, size: 24, color: C.text, font: FONT })],
        })
      );
      if (isPngDataUri(chart.imageBase64)) {
        const base64 = chart.imageBase64.replace(/^data:image\/png;base64,/, '');
        children.push(
          new Paragraph({
            spacing: { after: 80 },
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                type: 'png',
                data: Buffer.from(base64, 'base64'),
                transformation: { width: CHART_IMG_W, height: CHART_IMG_H },
              }),
            ],
          })
        );
      } else {
        children.push(body('（图表图片未导出，以下为文字解读）', { color: C.muted, italics: true }));
      }
      if (chart.commentary) children.push(body(chart.commentary, { size: 20, color: C.muted }));
    }
  }

  // ---------- 5. 结论与建议 ----------
  if (insights.length > 0) {
    children.push(heading(`${charts.length > 0 ? '四' : '三'}、结论与建议`));
    for (const ins of insights) {
      const tag = INSIGHT_LABEL[ins.type || 'info'] || INSIGHT_LABEL.info;
      children.push(
        new Paragraph({
          spacing: { before: 120, after: 40 },
          children: [
            new TextRun({ text: `【${tag.label}】`, bold: true, size: 22, color: tag.color, font: FONT }),
            new TextRun({ text: ins.title, bold: true, size: 22, color: C.text, font: FONT }),
          ],
        })
      );
      children.push(body(ins.content, { size: 20, color: C.muted }));
      if (ins.actionItem) {
        children.push(
          new Paragraph({
            spacing: { after: 120 },
            children: [new TextRun({ text: `建议：${ins.actionItem}`, size: 20, bold: true, color: C.indigo, font: FONT })],
          })
        );
      }
    }
  }

  const doc = new Document({
    creator: '智能问数据分析系统',
    title: data.title,
    description: 'AI 决策简报',
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [
      {
        properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
