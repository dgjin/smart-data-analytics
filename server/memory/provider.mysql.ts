/**
 * MemoryProvider 的 MySQL 实现（一期）。
 *
 * 只读写三张新表：memory_items / memory_candidates / memory_usage。
 * 现有权威资产（指标/铁律/知识库/样例库/对话历史）不经过本文件，由各通道 Adapter 只读复用。
 */
import type mysql from 'mysql2/promise';
import { getPool } from '../infra/db';
import { initialConfidenceForApproval, normalizeErrorType } from './governance';
import type {
  MemoryCandidate,
  MemoryErrorType,
  MemoryItem,
  MemoryScope,
  MemoryStatus,
  RememberCorrectionInput,
  UsageRow,
} from './types';

type Row = mysql.RowDataPacket;

const iso = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

function rowToItem(r: Row): MemoryItem {
  let embedding: number[] | null;
  try {
    const parsed = r.embedding_json ? JSON.parse(String(r.embedding_json)) : null;
    embedding = Array.isArray(parsed) && parsed.every((n: unknown) => typeof n === 'number') ? parsed : null;
  } catch {
    embedding = null;
  }
  return {
    id: Number(r.id),
    kind: String(r.kind || 'CORRECTION') as MemoryItem['kind'],
    dataSourceId: String(r.data_source_id || ''),
    userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
    question: String(r.question || ''),
    content: String(r.content || ''),
    errorType: normalizeErrorType(r.error_type),
    expectedSql: String(r.expected_sql || ''),
    embedding,
    confidence: Number(r.confidence || 0),
    hits: Number(r.hits || 0),
    lastUsedAt: iso(r.last_used_at),
    status: String(r.status || 'ACTIVE') as MemoryStatus,
    source: String(r.source || 'USER') as MemoryItem['source'],
    createdBy: String(r.created_by || ''),
    createdAt: iso(r.created_at),
  };
}

function rowToCandidate(r: Row): MemoryCandidate {
  let payload: Record<string, unknown>;
  try {
    payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload || {};
  } catch {
    payload = {};
  }
  return {
    id: Number(r.id),
    kind: String(r.kind || 'CORRECTION') as MemoryCandidate['kind'],
    dataSourceId: String(r.data_source_id || ''),
    userId: r.user_id === null || r.user_id === undefined ? null : Number(r.user_id),
    question: String(r.question || ''),
    wrongSql: String(r.wrong_sql || ''),
    errorType: normalizeErrorType(r.error_type),
    payload,
    status: String(r.status || 'PENDING') as MemoryCandidate['status'],
    reviewedBy: String(r.reviewed_by || ''),
    reviewedAt: iso(r.reviewed_at),
    memoryId: r.memory_id === null || r.memory_id === undefined ? null : Number(r.memory_id),
    createdAt: iso(r.created_at),
  };
}

/** 纠错记忆召回候选：数据源级共享 + 本人个人记忆（源级在前由融合分排序保证） */
export async function listCorrectionItems(scope: MemoryScope, limit = 200): Promise<MemoryItem[]> {
  const [rows] = await getPool().query<Row[]>(
    `SELECT * FROM memory_items
     WHERE data_source_id = ? AND kind = 'CORRECTION' AND status = 'ACTIVE'
       AND (user_id IS NULL OR user_id = ?)
     ORDER BY COALESCE(last_used_at, created_at) DESC, confidence DESC
     LIMIT ?`,
    [scope.dataSourceId.slice(0, 64), scope.userId, Math.min(500, Math.max(1, Math.floor(limit)))]
  );
  return rows.map(rowToItem);
}

