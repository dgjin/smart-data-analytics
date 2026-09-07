/**
 * liveQuery 阶段一 LLM 响应解析层：SQL 计划 JSON、歧义澄清、拒答、自省探查的解析与格式化。
 * 全部纯函数（safeParseJson 兜底非法载荷），解析失败返回 null 由编排层走重试/澄清链路。
 */
import { safeParseJson } from '../../src/utils/queryResultNormalizer';
import type { SchemaTable } from './schemaTypes';
import { VALID_STAGE1_CHARTS } from './liveQueryUtils';

/** 问题存在歧义时返回澄清请求：由前端与用户交互确认后再执行 */
export interface ClarificationOption {
  label: string;
  /** 按该理解改写后的完整问题（用户点选后直接重新提交） */
  query: string;
}

export interface Clarification {
  question: string;
  options: ClarificationOption[];
}

export interface Stage1Plan {
  sql: string;
  title: string;
  chartType: string;
  xAxisKey: string;
  yAxisKeys: string[];
  yAxisNames?: Record<string, string>;
  columnNames?: Record<string, string>;
  thoughtProcess: string[];
}

export function parseStage1(text: string): Stage1Plan | null {
  const parsed = safeParseJson(text);
  if (!parsed) return null;
  if (typeof parsed.sql !== 'string' || !parsed.sql.trim()) return null;
  return {
    sql: parsed.sql,
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : '查询结果',
    chartType: (VALID_STAGE1_CHARTS as readonly string[]).includes(parsed.chartType) ? parsed.chartType : 'bar',
    xAxisKey: typeof parsed.xAxisKey === 'string' ? parsed.xAxisKey : '',
    yAxisKeys: Array.isArray(parsed.yAxisKeys)
      ? parsed.yAxisKeys.filter((k: unknown): k is string => typeof k === 'string')
      : [],
    yAxisNames: parsed.yAxisNames && typeof parsed.yAxisNames === 'object' ? parsed.yAxisNames : undefined,
    columnNames: parsed.columnNames && typeof parsed.columnNames === 'object' ? parsed.columnNames : undefined,
    thoughtProcess: Array.isArray(parsed.thoughtProcess)
      ? parsed.thoughtProcess.filter((s: unknown): s is string => typeof s === 'string').slice(0, 6)
      : [],
  };
}

/** 解析阶段一的澄清请求输出；非法/不完整（无有效选项）返回 null，由 SQL 契约兜底 */
export function parseClarification(text: string): Clarification | null {
  const parsed = safeParseJson(text);
  if (!parsed || parsed.needClarification !== true) return null;
  const c = parsed.clarification;
  if (!c || typeof c !== 'object') return null;
  if (typeof c.question !== 'string' || !c.question.trim()) return null;
  if (!Array.isArray(c.options)) return null;
  const rawOptions: unknown[] = c.options;
  const options: ClarificationOption[] = rawOptions
    .filter((o: unknown): o is { label: string; query: string } => {
      if (!o || typeof o !== 'object') return false;
      const r = o as Record<string, unknown>;
      return typeof r.label === 'string' && typeof r.query === 'string' && r.query.trim().length > 0;
    })
    .slice(0, 4)
    .map((o) => ({ label: o.label.trim().slice(0, 60), query: o.query.trim().slice(0, 500) }));
  if (options.length === 0) return null;
  return { question: c.question.trim().slice(0, 300), options };
}

/** 解析阶段一的拒答请求（问题与数据源无关/超出能力）；非法返回 null，由 SQL 契约兜底 */
export function parseRefusal(text: string): { reason: string } | null {
  const parsed = safeParseJson(text);
  if (!parsed || parsed.refuse !== true) return null;
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 300) : '';
  if (!reason) return null;
  return { reason };
}

/**
 * 拒答理由规范化：统一话术「抱歉，我是数据分析助手，仅协助处理数据分析相关工作，无法处理XXXX」。
 * 小模型可能未遵模板（照抄旧模板句/XXXX 占位未填/理由过短），此处兜底改写并拼上数据源覆盖表清单。
 */
export function enrichRefusalReason(reason: string, schema: SchemaTable[]): string {
  // XXXX 占位未替换 → 降级为通用措辞
  const cleaned = reason.replace(/x{2,}/gi, '该请求').trim();
  const generic = cleaned.length < 30
    || /与(当前)?数据源无关，或数据源中缺少支撑该问题的数据/.test(cleaned);
  if (!generic) return cleaned;
  const tables = (schema || [])
    .map((t) => (t && typeof t.name === 'string' ? t.name.trim() : ''))
    .filter(Boolean);
  const scope = tables.length > 0
    ? `当前数据源仅覆盖：${tables.slice(0, 8).join('、')}${tables.length > 8 ? ` 等 ${tables.length} 张表` : ''}。`
    : '';
  // 已是模板句式则保留；否则按统一话术改写（过短理由用「该请求」占位）
  const what = cleaned.length < 15 ? '该请求' : cleaned.replace(/[。.]+$/, '');
  const core = /抱歉，我是数据分析助手/.test(cleaned)
    ? cleaned.replace(/[。.]+$/, '')
    : `抱歉，我是数据分析助手，仅协助处理数据分析相关工作，无法处理${what}`;
  return `${core}。${scope}`.slice(0, 400);
}

/** 解析阶段一的自省请求（Vanna intermediate_sql 借鉴）；非法返回 null，由 SQL 契约兜底 */
export function parseIntrospection(text: string): { sql: string; note: string } | null {
  const parsed = safeParseJson(text);
  if (!parsed || parsed.needIntrospection !== true) return null;
  const sql = typeof parsed.intermediateSql === 'string' ? parsed.intermediateSql.trim() : '';
  if (!sql || !/^select\b/i.test(sql) || sql.length > 500) return null;
  const note = typeof parsed.note === 'string' ? parsed.note.trim().slice(0, 100) : '';
  return { sql, note };
}

/** 自省结果回喂格式：最多 30 行真实取值，JSON 紧凑呈现 */
export function formatIntrospectionRows(rows: Record<string, any>[]): string {
  return JSON.stringify(rows.slice(0, 30));
}
