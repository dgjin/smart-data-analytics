/**
 * M1 推导过程留痕：问数全链路每一步记录到 query_trace 表，
 * 支持事后回放（每个环节的输入摘要/输出摘要/SQL/行数/耗时均可查看）。
 * 记录为旁路写入：失败不影响问数主链路（fire-and-forget）。
 */
import type { RowDataPacket } from 'mysql2';
import { getPool } from './db';

export type TraceStepType =
  | 'understanding'
  | 'linking'
  | 'knowledge'
  | 'metrics'
  | 'introspection'
  | 'plan'
  | 'intermediate'
  | 'sql_gen'
  | 'execution'
  | 'analysis'
  | 'report';

export interface TraceStep {
  stepType: TraceStepType;
  title: string;
  /** 输入摘要（问题/上下文要点），截断后存储 */
  inputSummary?: string;
  /** 输出摘要（结论/命中内容要点），截断后存储 */
  outputSummary?: string;
  sqlText?: string;
  rowCount?: number;
  durationMs?: number;
  status?: 'ok' | 'fail';
}

export interface TraceMeta {
  userId: number;
  username: string;
  dataSourceId: string;
  question: string;
}

export function newTraceId(): string {
  return `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clip(text: string | undefined, max: number): string {
  if (typeof text !== 'string') return '';
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 旁路写入一步推导记录；调用方不必 await，失败仅打日志不阻断主链路 */
export function recordTraceStep(traceId: string, meta: TraceMeta, step: TraceStep): Promise<void> {
  let pool;
  try {
    pool = getPool();
  } catch {
    return Promise.resolve(); // DB 未初始化（如纯单测环境）静默跳过
  }
  return pool
    .query(
      `INSERT INTO query_trace
        (trace_id, user_id, username, data_source_id, question, step_type, title, input_summary, output_summary, sql_text, row_count, duration_ms, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        traceId,
        meta.userId,
        meta.username,
        meta.dataSourceId,
        clip(meta.question, 500),
        step.stepType,
        clip(step.title, 100),
        clip(step.inputSummary, 1000),
        clip(step.outputSummary, 2000),
        clip(step.sqlText, 2000),
        typeof step.rowCount === 'number' ? step.rowCount : -1,
        typeof step.durationMs === 'number' ? Math.round(step.durationMs) : 0,
        step.status === 'fail' ? 'fail' : 'ok',
      ]
    )
    .then(() => undefined)
    .catch((err: any) => {
      console.warn('[Trace] record failed:', String(err?.message || err).slice(0, 120));
    });
}

export interface TraceStepRow extends TraceStep {
  stepIndex: number;
  createdAt: string;
}

/** 读取一次问数的完整推导链（按步骤顺序） */
export async function getTraceSteps(traceId: string): Promise<{ steps: TraceStepRow[]; ownerUserId: number | null }> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT step_type, title, input_summary, output_summary, sql_text, row_count, duration_ms, status, user_id, created_at
     FROM query_trace WHERE trace_id = ? ORDER BY id ASC LIMIT 50`,
    [traceId]
  );
  if (rows.length === 0) return { steps: [], ownerUserId: null };
  const steps: TraceStepRow[] = rows.map((r, i) => ({
    stepIndex: i + 1,
    stepType: String(r.step_type) as TraceStepType,
    title: String(r.title || ''),
    inputSummary: String(r.input_summary || ''),
    outputSummary: String(r.output_summary || ''),
    sqlText: String(r.sql_text || ''),
    rowCount: Number(r.row_count),
    durationMs: Number(r.duration_ms),
    status: r.status === 'fail' ? 'fail' : 'ok',
    createdAt: String(r.created_at || ''),
  }));
  return { steps, ownerUserId: Number(rows[0].user_id) };
}