/** 点踩纠正 → 候选（同数据源同问题同错误类型 PENDING 幂等合并） */
export async function insertCorrectionCandidate(input: RememberCorrectionInput): Promise<number> {
  const pool = getPool();
  const ds = input.dataSourceId.slice(0, 64);
  const question = input.question.slice(0, 500);
  const errorType: MemoryErrorType = normalizeErrorType(input.errorType);
  const payload = JSON.stringify({
    note: String(input.note || '').slice(0, 400),
    expectedSql: String(input.expectedSql || '').slice(0, 2000),
    username: input.username.slice(0, 50),
    traceId: String(input.traceId || '').slice(0, 40),
  });
  const [dup] = await pool.query<Row[]>(
    `SELECT id FROM memory_candidates
     WHERE data_source_id = ? AND question = ? AND error_type = ? AND status = 'PENDING'
     ORDER BY id DESC LIMIT 1`,
    [ds, question, errorType]
  );
  if (dup.length > 0) {
    const id = Number(dup[0].id);
    await pool.query('UPDATE memory_candidates SET payload = ? WHERE id = ?', [payload, id]);
    return id;
  }
  const [res] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO memory_candidates (kind, data_source_id, user_id, question, wrong_sql, error_type, payload)
     VALUES ('CORRECTION', ?, ?, ?, ?, ?, ?)`,
    [ds, input.userId, question, input.wrongSql.slice(0, 2000), errorType, payload]
  );
  return Number(res.insertId);
}

export interface CandidateQuery {
  dataSourceId?: string;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MERGED';
  errorType?: MemoryErrorType;
  limit?: number;
  offset?: number;
}

export async function listCandidates(q: CandidateQuery = {}): Promise<{ total: number; items: MemoryCandidate[] }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.dataSourceId) {
    where.push('data_source_id = ?');
    args.push(q.dataSourceId.slice(0, 64));
  }
  if (q.status) {
    where.push('status = ?');
    args.push(q.status);
  }
  if (q.errorType) {
    where.push('error_type = ?');
    args.push(normalizeErrorType(q.errorType));
  }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(100, Math.max(1, Math.floor(q.limit || 20)));
  const offset = Math.max(0, Math.floor(q.offset || 0));
  const pool = getPool();
  const [cnt] = await pool.query<Row[]>(`SELECT COUNT(*) AS c FROM memory_candidates ${cond}`, args);
  const [rows] = await pool.query<Row[]>(
    `SELECT * FROM memory_candidates ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset]
  );
  return { total: Number(cnt[0]?.c || 0), items: rows.map(rowToCandidate) };
}

export async function getCandidate(id: number): Promise<MemoryCandidate | null> {
  const [rows] = await getPool().query<Row[]>('SELECT * FROM memory_candidates WHERE id = ? LIMIT 1', [id]);
  return rows.length ? rowToCandidate(rows[0]) : null;
}

export interface ApprovePatch {
  content?: string;
  expectedSql?: string;
  confidence?: number;
  /** 问题向量 JSON（由调用方 embed，失败传空串落 NULL） */
  embeddingJson?: string;
}

