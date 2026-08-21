/**
 * 对话历史服务端落库与管理 + 个人对话沉淀自学习。
 * - 每次问数的问题/SQL/结论摘要/状态落 conversation_history 表，
 *   前端历史面板支持搜索/重问/删除/导出，跨设备共享（不再仅存浏览器本地缓存）。
 * - 自学习：同用户同数据源的真实成功问答对作为个人 few-shot 检索源（loadConversationFewShot），
 *   与团队样例库（sql_examples）互补——样例库来自点赞沉淀，对话沉淀覆盖用户个人高频口径。
 */
import { getPool } from './db';
import { extractTableRefs, stripCommentsAndStrings } from './sqlExecutor';
import { bigramOverlap, normalizeSql } from './queryFeedback';
import { approxTokens } from './promptBudget';

/** 对话状态：SUCCESS/FALLBACK 常规问答；REFUSED 拒答（问题无关/超出能力，同样不参与 few-shot 检索） */
export type ConversationStatus = 'SUCCESS' | 'FALLBACK' | 'REFUSED';

export interface ConversationRecord {
  id: number;
  question: string;
  sql: string;
  answerSummary: string;
  status: ConversationStatus;
  provenance: string;
  rowCount: number;
  durationMs: number;
  createdAt: string;
}

export interface RecordConversationInput {
  userId: number;
  username: string;
  dataSourceId: string;
  question: string;
  executedSql?: string;
  answerSummary?: string;
  status: ConversationStatus;
  provenance: 'live' | 'simulated';
  rowCount?: number;
  durationMs?: number;
}

