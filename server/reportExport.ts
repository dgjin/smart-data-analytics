/**
 * M4 报告导出：服务端组装 PPTX（pptxgenjs）。
 * 页面结构：封面 → 高管摘要 → KPI 指标 → 每图一页（base64 PNG + 解读）→ 结论与建议。
 * 纯构建函数 buildReportPptx 可单测；路由在 server.ts（POST /api/report/export）。
 */
import PptxGenJS from 'pptxgenjs';

export interface ExportKpi {
  label: string;
  value: string;
  change?: string;
  status?: 'good' | 'bad' | 'neutral';
  anomalyNote?: string;
}

export interface ExportInsight {
  title: string;
  type?: 'positive' | 'warning' | 'info' | 'critical';
  content: string;
  actionItem?: string;
}

export interface ExportChart {
  title: string;
  commentary?: string;
  /** 前端 ECharts getDataURL() 导出的 base64 PNG（可带 data:image/png;base64, 前缀） */
  imageBase64?: string;
}

export interface ReportExportData {
  title: string;
  summary?: string;
  createdAt?: string;
  templateType?: string;
  kpiList?: ExportKpi[];
  insights?: ExportInsight[];
  charts?: ExportChart[];
}

const C = {
  navy: '0F172A',
  slate: '334155',
  text: '1E293B',
  muted: '64748B',
  indigo: '4F46E5',
  cyan: '0891B2',
  good: '059669',
  bad: 'DC2626',
  amber: 'D97706',
  divider: 'E2E8F0',
};

const INSIGHT_TAG: Record<string, { label: string; color: string }> = {
  positive: { label: '利好', color: C.good },
  warning: { label: '预警', color: C.amber },
  critical: { label: '风险', color: C.bad },
  info: { label: '洞察', color: C.cyan },
};

function clean(v: unknown, fallback = ''): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : fallback;
}

/** 校验并归一化前端提交的导出数据；非法结构返回 null */
export function normalizeExportData(raw: any): ReportExportData | null {
  if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string' || !raw.title.trim()) return null;
  const data: ReportExportData = {
    title: raw.title.trim().slice(0, 120),
    summary: clean(raw.summary).slice(0, 2000),
    createdAt: clean(raw.createdAt).slice(0, 40) || new Date().toISOString().split('T')[0],
    templateType: clean(raw.templateType).slice(0, 60),
    kpiList: Array.isArray(raw.kpiList)
      ? raw.kpiList.slice(0, 12).filter((k: any) => k && typeof k.label === 'string').map((k: any) => ({
          label: clean(k.label).slice(0, 40),
          value: clean(k.value).slice(0, 40),
          change: clean(k.change).slice(0, 40),
          status: k.status === 'good' || k.status === 'bad' ? k.status : 'neutral',
          anomalyNote: clean(k.anomalyNote).slice(0, 100),
        }))
      : [],
    insights: Array.isArray(raw.insights)
      ? raw.insights.slice(0, 10).filter((i: any) => i && typeof i.title === 'string').map((i: any) => ({
          title: clean(i.title).slice(0, 80),
          type: ['positive', 'warning', 'info', 'critical'].includes(i.type) ? i.type : 'info',
          content: clean(i.content).slice(0, 500),
          actionItem: clean(i.actionItem).slice(0, 300),
        }))
      : [],
    charts: Array.isArray(raw.charts)
      ? raw.charts.slice(0, 10).filter((c: any) => c && typeof c.title === 'string').map((c: any) => ({
          title: clean(c.title).slice(0, 80),
          commentary: clean(c.commentary).slice(0, 600),
          imageBase64: typeof c.imageBase64 === 'string' && /^data:image\/png;base64,/.test(c.imageBase64)
            ? c.imageBase64
            : undefined,
        }))
      : [],
  };
  return data;
}