/** 审核通过：候选 → memory_items（事务内状态机校验，防重复生成） */
export async function approveCandidate(
  id: number,
  reviewer: string,
  patch: ApprovePatch = {}
): Promise<{ ok: true; memoryId: number } | { ok: false; error: string }> {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<Row[]>('SELECT * FROM memory_candidates WHERE id = ? FOR UPDATE', [id]);
    if (!rows.length) {
      await conn.rollback();
      return { ok: false, error: '候选不存在' };
    }
    const cand = rowToCandidate(rows[0]);
    if (cand.status !== 'PENDING') {
      await conn.rollback();
      return { ok: false, error: '候选已处理，不能重复审核' };
    }
    const note = String(cand.payload.note || '').trim();
    const expectedSql = String(patch.expectedSql ?? cand.payload.expectedSql ?? '').trim();
    const content =
      String(patch.content || '').trim() ||
      `问题：${cand.question} → 纠正：${note || expectedSql || '按管理员确认的正确口径执行'}`;
    const confidence =
      typeof patch.confidence === 'number' && Number.isFinite(patch.confidence)
        ? Math.min(1, Math.max(0, patch.confidence))
        : initialConfidenceForApproval({ expectedSql, approvedByAdmin: true });
    const [ins] = await conn.query<mysql.ResultSetHeader>(
      `INSERT INTO memory_items
         (kind, data_source_id, user_id, question, content, error_type, expected_sql, embedding_json, source, confidence, created_by)
       VALUES ('CORRECTION', ?, ?, ?, ?, ?, ?, ?, 'ADMIN', ?, ?)`,
      [
        cand.dataSourceId,
        cand.userId,
        cand.question,
        content.slice(0, 4000),
        cand.errorType,
        expectedSql.slice(0, 2000),
        patch.embeddingJson || null,
        confidence,
        reviewer.slice(0, 50),
      ]
    );
    const memoryId = Number(ins.insertId);
    await conn.query(
      "UPDATE memory_candidates SET status = 'APPROVED', reviewed_by = ?, reviewed_at = NOW(), memory_id = ? WHERE id = ?",
      [reviewer.slice(0, 50), memoryId, id]
    );
    await conn.commit();
    return { ok: true, memoryId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export async function rejectCandidate(id: number, reviewer: string): Promise<boolean> {
  const [res] = await getPool().query<mysql.ResultSetHeader>(
    "UPDATE memory_candidates SET status = 'REJECTED', reviewed_by = ?, reviewed_at = NOW() WHERE id = ? AND status = 'PENDING'",
    [reviewer.slice(0, 50), id]
  );
  return Number(res.affectedRows || 0) > 0;
}

export interface ItemQuery {
  dataSourceId?: string;
  status?: MemoryStatus;
  q?: string;
  limit?: number;
  offset?: number;
}

export async function listItems(query: ItemQuery = {}): Promise<{ total: number; items: MemoryItem[] }> {
  const where: string[] = ["kind = 'CORRECTION'"];
  const args: unknown[] = [];
  if (query.dataSourceId) {
    where.push('data_source_id = ?');
    args.push(query.dataSourceId.slice(0, 64));
  }
  if (query.status) {
    where.push('status = ?');
    args.push(query.status);
  }
  if (query.q && query.q.trim()) {
    where.push('(question LIKE ? OR content LIKE ?)');
    const like = `%${query.q.trim().slice(0, 100)}%`;
    args.push(like, like);
  }
  const cond = `WHERE ${where.join(' AND ')}`;
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit || 20)));
  const offset = Math.max(0, Math.floor(query.offset || 0));
  const pool = getPool();
  const [cnt] = await pool.query<Row[]>(`SELECT COUNT(*) AS c FROM memory_items ${cond}`, args);
  const [rows] = await pool.query<Row[]>(
    `SELECT * FROM memory_items ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...args, limit, offset]
  );
  return { total: Number(cnt[0]?.c || 0), items: rows.map(rowToItem) };
}

export interface UpdateItemPatch {
  content?: string;
  expectedSql?: string;
  confidence?: number;
  status?: MemoryStatus;
}

export async function updateItem(id: number, patch: UpdateItemPatch): Promise<boolean> {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof patch.content === 'string') {
    sets.push('content = ?');
    args.push(patch.content.slice(0, 4000));
  }
  if (typeof patch.expectedSql === 'string') {
    sets.push('expected_sql = ?');
    args.push(patch.expectedSql.slice(0, 2000));
  }
  if (typeof patch.confidence === 'number' && Number.isFinite(patch.confidence)) {
    sets.push('confidence = ?');
    args.push(Math.min(1, Math.max(0, patch.confidence)));
  }
  if (patch.status) {
    sets.push('status = ?');
    args.push(patch.status);
  }
  if (!sets.length) return false;
  const [res] = await getPool().query<mysql.ResultSetHeader>(
    `UPDATE memory_items SET ${sets.join(', ')} WHERE id = ? AND kind = 'CORRECTION'`,
    [...args, id]
  );
  return Number(res.affectedRows || 0) > 0;
}

/** 引用留痕：批量写入（调用方 fire-and-forget） */
export async function touchUsage(rows: UsageRow[]): Promise<void> {
  if (!rows.length) return;
  const values = rows.map((r) => [
    r.traceId.slice(0, 40),
    r.userId,
    r.dataSourceId.slice(0, 64),
    r.memoryRef.slice(0, 80),
    r.channel.slice(0, 24),
    r.rankNo,
    Math.round(r.score * 10000) / 10000,
    r.tokens,
    r.injected ? 1 : 0,
  ]);
  await getPool().query(
    `INSERT INTO memory_usage (trace_id, user_id, data_source_id, memory_ref, channel, rank_no, score, tokens, injected)
     VALUES ?`,
    [values]
  );
}

/** 被注入的记忆：hits+1、last_used_at 刷新（仅 mem: 前缀） */
export async function bumpCorrectionUsage(ids: number[]): Promise<void> {
  const clean = ids.filter((n) => Number.isFinite(n) && n > 0);
  if (!clean.length) return;
  await getPool().query(
    `UPDATE memory_items SET hits = hits + 1, last_used_at = NOW() WHERE kind = 'CORRECTION' AND id IN (?)`,
    [clean]
  );
}

export async function updateConfidence(id: number, delta: number): Promise<void> {
  await getPool().query(
    `UPDATE memory_items
     SET confidence = LEAST(1, GREATEST(0, confidence + ?))
     WHERE id = ? AND kind = 'CORRECTION'`,
    [delta, id]
  );
}

/** 归档：长期未命中且低置信的条目（不物理删除，可后台恢复） */
export async function archiveStaleMemories(days: number): Promise<number> {
  const [res] = await getPool().query<mysql.ResultSetHeader>(
    `UPDATE memory_items
     SET status = 'ARCHIVED'
     WHERE kind = 'CORRECTION' AND status = 'ACTIVE' AND confidence < 0.3
       AND COALESCE(last_used_at, created_at) < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [Math.max(1, Math.floor(days))]
  );
  return Number(res.affectedRows || 0);
}

