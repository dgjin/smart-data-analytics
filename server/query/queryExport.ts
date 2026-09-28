/**
 * v0.9.82 问数结果文档导出：PDF / Word / Markdown 三格式共用的载荷规范化、Markdown 构建与文件名。
 * - DLP 规范与 CSV 通道一致：导出人水印由路由层服务端注入（前端传入不可信），全程审计
 * - 文档定位为「分析摘要」：明细数据截断前 100 行 / 前 12 列（完整数据走带审批保护的 CSV 导出通道）
 * - 纯函数（normalize / buildQueryMarkdown / 文件名）便于单测；路由在 server/routes/export.ts
 */
import { isPngDataUri } from '../report/reportExport';

/** 明细展示上限（文档摘要定位；完整数据请用「导出 CSV」通道） */
export const QUERY_EXPORT_MAX_ROWS = 100;
export const QUERY_EXPORT_MAX_COLUMNS = 12;

export interface QueryExportKpi {
  label: string;
  value: string;
  /** 说明列（界面 subtext + 环比变化的文字化摘要） */
  note: string;
}

export interface QueryExportData {
  /** 提问原文（导出文档标题） */
  title: string;
  dataSourceName: string;
  dataSourceId: string;
  /** 数据来源标签：真实数据 / 演示数据（对齐消息卡片徽标语义，避免导出文档误导） */
  provenanceLabel: string;
  createdAt: string;
  /** DLP 水印：导出人（路由层服务端注入，防伪造） */
  exportedBy: string;
  sql: string;
  aiExplanation: string;
  kpiMetrics: QueryExportKpi[];
  keyInsights: string[];
  chartTitle: string;
  chartImageBase64?: string;
  /** 中文表头（与 rows 列序对齐） */
  columns: string[];
  rows: string[][];
  /** 查询结果总行数（rows 被截断时用于注记） */
  totalCount: number;
  truncated: boolean;
}

function clean(v: unknown, fallback = ''): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : fallback;
}

/** 校验并归一化前端提交的问数导出数据；缺少提问原文返回 null */
export function normalizeQueryExportData(raw: unknown): QueryExportData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== 'string' || !r.title.trim()) return null;

  const columns = Array.isArray(r.columns)
    ? (r.columns as unknown[]).slice(0, QUERY_EXPORT_MAX_COLUMNS).map((c) => clean(c).slice(0, 60))
    : [];
  let rows: string[][] = [];
  if (Array.isArray(r.rows) && columns.length > 0) {
    rows = (r.rows as unknown[])
      .slice(0, QUERY_EXPORT_MAX_ROWS)
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) =>
        columns.map((_, ci) => {
          const v = row[ci];
          if (v === null || v === undefined) return '';
          return (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 200);
        }),
      );
  }
  const totalCount =
    typeof r.totalCount === 'number' && Number.isFinite(r.totalCount) ? Math.max(0, Math.floor(r.totalCount)) : rows.length;

  return {
    title: r.title.trim().slice(0, 160),
    dataSourceName: clean(r.dataSourceName).slice(0, 80),
    dataSourceId: clean(r.dataSourceId).slice(0, 64),
    provenanceLabel: r.dataProvenance === 'live' ? '真实数据' : r.dataProvenance === 'simulated' ? '演示数据' : '',
    createdAt: clean(r.createdAt).slice(0, 40) || new Date().toLocaleString('zh-CN', { hour12: false }),
    exportedBy: clean(r.exportedBy).slice(0, 120),
    sql: clean(r.sql).slice(0, 4000),
    aiExplanation: clean(r.aiExplanation).slice(0, 3000),
    kpiMetrics: Array.isArray(r.kpiMetrics)
      ? (r.kpiMetrics as unknown[])
          .slice(0, 8)
          .filter((k): k is Record<string, unknown> => !!k && typeof k === 'object' && (typeof (k as Record<string, unknown>).label === 'string' || typeof (k as Record<string, unknown>).label === 'number'))
          .map((k) => ({
            label: clean(k.label).slice(0, 40),
            value: clean(k.value).slice(0, 60),
            note: clean(k.note).slice(0, 120),
          }))
      : [],
    keyInsights: Array.isArray(r.keyInsights)
      ? (r.keyInsights as unknown[])
          .filter((s): s is string => typeof s === 'string' && !!s.trim())
          .slice(0, 8)
          .map((s) => s.trim().slice(0, 600))
      : [],
    chartTitle: clean(r.chartTitle).slice(0, 80),
    chartImageBase64: isPngDataUri(r.chartImageBase64) ? r.chartImageBase64 : undefined,
    columns,
    rows,
    totalCount,
    truncated: totalCount > rows.length,
  };
}

/** Markdown 表格单元格转义（竖线转义、换行转 <br>） */
function mdCell(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** 构建问数结果 Markdown 文档（section 按内容存在与否动态出现） */
export function buildQueryMarkdown(data: QueryExportData): string {
  const lines: string[] = [`# ${data.title}`, ''];
  const meta = [
    data.dataSourceName && `数据源：${data.dataSourceName}`,
    data.provenanceLabel && `数据来源：${data.provenanceLabel}`,
    `导出时间：${data.createdAt}`,
    data.exportedBy && `导出人：${data.exportedBy}`,
  ].filter(Boolean);
  lines.push(`> ${meta.join(' · ')}`, '', '> 本文件由智能问数据分析系统生成，含访问水印，严禁外传', '');

  if (data.aiExplanation.trim()) {
    lines.push('## AI 解读', '', data.aiExplanation.trim(), '');
  }
  if (data.kpiMetrics.length > 0) {
    lines.push('## 核心指标', '', '| 指标 | 数值 | 说明 |', '| --- | --- | --- |');
    for (const k of data.kpiMetrics) {
      lines.push(`| ${mdCell(k.label)} | ${mdCell(k.value)} | ${mdCell(k.note || '—')} |`);
    }
    lines.push('');
  }
  if (data.keyInsights.length > 0) {
    lines.push('## AI 归因分析与决策提示', '');
    data.keyInsights.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }
  if (data.sql.trim()) {
    lines.push('## 生成的 SQL', '', '```sql', data.sql.trim(), '```', '');
  }
  if (data.chartImageBase64) {
    lines.push(`## 图表：${data.chartTitle || '可视化'}`, '');
    lines.push(`![${mdCell(data.chartTitle || '图表')}](${data.chartImageBase64})`, '');
  }
  if (data.columns.length > 0 && data.rows.length > 0) {
    const rowNote = data.truncated ? `（共 ${data.totalCount} 行，展示前 ${data.rows.length} 行）` : `（共 ${data.rows.length} 行）`;
    lines.push(`## 明细数据${rowNote}`, '');
    lines.push(`| ${data.columns.map(mdCell).join(' | ')} |`);
    lines.push(`| ${data.columns.map(() => '---').join(' | ')} |`);
    for (const r of data.rows) {
      lines.push(`| ${r.map(mdCell).join(' | ')} |`);
    }
    lines.push('');
  }
  lines.push('---', `> 导出水印：${data.exportedBy || '—'} · ${data.createdAt} · 智能问数据分析系统`, '');
  return lines.join('\n');
}

/** 从提问原文生成安全文件名（去非法字符，限 40 字） */
export function buildQueryExportFilename(title: string, ext: string): string {
  const safe = (title || '问数结果').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  const date = new Date().toISOString().slice(0, 10);
  return `${safe}_问数结果_${date}${ext}`;
}
