/**
 * v0.9.93 自动运维事件流（自动运维智能体接入 P1-6）：
 * 把系统内已有业务语义的异常信号统一归集为 ops_events 行——审计异常终态（ERROR）/
 * 异步任务失败 / 巡检执行失败 / 知识库漂移 / 进程级致命异常（CRITICAL）。
 * 自动运维智能体经 GET /api/ops/events 拉取 → POST ack → 执行动作 → POST resolve
 * 形成「发现-处置-留痕」闭环；运维动作同时写 query_audit_log 审计。
 *
 * 设计约束：
 * - 写入 fail-open：不阻塞主流程（与审计同策略）；DB 未就绪/写入失败仅告警。
 * - 15 分钟窗口去重：同 event_key 且仍有 NEW 事件 → 仅累加 dedup_count/last_seen_at，
 *   防事件风暴淹没智能体（去重合并是有意的，明细频次由 dedup_count 反映）。
 * - traceId 缺省自动取 asyncContext 的 requestId/taskId，打通「事件 ↔ 日志」下钻。
 */
import type mysql from 'mysql2/promise';
import { getPool } from './db';
import { logger } from './logger';
import { getLogContext } from './asyncContext';
import { observeOpsEvent } from './monitoring';

export type OpsEventSeverity = 'CRITICAL' | 'ERROR' | 'WARN' | 'INFO';
export type OpsEventSource = 'audit' | 'task' | 'patrol' | 'drift' | 'fatal';
export type OpsEventStatus = 'NEW' | 'ACK' | 'RESOLVED';

export interface OpsEventInput {
  source: OpsEventSource;
  /** 语义分类（NL2SQL/TASK/PATROL/DRIFT/PROCESS 等，低基数枚举，供聚合） */
  category: string;
  severity: OpsEventSeverity;
  message: string;
  entityType?: string;
  entityId?: string;
  detail?: Record<string, unknown>;
  traceId?: string;
}

/** 去重窗口（分钟）：同键且仍有 NEW 事件在此窗口内仅累加计数 */
export const OPS_EVENT_DEDUP_WINDOW_MINUTES = 15;

/** 事件去重键：身份由「来源+分类+实体」决定（不含消息文本，避免含变量消息碎裂成多条） */
export function buildEventKey(e: Pick<OpsEventInput, 'source' | 'category' | 'entityType' | 'entityId'>): string {
  return [e.source, e.category, e.entityType || '', e.entityId || ''].join(':').slice(0, 160);
}

/** detail 安全序列化：循环引用兜底、超长降级为预览（MySQL JSON 列） */
function safeDetail(detail: Record<string, unknown>): Record<string, unknown> {
  let json: string;
  try {
    json = JSON.stringify(detail);
  } catch {
    return { unserializable: String(detail).slice(0, 500) };
  }
  if (json.length > 4000) return { truncated: true, preview: json.slice(0, 4000) };
  // 二次 parse 防止 JSON.stringify 产出非法 JSON（如 BigInt 已抛错走了上面分支）
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { unserializable: json.slice(0, 500) };
  }
}

/**
 * 记录运维事件（fire-and-forget；fail-open，绝不抛错阻塞调用方）。
 * 语义：15 分钟内同键且 NEW 的事件合并（dedup_count+1），否则新插入。
 */
export function recordOpsEvent(input: OpsEventInput): void {
  try {
    const ctx = getLogContext();
    const traceId = (input.traceId || ctx?.requestId || ctx?.taskId || '').slice(0, 64);
    const eventKey = buildEventKey(input);
    const message = (input.message || '').slice(0, 500);
    const detailJson = input.detail ? JSON.stringify(safeDetail(input.detail)) : null;
    observeOpsEvent(input.severity, input.category); // Prometheus 旁路（fail-open）
    const pool = getPool();
    void pool
      .query<mysql.RowDataPacket[]>(
        `SELECT id FROM ops_events
         WHERE event_key = ? AND status = 'NEW' AND last_seen_at > NOW() - INTERVAL ${OPS_EVENT_DEDUP_WINDOW_MINUTES} MINUTE
         LIMIT 1`,
        [eventKey]
      )
      .then(async ([rows]) => {
        const existing = rows[0];
        if (existing) {
          await pool.query(
            'UPDATE ops_events SET dedup_count = dedup_count + 1, last_seen_at = NOW() WHERE id = ?',
            [existing.id]
          );
          return;
        }
        await pool.query(
          `INSERT INTO ops_events
             (event_key, severity, source, category, entity_type, entity_id, message, detail, trace_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            eventKey,
            input.severity,
            input.source,
            input.category.slice(0, 24),
            (input.entityType || '').slice(0, 32),
            (input.entityId || '').slice(0, 128),
            message,
            detailJson,
            traceId,
          ]
        );
      })
      .catch((err) => {
        logger.warn('[OpsEvents] 事件写入失败（fail-open）:', err?.message || err);
      });
  } catch (err) {
    // 同步段异常（如 DB 未初始化 getPool 抛错）同样不得反噬主流程
    logger.warn('[OpsEvents] 事件构造异常（fail-open）:', err instanceof Error ? err.message : String(err));
  }
}