export interface MemoryStats {
  itemsActive: number;
  itemsArchived: number;
  candidatesPending: number;
  injected7d: number;
  correctionInjected7d: number;
  topCorrections: { id: number; question: string; hits: number; confidence: number }[];
}

export async function memoryStats(dataSourceId?: string): Promise<MemoryStats> {
  const ds = (dataSourceId || '').slice(0, 64);
  const dsCond = ds ? ' AND data_source_id = ?' : '';
  const dsArgs = ds ? [ds] : [];
  const pool = getPool();
  const [items] = await pool.query<Row[]>(
    `SELECT status, COUNT(*) AS c FROM memory_items WHERE kind = 'CORRECTION'${dsCond} GROUP BY status`,
    dsArgs
  );
  const [cand] = await pool.query<Row[]>(
    `SELECT COUNT(*) AS c FROM memory_candidates WHERE status = 'PENDING'${dsCond}`,
    dsArgs
  );
  const [usage] = await pool.query<Row[]>(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN channel = 'CORRECTION' AND injected = 1 THEN 1 ELSE 0 END) AS corr
     FROM memory_usage
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)${dsCond}`,
    dsArgs
  );
  const [top] = await pool.query<Row[]>(
    `SELECT id, question, hits, confidence FROM memory_items
     WHERE kind = 'CORRECTION' AND status = 'ACTIVE'${dsCond}
     ORDER BY hits DESC, confidence DESC LIMIT 5`,
    dsArgs
  );
  const byStatus = new Map(items.map((r) => [String(r.status), Number(r.c || 0)]));
  return {
    itemsActive: byStatus.get('ACTIVE') || 0,
    itemsArchived: byStatus.get('ARCHIVED') || 0,
    candidatesPending: Number(cand[0]?.c || 0),
    injected7d: Number(usage[0]?.total || 0),
    correctionInjected7d: Number(usage[0]?.corr || 0),
    topCorrections: top.map((r) => ({
      id: Number(r.id),
      question: String(r.question || ''),
      hits: Number(r.hits || 0),
      confidence: Number(r.confidence || 0),
    })),
  };
}

/** 某次问数的记忆引用明细（推导回放用） */
export async function usageByTrace(traceId: string): Promise<UsageRow[]> {
  const [rows] = await getPool().query<Row[]>(
    `SELECT * FROM memory_usage WHERE trace_id = ? ORDER BY id ASC LIMIT 100`,
    [traceId.slice(0, 40)]
  );
  return rows.map((r) => ({
    traceId: String(r.trace_id || ''),
    userId: Number(r.user_id || 0),
    dataSourceId: String(r.data_source_id || ''),
    memoryRef: String(r.memory_ref || ''),
    channel: String(r.channel || ''),
    rankNo: Number(r.rank_no || 0),
    score: Number(r.score || 0),
    tokens: Number(r.tokens || 0),
    injected: Number(r.injected || 0),
  }));
}
