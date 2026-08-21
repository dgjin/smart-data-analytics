/**
 * L6 审计层：智能问数全链路审计日志。
 * 成功、降级、错误与被拒绝（输入/权限/频率/开关）的请求全部落账，
 * 写入失败仅告警不阻塞主流程（审计不应成为可用性瓶颈）。
 */
import { getPool } from './db';

export type AuditStatus =
  | 'SUCCESS'
  | 'CACHE'
  | 'FALLBACK'
  | 'ERROR'
  | 'CLARIFY'
  | 'REFUSED'
  | 'DENIED_INPUT'
  | 'DENIED_AUTH'
  | 'DENIED_RATE'
  | 'DENIED_SWITCH';

export interface AuditEntry {
  userId: number;
  username: string;
  endpoint: 'query' | 'report' | 'query_report' | 'report_template';
  dataSourceId?: string;
  question?: string;
  status: AuditStatus;
  detail?: string;
  /** 真实执行的 SQL（P0 双阶段模式）；-1 行数表示未执行 */
  executedSql?: string;
  rowCount?: number;
  durationMs?: number;
}

export function writeAudit(entry: AuditEntry): void {
  getPool()
    .query(
      `INSERT INTO query_audit_log
        (user_id, username, endpoint, data_source_id, question, status, detail, executed_sql, row_count, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.userId,
        entry.username,
        entry.endpoint,
        (entry.dataSourceId || '').slice(0, 64),
        (entry.question || '').slice(0, 500),
        entry.status,
        (entry.detail || '').slice(0, 255),
        (entry.executedSql || '').slice(0, 2000),
        entry.rowCount === undefined ? -1 : Math.round(entry.rowCount),
        Math.max(0, Math.round(entry.durationMs || 0)),
      ]
    )
    .catch((err) => {
      console.warn('[Audit] 审计日志写入失败:', err?.message || err);
    });
}
