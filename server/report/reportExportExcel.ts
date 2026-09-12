/**
 * P0-2 报告导出（Excel）：服务端组装 XLSX（exceljs）。
 * 工作表结构：高管摘要（含洞察与建议）→ 核心 KPI 指标 → 图表与解读（嵌入 PNG，无图走文字兜底）。
 * 纯构建函数 buildReportExcel 可单测；路由在 server/routes/report.ts（POST /api/report/export-excel）。
 * 水印：与 PPT/PDF 同口径，首行标注导出人（服务端注入，防泄漏溯源）。
 */
import ExcelJS from 'exceljs';
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
  panel: 'F8FAFC',
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

/** 图表 PNG 在 Excel 中的嵌入尺寸（像素；横向 16:9 观感） */
const CHART_IMG_W = 640;
const CHART_IMG_H = 360;
/** 每张图占用的行数（图片浮动锚定在标题下方，按行距推进避免重叠） */
const CHART_ROWS = 19;

function stripPngPrefix(dataUri: string): string {
  return dataUri.replace(/^data:image\/png;base64,/, '');
}

/** 组装 XLSX 并返回 Buffer */
export async function buildReportExcel(data: ReportExportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '智能问数据分析系统';
  wb.created = new Date();

  const kpis = data.kpiList || [];
  const insights = data.insights || [];
  const charts = data.charts || [];
  const watermark = `本文件由智能问数据分析系统生成${data.exportedBy ? ` · 导出人: ${data.exportedBy}` : ''} · 含访问水印，严禁外传`;

  // ---------- 工作表 1：高管摘要 ----------
  const s1 = wb.addWorksheet('高管摘要', { properties: { tabColor: { argb: C.indigo } } });
  s1.columns = [{ width: 14 }, { width: 40 }, { width: 40 }, { width: 30 }];

  const wm1 = s1.addRow([watermark]);
  s1.mergeCells(`A${wm1.number}:D${wm1.number}`);
  wm1.getCell(1).font = { size: 9, color: { argb: C.muted }, italic: true };

  s1.addRow([]);
  const titleRow = s1.addRow([data.title]);
  s1.mergeCells(`A${titleRow.number}:D${titleRow.number}`);
  titleRow.getCell(1).font = { size: 20, bold: true, color: { argb: C.text } };
  titleRow.height = 30;

  const metaRow = s1.addRow([`生成日期：${data.createdAt || ''}${data.templateType ? `    报告模板：${data.templateType}` : ''}`]);
  s1.mergeCells(`A${metaRow.number}:D${metaRow.number}`);
  metaRow.getCell(1).font = { size: 10, color: { argb: C.muted } };

  s1.addRow([]);
  const h1 = s1.addRow(['一、执行摘要']);
  s1.mergeCells(`A${h1.number}:D${h1.number}`);
  h1.getCell(1).font = { size: 13, bold: true, color: { argb: C.indigo } };

  const summaryRow = s1.addRow([data.summary || '本报告由 AI 基于数据源自动生成，供管理层快速掌握经营全貌。']);
  s1.mergeCells(`A${summaryRow.number}:D${summaryRow.number}`);
  summaryRow.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  summaryRow.getCell(1).font = { size: 11, color: { argb: C.text } };
  summaryRow.height = 64;

  if (insights.length > 0) {
    s1.addRow([]);
    const h2 = s1.addRow(['二、结论与建议']);
    s1.mergeCells(`A${h2.number}:D${h2.number}`);
    h2.getCell(1).font = { size: 13, bold: true, color: { argb: C.indigo } };

    const head = s1.addRow(['类别', '洞察标题', '分析内容', '行动建议']);
    head.eachCell((cell) => {
      cell.font = { bold: true, size: 10, color: { argb: C.text } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.panel } };
      cell.border = { bottom: { style: 'thin', color: { argb: C.divider } } };
    });
    for (const ins of insights) {
      const tag = INSIGHT_LABEL[ins.type || 'info'] || INSIGHT_LABEL.info;
      const row = s1.addRow([tag.label, ins.title, ins.content, ins.actionItem || '—']);
      row.getCell(1).font = { bold: true, size: 10, color: { argb: tag.color } };
      for (let i = 1; i <= 4; i += 1) {
        row.getCell(i).alignment = { wrapText: true, vertical: 'top' };
        row.getCell(i).font = { ...(row.getCell(i).font || {}), size: 10, color: { argb: i === 1 ? tag.color : C.text } };
      }
    }
  }

  // ---------- 工作表 2：核心 KPI ----------
  const s2 = wb.addWorksheet('核心 KPI', { properties: { tabColor: { argb: C.good } } });
  s2.columns = [{ width: 26 }, { width: 18 }, { width: 14 }, { width: 10 }, { width: 46 }];
  const wm2 = s2.addRow([watermark]);
  s2.mergeCells(`A${wm2.number}:E${wm2.number}`);
  wm2.getCell(1).font = { size: 9, color: { argb: C.muted }, italic: true };

  const kpiHead = s2.addRow(['指标', '数值', '环比变化', '状态', '异常提示']);
  kpiHead.eachCell((cell) => {
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.navy } };
  });
  if (kpis.length === 0) {
    s2.addRow(['本报告未包含 KPI 指标。']);
  } else {
    for (const k of kpis) {
      const status = STATUS_LABEL[k.status || 'neutral'] || STATUS_LABEL.neutral;
      const row = s2.addRow([k.label, k.value || '—', k.change || '—', status.label, k.anomalyNote || '']);
      row.getCell(2).font = { bold: true, size: 11, color: { argb: C.text } };
      row.getCell(3).font = { size: 10, color: { argb: status.color } };
      row.getCell(4).font = { bold: true, size: 10, color: { argb: status.color } };
      row.getCell(5).font = { size: 10, color: { argb: C.amber } };
      row.getCell(5).alignment = { wrapText: true };
      row.eachCell((cell) => {
        cell.border = { bottom: { style: 'hair', color: { argb: C.divider } } };
      });
    }
  }

  // ---------- 工作表 3：图表与解读 ----------
  const s3 = wb.addWorksheet('图表与解读', { properties: { tabColor: { argb: C.amber } } });
  s3.columns = [{ width: 20 }, { width: 30 }, { width: 30 }, { width: 30 }];
  const wm3 = s3.addRow([watermark]);
  s3.mergeCells(`A${wm3.number}:D${wm3.number}`);
  wm3.getCell(1).font = { size: 9, color: { argb: C.muted }, italic: true };
  s3.addRow([]);

  if (charts.length === 0) {
    const empty = s3.addRow(['本报告未包含图表。']);
    empty.getCell(1).font = { size: 11, color: { argb: C.muted } };
  }
  for (const chart of charts) {
    const titleRow = s3.addRow([`${chart.title}`]);
    s3.mergeCells(`A${titleRow.number}:D${titleRow.number}`);
    titleRow.getCell(1).font = { size: 13, bold: true, color: { argb: C.text } };
    titleRow.height = 22;

    if (chart.commentary) {
      const cRow = s3.addRow([chart.commentary]);
      s3.mergeCells(`A${cRow.number}:D${cRow.number}`);
      cRow.getCell(1).alignment = { wrapText: true, vertical: 'top' };
      cRow.getCell(1).font = { size: 10, color: { argb: C.muted } };
      cRow.height = 44;
    }

    if (isPngDataUri(chart.imageBase64)) {
      const imageId = wb.addImage({ base64: stripPngPrefix(chart.imageBase64), extension: 'png' });
      // 图片浮动锚定在当前行下方（0 基行 = 当前末行号），随后按行距推进
      s3.addImage(imageId, {
        tl: { col: 0, row: s3.rowCount },
        ext: { width: CHART_IMG_W, height: CHART_IMG_H },
        editAs: 'oneCell',
      });
      for (let i = 0; i < CHART_ROWS; i += 1) s3.addRow([]);
    } else {
      const noImg = s3.addRow(['（图表图片未导出，以上为文字解读）']);
      noImg.getCell(1).font = { size: 10, color: { argb: C.muted }, italic: true };
    }
    s3.addRow([]);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