/** 问数完成后落一条对话记录；调用方 fire-and-forget，失败不阻断主链路 */
export async function recordConversation(input: RecordConversationInput): Promise<void> {
  await getPool().query(
    `INSERT INTO conversation_history
       (user_id, username, data_source_id, question, executed_sql, answer_summary, status, provenance, row_count, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userId,
      input.username.slice(0, 50),
      input.dataSourceId.slice(0, 64),
      input.question.slice(0, 500),
      normalizeSql(input.executedSql || '').slice(0, 2000),
      String(input.answerSummary || '').slice(0, 800),
      input.status,
      input.provenance.slice(0, 20),
      Number.isFinite(input.rowCount) ? Number(input.rowCount) : 0,
      Number.isFinite(input.durationMs) ? Number(input.durationMs) : 0,
    ]
  );
  // P1-2 表治理：抽样 10% 触发窗口清理，避免每写一删的写放大；CONVERSATION_RETENTION=0 可关闭
  if (Math.random() < 0.1) {
    await pruneConversationHistory(input.userId, input.dataSourceId).catch(() => {});
  }
}

/**
 * P1-2 历史表保留窗口：每用户每数据源仅保留最近 CONVERSATION_RETENTION 条（默认 500，0=不限制）。
 * 个人 few-shot 检索只读近 100 条，窗口 500 足以覆盖检索源；旧记录在窗口外自动清理。
 */
export async function pruneConversationHistory(userId: number, dataSourceId: string): Promise<number> {
  const keep = Number(process.env.CONVERSATION_RETENTION) || 500;
  if (keep <= 0) return 0;
  const [cntRows] = await getPool().query(
    'SELECT COUNT(*) AS cnt FROM conversation_history WHERE user_id = ? AND data_source_id = ?',
    [userId, dataSourceId]
  );
  const excess = Number((cntRows as any[])[0]?.cnt || 0) - keep;
  if (excess <= 0) return 0;
  const result: any = await getPool().query(
    'DELETE FROM conversation_history WHERE user_id = ? AND data_source_id = ? ORDER BY id ASC LIMIT ?',
    [userId, dataSourceId, excess]
  );
  return Number(result[0]?.affectedRows || 0);
}

function toRecord(r: any): ConversationRecord {
  return {
    id: Number(r.id),
    question: String(r.question),
    sql: String(r.executed_sql || ''),
    answerSummary: String(r.answer_summary || ''),
    status: (String(r.status) as ConversationStatus) || 'SUCCESS',
    provenance: String(r.provenance || ''),
    rowCount: Number(r.row_count || 0),
    durationMs: Number(r.duration_ms || 0),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

/** 检索本人某数据源的对话历史（最新在前），支持关键词模糊匹配问题与结论摘要 */
export async function searchConversations(
  userId: number,
  dataSourceId: string,
  keyword = '',
  limit = 50
): Promise<ConversationRecord[]> {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const kw = keyword.trim();
  const [rows] = kw
    ? await getPool().query(
        `SELECT * FROM conversation_history
         WHERE user_id = ? AND data_source_id = ? AND (question LIKE ? OR answer_summary LIKE ?)
         ORDER BY id DESC LIMIT ${safeLimit}`,
        [userId, dataSourceId, `%${kw}%`, `%${kw}%`]
      )
    : await getPool().query(
        `SELECT * FROM conversation_history
         WHERE user_id = ? AND data_source_id = ?
         ORDER BY id DESC LIMIT ${safeLimit}`,
        [userId, dataSourceId]
      );
  return (rows as any[]).map(toRecord);
}

/** 删除本人的一条对话历史（越权删除他人记录返回 false） */
export async function deleteConversation(id: number, userId: number): Promise<boolean> {
  const result: any = await getPool().query(
    'DELETE FROM conversation_history WHERE id = ? AND user_id = ?',
    [id, userId]
  );
  return Number(result[0]?.affectedRows) > 0;
}

export interface ConversationFewShotPair {
  question: string;
  sql: string;
}

const CONVERSATION_FEWSHOT_BUDGET = 500;

/**
 * 个人对话沉淀 few-shot：本人同数据源真实执行成功的问答对（近 100 条内），
 * 打分与样例库同口径（问题 bigram 重合 + SQL 引用表与圈定表重合 × 3），
 * 相同 SQL 只留最高分，token 预算内贪心取 top 2——个人高频口径自动反哺后续问数。
 */
export async function loadConversationFewShot(
  userId: number,
  dataSourceId: string,
  question: string,
  relevantTables: string[] = []
): Promise<ConversationFewShotPair[]> {
  const [rows] = await getPool().query(
    `SELECT question, executed_sql FROM conversation_history
     WHERE user_id = ? AND data_source_id = ? AND status = 'SUCCESS'
       AND provenance = 'live' AND executed_sql <> ''
     ORDER BY id DESC LIMIT 100`,
    [userId, dataSourceId]
  );
  const relevantSet = new Set(relevantTables.map((t) => String(t).toLowerCase()));

  const scored = (rows as any[])
    .map((r) => {
      const rawSql = String(r.executed_sql);
      const sqlTables = extractTableRefs(stripCommentsAndStrings(rawSql));
      const tableOverlap = relevantSet.size > 0 ? sqlTables.filter((t) => relevantSet.has(t)).length : 0;
      return {
        question: String(r.question),
        sql: normalizeSql(rawSql),
        score: bigramOverlap(question, String(r.question)) + tableOverlap * 3,
      };
    })
    .filter((r) => r.score > 0);

  const bySql = new Map<string, (typeof scored)[number]>();
  for (const s of scored) {
    const prev = bySql.get(s.sql);
    if (!prev || s.score > prev.score) bySql.set(s.sql, s);
  }
  const ranked = [...bySql.values()].sort((a, b) => b.score - a.score);

  const picked: ConversationFewShotPair[] = [];
  let used = 0;
  for (const ex of ranked) {
    if (picked.length >= 2) break;
    const cost = approxTokens(ex.question) + approxTokens(ex.sql);
    if (used + cost > CONVERSATION_FEWSHOT_BUDGET) break;
    used += cost;
    picked.push({ question: ex.question, sql: ex.sql });
  }
  return picked;
}
