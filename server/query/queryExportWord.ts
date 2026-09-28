/**
 * v0.9.82 问数结果导出（Word）：服务端用 docx 组装 DOCX。
 * 结构：标题与元信息（含水印）→ AI 解读 → 核心指标表 → AI 归因分析与决策提示 →
 *       生成的 SQL → 图表（嵌入 PNG，等比缩放）→ 明细数据表（前 100 行）→ 尾水印。
 * 纯构建函数 buildQueryWord 可单测；路由在 server/routes/export.ts（POST /api/export/query-doc）。
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
import { isPngDataUri } from '../report/reportExport';
import type { QueryExportData } from './queryExport';

const C = {
  navy: '0F172A',
  indigo: '4F46E5',
  text: '1E293B',
  muted: '64748B',
  divider: 'E2E8F0',
  white: 'FFFFFF',
  codeBg: 'F1F5F9',
};

/** 中文字体声明（docx 仅声明字体名，不要求服务端具备该字体） */
const FONT = '微软雅黑';
/** 图表在 Word 中的目标宽度（A4 内容区约 650px 宽） */
const CHART_IMG_W = 580;

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

function cell(text: string, opts: { bold?: boolean; color?: string; fill?: string; width: number; size?: number }): TableCell {
  return new TableCell({
    width: { size: opts.width, type: WidthType.PERCENTAGE },
    shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [
      new Paragraph({
        spacing: { after: 0 },
        children: [new TextRun({ text: text || '', size: opts.size ?? 18, bold: opts.bold, color: opts.color ?? C.text, font: FONT })],
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

/** 从 PNG 二进制读取像素尺寸（IHDR 宽高位于偏移 16..24，大端） */
function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length >= 24) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
  }
  return { width: CHART_IMG_W * 2, height: 326 * 2 };
}

/** 组装 DOCX 并返回 Buffer */
export async function buildQueryWord(data: QueryExportData): Promise<Buffer> {
  const watermark = `本文件由智能问数据分析系统生成${data.exportedBy ? ` · 导出人: ${data.exportedBy}` : ''} · 含访问水印，严禁外传`;
  const children: (Paragraph | Table)[] = [];

  // ---------- 1. 标题与元信息 ----------
  children.push(
    new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({ text: data.title, bold: true, size: 36, color: C.text, font: FONT })],
    }),
  );
  const metaParts = [
    data.dataSourceName && `数据源：${data.dataSourceName}`,
    data.provenanceLabel && `数据来源：${data.provenanceLabel}`,
    `导出时间：${data.createdAt}`,
  ].filter(Boolean) as string[];
  children.push(
    new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: metaParts.join('    '), size: 19, color: C.muted, font: FONT })],
    }),
  );
  children.push(
    new Paragraph({
      spacing: { after: 160 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.indigo, space: 4 } },
      children: [new TextRun({ text: watermark, size: 16, color: C.muted, italics: true, font: FONT })],
    }),
  );

  // ---------- 2. AI 解读 ----------
  if (data.aiExplanation.trim()) {
    children.push(heading('AI 解读'));
    children.push(body(data.aiExplanation.trim(), { size: 22 }));
  }

  // ---------- 3. 核心指标 ----------
  if (data.kpiMetrics.length > 0) {
    children.push(heading('核心指标'));
    const rows: TableRow[] = [
      new TableRow({
        tableHeader: true,
        children: [
          cell('指标', { bold: true, color: C.white, fill: C.navy, width: 26 }),
          cell('数值', { bold: true, color: C.white, fill: C.navy, width: 24 }),
          cell('说明', { bold: true, color: C.white, fill: C.navy, width: 50 }),
        ],
      }),
    ];
    for (const k of data.kpiMetrics) {
      rows.push(
        new TableRow({
          children: [
            cell(k.label, { bold: true, width: 26 }),
            cell(k.value || '—', { bold: true, width: 24 }),
            cell(k.note || '—', { color: C.muted, width: 50 }),
          ],
        }),
      );
    }
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: TABLE_BORDERS, rows }));
  }

  // ---------- 4. AI 归因分析与决策提示 ----------
  if (data.keyInsights.length > 0) {
    children.push(heading('AI 归因分析与决策提示'));
    data.keyInsights.forEach((insight, i) => {
      children.push(
        new Paragraph({
          spacing: { before: 60, after: 80 },
          children: [
            new TextRun({ text: `${i + 1}. `, bold: true, size: 21, color: C.indigo, font: FONT }),
            new TextRun({ text: insight, size: 21, color: C.text, font: FONT }),
          ],
        }),
      );
    });
  }

  // ---------- 5. 生成的 SQL ----------
  if (data.sql.trim()) {
    children.push(heading('生成的 SQL'));
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        shading: { type: ShadingType.CLEAR, fill: C.codeBg },
        indent: { left: 120, right: 120 },
        children: [new TextRun({ text: data.sql.trim(), size: 17, color: C.text, font: FONT })],
      }),
    );
  }

  // ---------- 6. 图表 ----------
  if (isPngDataUri(data.chartImageBase64)) {
    children.push(heading(`图表：${data.chartTitle || '可视化'}`));
    try {
      const imgBuf = Buffer.from(data.chartImageBase64.replace(/^data:image\/png;base64,/, ''), 'base64');
      const size = pngSize(imgBuf);
      const width = CHART_IMG_W;
      const height = Math.round((size.height / size.width) * width);
      children.push(
        new Paragraph({
          spacing: { after: 120 },
          alignment: AlignmentType.CENTER,
          children: [new ImageRun({ type: 'png', data: imgBuf, transformation: { width, height } })],
        }),
      );
    } catch {
      children.push(body('（图表图片未导出）', { color: C.muted, italics: true }));
    }
  }

  // ---------- 7. 明细数据 ----------
  if (data.columns.length > 0 && data.rows.length > 0) {
    const rowNote = data.truncated ? `（共 ${data.totalCount} 行，展示前 ${data.rows.length} 行）` : `（共 ${data.rows.length} 行）`;
    children.push(heading(`明细数据${rowNote}`));
    const colW = Math.floor(100 / data.columns.length);
    const header = new TableRow({
      tableHeader: true,
      children: data.columns.map((c) => cell(c, { bold: true, color: C.white, fill: C.navy, width: colW, size: 16 })),
    });
    const rows: TableRow[] = [header];
    for (const r of data.rows) {
      rows.push(new TableRow({ children: r.map((v) => cell(v, { width: colW, size: 16 })) }));
    }
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: TABLE_BORDERS, rows }));
  }

  // ---------- 8. 尾水印 ----------
  children.push(
    new Paragraph({
      spacing: { before: 200 },
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.divider, space: 4 } },
      children: [
        new TextRun({
          text: `导出水印：${data.exportedBy || '—'} · ${data.createdAt} · 如发现数据泄露请联系数据安全管理员溯源`,
          size: 16,
          color: C.muted,
          italics: true,
          font: FONT,
        }),
      ],
    }),
  );

  const doc = new Document({
    creator: '智能问数据分析系统',
    title: data.title,
    description: 'AI 问数结果文档',
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