function addPageFooter(slide: PptxGenJS.Slide, pageNo: number, total: number) {
  slide.addText(`智能问数据分析系统 · AI 决策简报`, { x: 0.5, y: 7.08, w: 6, h: 0.3, fontSize: 9, color: C.muted });
  slide.addText(`${pageNo} / ${total}`, { x: 8.9, y: 7.08, w: 0.9, h: 0.3, fontSize: 9, color: C.muted, align: 'right' });
}

/** 组装 PPTX 并返回 Buffer（16:9） */
export async function buildReportPptx(data: ReportExportData): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.title = data.title;

  const kpis = data.kpiList || [];
  const insights = data.insights || [];
  const charts = data.charts || [];
  const total = 3 + charts.length + (insights.length > 0 ? 1 : 0);
  let pageNo = 0;

  // 1. 封面
  const cover = pptx.addSlide();
  cover.background = { color: C.navy };
  cover.addShape('rect', { x: 0, y: 5.9, w: 13.33, h: 0.06, fill: { color: C.indigo } });
  cover.addText('AI 高管决策简报', { x: 0.8, y: 1.6, w: 11.7, h: 0.5, fontSize: 16, color: '818CF8', bold: true, charSpacing: 4 });
  cover.addText(data.title, { x: 0.8, y: 2.3, w: 11.7, h: 1.8, fontSize: 34, color: 'FFFFFF', bold: true, valign: 'top' });
  if (data.templateType) {
    cover.addText(`报告模板：${data.templateType}`, { x: 0.8, y: 4.4, w: 11.7, h: 0.4, fontSize: 13, color: 'CBD5E1' });
  }
  cover.addText(`生成日期：${data.createdAt || ''}`, { x: 0.8, y: 4.85, w: 11.7, h: 0.4, fontSize: 13, color: 'CBD5E1' });
  cover.addText('智能问数据分析系统 · 由 AI 大模型基于真实数据源自动生成', { x: 0.8, y: 6.2, w: 11.7, h: 0.4, fontSize: 11, color: '64748B' });

  // 2. 高管摘要
  const summary = pptx.addSlide();
  pageNo += 1;
  summary.addText('高管摘要', { x: 0.5, y: 0.35, w: 8, h: 0.6, fontSize: 24, color: C.text, bold: true });
  summary.addShape('rect', { x: 0.55, y: 0.98, w: 1.2, h: 0.05, fill: { color: C.indigo } });
  summary.addText(data.summary || '本报告由 AI 基于数据源自动生成，供管理层快速掌握经营全貌。', {
    x: 0.5, y: 1.3, w: 12.3, h: 5.4, fontSize: 15, color: C.text, lineSpacing: 26, valign: 'top',
  });
  addPageFooter(summary, pageNo, total);

  // 3. KPI 指标页
  const kpiSlide = pptx.addSlide();
  pageNo += 1;
  kpiSlide.addText('核心 KPI 指标', { x: 0.5, y: 0.35, w: 8, h: 0.6, fontSize: 24, color: C.text, bold: true });
  kpiSlide.addShape('rect', { x: 0.55, y: 0.98, w: 1.2, h: 0.05, fill: { color: C.indigo } });
  if (kpis.length === 0) {
    kpiSlide.addText('本报告未包含 KPI 指标。', { x: 0.5, y: 1.6, w: 12, h: 1, fontSize: 14, color: C.muted });
  } else {
    const cols = Math.min(3, kpis.length);
    const cardW = 3.9, cardH = 1.75, gap = 0.25;
    kpis.slice(0, 9).forEach((k, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const x = 0.5 + col * (cardW + gap), y = 1.4 + row * (cardH + gap);
      const statusColor = k.status === 'good' ? C.good : k.status === 'bad' ? C.bad : C.slate;
      kpiSlide.addShape('roundRect', { x, y, w: cardW, h: cardH, rectRadius: 0.08, fill: { color: 'F8FAFC' }, line: { color: C.divider, width: 1 } });
      kpiSlide.addText(k.label, { x: x + 0.2, y: y + 0.12, w: cardW - 0.4, h: 0.35, fontSize: 12, color: C.muted });
      kpiSlide.addText(k.value || '—', { x: x + 0.2, y: y + 0.45, w: cardW - 0.4, h: 0.7, fontSize: 26, color: C.text, bold: true });
      const changeParts: { text: string; options: any }[] = [];
      if (k.change) changeParts.push({ text: k.change, options: { fontSize: 11, color: statusColor, bold: true } });
      if (k.anomalyNote) changeParts.push({ text: `  ⚠ ${k.anomalyNote}`, options: { fontSize: 10, color: C.amber } });
      if (changeParts.length > 0) {
        kpiSlide.addText(changeParts, { x: x + 0.2, y: y + 1.2, w: cardW - 0.4, h: 0.4 });
      }
    });
  }
  addPageFooter(kpiSlide, pageNo, total);

  // 4. 每图一页（无图则纯文字解读兜底）
  for (const chart of charts) {
    const s = pptx.addSlide();
    pageNo += 1;
    s.addText(chart.title, { x: 0.5, y: 0.35, w: 12.3, h: 0.6, fontSize: 22, color: C.text, bold: true });
    s.addShape('rect', { x: 0.55, y: 0.98, w: 1.2, h: 0.05, fill: { color: C.indigo } });
    if (chart.imageBase64) {
      s.addImage({ data: chart.imageBase64, x: 0.6, y: 1.3, w: 12.1, h: 4.4, sizing: { type: 'contain', w: 12.1, h: 4.4 } });
    } else {
      s.addShape('roundRect', { x: 0.6, y: 1.3, w: 12.1, h: 4.4, rectRadius: 0.1, fill: { color: 'F1F5F9' }, line: { color: C.divider, width: 1 } });
      s.addText('（图表图片未导出，以下为文字解读）', { x: 0.6, y: 1.5, w: 12.1, h: 0.4, fontSize: 12, color: C.muted, align: 'center' });
    }
    if (chart.commentary) {
      s.addText(chart.commentary, { x: 0.6, y: 5.85, w: 12.1, h: 1.1, fontSize: 13, color: C.text, valign: 'top' });
    }
    addPageFooter(s, pageNo, total);
  }

  // 5. 结论与建议（无洞察则跳过）
  if (insights.length > 0) {
    const s = pptx.addSlide();
    pageNo += 1;
    s.addText('结论与建议', { x: 0.5, y: 0.35, w: 8, h: 0.6, fontSize: 24, color: C.text, bold: true });
    s.addShape('rect', { x: 0.55, y: 0.98, w: 1.2, h: 0.05, fill: { color: C.indigo } });
    const rowH = Math.min(1.1, 5.4 / insights.length);
    insights.forEach((ins, i) => {
      const tag = INSIGHT_TAG[ins.type || 'info'] || INSIGHT_TAG.info;
      const y = 1.3 + i * rowH;
      s.addText(tag.label, { x: 0.5, y, w: 0.7, h: 0.35, fontSize: 10, color: 'FFFFFF', bold: true, fill: { color: tag.color }, align: 'center', valign: 'middle' });
      s.addText(ins.title, { x: 1.35, y: y - 0.02, w: 11.3, h: 0.35, fontSize: 13, color: C.text, bold: true });
      const body: { text: string; options: any }[] = [{ text: ins.content, options: { fontSize: 11, color: C.muted } }];
      if (ins.actionItem) body.push({ text: `  建议：${ins.actionItem}`, options: { fontSize: 11, color: C.indigo, bold: true } });
      s.addText(body, { x: 1.35, y: y + 0.32, w: 11.3, h: Math.max(0.3, rowH - 0.4), valign: 'top' });
    });
    addPageFooter(s, pageNo, total);
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return out as Buffer;
}

/** 从报告标题生成安全文件名（.pptx） */
export function buildExportFilename(title: string, createdAt?: string): string {
  const safe = (title || '分析报告').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  const date = (createdAt || '').replace(/[^\d-]/g, '').slice(0, 10);
  return `${safe}_分析简报${date ? `_${date}` : ''}.pptx`;
}
