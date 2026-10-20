/**
 * v0.9.107 评价体系服务层：问数星级评价（query_ratings）与全站满意度（app_satisfaction）。
 * - 与 query_feedback（赞踩/点纠错）完全独立：不参与 few-shot 与统一记忆体，避免改变既有质量口径；
 * - 问数评价以 dedupe_key 幂等（同用户同数据源同问题重复提交为更新）；
 * - 全站满意度同用户 24h 内重复提交更新最近一条，防止刷量；
 * - 概览/趋势/标签/明细/CSV 均在此聚合，路由层只做参数与权限。
 */
import { createHash } from 'node:crypto';
import type mysql from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2';
import { getPool } from '../infra/db';

export type RatingSource = 'query' | 'app';
export const MAX_TAGS = 3;
export const MAX_TAG_LENGTH = 20;
export const MAX_COMMENT_LENGTH = 200;
const MAX_PAGE_SIZE = 5000;

export interface QueryRatingInput {
  userId: number;
  username: string;
  dataSourceId: string;
  question: string;
  executedSql: string;
  traceId: string;
  rating: number;
  tags: string[];
  comment: string;
}

export interface AppSatisfactionInput {
  userId: number;
  username: string;
  page: string;
  rating: number;
  tags: string[];
  comment: string;
}

export interface RatingItem {
  id: number;
  source: RatingSource;
  username: string;
  rating: number;
  tags: string[];
  comment: string;
  question: string;
  createdAt: string;
}

export interface RatingQuery {
  source?: 'all' | RatingSource;
  minRating?: number;
  maxRating?: number;
  days?: number;
  page?: number;
  pageSize?: number;
}

export interface RatingOverview {
  query: { count: number; avg: number; goodRate: number; lowCount: number };
  app: { count: number; avg: number; nps: number; lowCount: number };
  trend: Array<{ date: string; queryAvg: number | null; queryCount: number; appAvg: number | null; appCount: number }>;
  tags: { query: Array<{ tag: string; count: number }>; app: Array<{ tag: string; count: number }> };
}

interface CountRow extends mysql.RowDataPacket {
  cnt: number | string;
}

interface AggregateRow extends mysql.RowDataPacket {
  cnt: number | string;
  avg_rating: number | string | null;
  good: number | string | null;
  low: number | string | null;
  promoters: number | string | null;
  detractors: number | string | null;
}

interface TrendRow extends mysql.RowDataPacket {
  d: string;
  cnt: number | string;
  avg_rating: number | string | null;
}

interface TagsRow extends mysql.RowDataPacket {
  tags: string;
}

interface RatingRow extends mysql.RowDataPacket {
  source: string;
  id: number | string;
  username: string;
  rating: number | string;
  tags: string;
  comment: string;
  question: string;
  created_at: string;
}

interface IdRow extends mysql.RowDataPacket {
  id: number;
}

/** 评分范围校验：返回 1-5 或 null */
export function normalizeRating(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

/** 标签校验：最多 3 个、每个 ≤20 字、去重；null 表示格式非法 */
export function normalizeTags(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') return null;
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) return null;
    if (!tags.includes(tag)) tags.push(tag);
    if (tags.length > MAX_TAGS) return null;
  }
  return tags;
}

/** 评价文字校验：≤200 字；null 表示格式非法 */
export function normalizeComment(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const comment = value.trim();
  return comment.length > MAX_COMMENT_LENGTH ? null : comment;
}

/** 时间范围归一化：1-365 天，默认 30 天 */
export function normalizeDays(value: unknown, fallback = 30): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

export function parseTags(raw: string): string[] {
  return String(raw || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 问数评价幂等键：同用户 + 同数据源 + 同问题只保留一条（重复提交更新） */
export function queryRatingDedupeKey(userId: number, dataSourceId: string, question: string): string {
  return createHash('sha256').update(`${userId}|${dataSourceId}|${question}`).digest('hex');
}

export async function saveQueryRating(input: QueryRatingInput): Promise<void> {
  const dedupeKey = queryRatingDedupeKey(input.userId, input.dataSourceId, input.question);
  const tags = input.tags.join(',');
  await getPool().query<ResultSetHeader>(
    `INSERT INTO query_ratings
       (dedupe_key, user_id, username, data_source_id, question, executed_sql, trace_id, rating, tags, comment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       rating = ?, tags = ?, comment = ?, executed_sql = ?, trace_id = ?, updated_at = CURRENT_TIMESTAMP`,
    [
      dedupeKey,
      input.userId,
      input.username.slice(0, 50),
      input.dataSourceId.slice(0, 64),
      input.question.slice(0, 500),
      input.executedSql.slice(0, 2000),
      input.traceId.slice(0, 40),
      input.rating,
      tags.slice(0, 200),
      input.comment.slice(0, 500),
      input.rating,
      tags.slice(0, 200),
      input.comment.slice(0, 500),
      input.executedSql.slice(0, 2000),
      input.traceId.slice(0, 40),
    ]
  );
}

/** 全站满意度：同用户 24h 内更新最近一条，否则新增 */
export async function saveAppSatisfaction(input: AppSatisfactionInput): Promise<void> {
  const pool = getPool();
  const [rows] = await pool.query<IdRow[]>(
    'SELECT id FROM app_satisfaction WHERE user_id = ? AND created_at > NOW() - INTERVAL 24 HOUR ORDER BY id DESC LIMIT 1',
    [input.userId]
  );
  const tags = input.tags.join(',');
  if (rows[0]) {
    await pool.query<ResultSetHeader>(
      'UPDATE app_satisfaction SET rating = ?, tags = ?, comment = ?, page = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [input.rating, tags.slice(0, 200), input.comment.slice(0, 500), input.page.slice(0, 32), rows[0].id]
    );
    return;
  }
  await pool.query<ResultSetHeader>(
    'INSERT INTO app_satisfaction (user_id, username, page, rating, tags, comment) VALUES (?, ?, ?, ?, ?, ?)',
    [
      input.userId,
      input.username.slice(0, 50),
      input.page.slice(0, 32),
      input.rating,
      tags.slice(0, 200),
      input.comment.slice(0, 500),
    ]
  );
}

/** 当前用户最近一次全站满意度（Header 入口回显） */
export async function latestAppSatisfaction(
  userId: number
): Promise<{ rating: number; tags: string[]; comment: string; createdAt: string } | null> {
  const [rows] = await getPool().query<RatingRow[]>(
    `SELECT 'app' AS source, id, username, rating, tags, comment, '' AS question,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
     FROM app_satisfaction WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
    [userId]
  );
  const row = rows[0];
  if (!row) return null;
  return { rating: Number(row.rating), tags: parseTags(row.tags), comment: String(row.comment || ''), createdAt: String(row.created_at) };
}

function avgOf(row: { avg_rating?: number | string | null } | undefined): number {
  return Number(row?.avg_rating || 0);
}

function ratio(part: number, total: number): number {
  return total > 0 ? Number((part / total).toFixed(4)) : 0;
}

/** 生成近 N 天日期序列（YYYY-MM-DD，含今天） */
function recentDates(days: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(`${d.getFullYear()}-${month}-${day}`);
  }
  return out;
}

/** 标签计数：按逗号拆分后统计，取 top N */
export function countTags(rows: TagsRow[], limit = 10): Array<{ tag: string; count: number }> {
  const map = new Map<string, number>();
  for (const row of rows) {
    for (const tag of parseTags(row.tags)) {
      map.set(tag, (map.get(tag) || 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'))
    .slice(0, limit);
}

export async function ratingOverview(daysInput: unknown): Promise<RatingOverview> {
  const days = normalizeDays(daysInput, 30);
  const pool = getPool();
  const [
    [queryAggRows],
    [appAggRows],
    [queryTrendRows],
    [appTrendRows],
    [queryTagRows],
    [appTagRows],
  ] = await Promise.all([
    pool.query<AggregateRow[]>(
      `SELECT COUNT(*) AS cnt, COALESCE(AVG(rating), 0) AS avg_rating,
              COALESCE(SUM(rating >= 4), 0) AS good, COALESCE(SUM(rating <= 2), 0) AS low,
              0 AS promoters, 0 AS detractors
       FROM query_ratings WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
      [days]
    ),
    pool.query<AggregateRow[]>(
      `SELECT COUNT(*) AS cnt, COALESCE(AVG(rating), 0) AS avg_rating,
              0 AS good, COALESCE(SUM(rating <= 2), 0) AS low,
              COALESCE(SUM(rating = 5), 0) AS promoters, COALESCE(SUM(rating <= 3), 0) AS detractors
       FROM app_satisfaction WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
      [days]
    ),
    pool.query<TrendRow[]>(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(*) AS cnt, COALESCE(AVG(rating), 0) AS avg_rating
       FROM query_ratings WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY d ORDER BY d`,
      [days]
    ),
    pool.query<TrendRow[]>(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(*) AS cnt, COALESCE(AVG(rating), 0) AS avg_rating
       FROM app_satisfaction WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY d ORDER BY d`,
      [days]
    ),
    pool.query<TagsRow[]>(
      `SELECT tags FROM query_ratings WHERE tags <> '' AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY id DESC LIMIT 5000`,
      [days]
    ),
    pool.query<TagsRow[]>(
      `SELECT tags FROM app_satisfaction WHERE tags <> '' AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY id DESC LIMIT 5000`,
      [days]
    ),
  ]);

  const queryAgg = queryAggRows[0];
  const appAgg = appAggRows[0];
  const queryCount = Number(queryAgg?.cnt || 0);
  const appCount = Number(appAgg?.cnt || 0);
  const promoters = Number(appAgg?.promoters || 0);
  const detractors = Number(appAgg?.detractors || 0);

  const queryByDate = new Map(queryTrendRows.map((r) => [String(r.d), r]));
  const appByDate = new Map(appTrendRows.map((r) => [String(r.d), r]));
  const trend = recentDates(days).map((date) => {
    const q = queryByDate.get(date);
    const a = appByDate.get(date);
    return {
      date,
      queryAvg: q ? Number(avgOf(q).toFixed(2)) : null,
      queryCount: Number(q?.cnt || 0),
      appAvg: a ? Number(avgOf(a).toFixed(2)) : null,
      appCount: Number(a?.cnt || 0),
    };
  });

  return {
    query: {
      count: queryCount,
      avg: Number(avgOf(queryAgg).toFixed(2)),
      goodRate: ratio(Number(queryAgg?.good || 0), queryCount),
      lowCount: Number(queryAgg?.low || 0),
    },
    app: {
      count: appCount,
      avg: Number(avgOf(appAgg).toFixed(2)),
      nps: appCount > 0 ? Number((((promoters - detractors) / appCount) * 100).toFixed(1)) : 0,
      lowCount: Number(appAgg?.low || 0),
    },
    trend,
    tags: { query: countTags(queryTagRows), app: countTags(appTagRows) },
  };
}

interface WhereBuild {
  clause: string;
  params: unknown[];
}

function buildWhere(days: number, minRating?: number, maxRating?: number): WhereBuild {
  const cond: string[] = ['created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)'];
  const params: unknown[] = [days];
  if (minRating !== undefined) {
    cond.push('rating >= ?');
    params.push(minRating);
  }
  if (maxRating !== undefined) {
    cond.push('rating <= ?');
    params.push(maxRating);
  }
  return { clause: `WHERE ${cond.join(' AND ')}`, params };
}

const QUERY_SELECT = `SELECT 'query' AS source, id, username, rating, tags, comment, question,
       DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
  FROM query_ratings`;

const APP_SELECT = `SELECT 'app' AS source, id, username, rating, tags, comment, '' AS question,
       DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
  FROM app_satisfaction`;

export async function listRatings(input: RatingQuery): Promise<{ items: RatingItem[]; total: number; page: number; pageSize: number }> {
  const source = input.source === 'query' || input.source === 'app' ? input.source : 'all';
  const days = normalizeDays(input.days, 30);
  const page = Math.max(1, Math.floor(Number(input.page) || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(input.pageSize) || 20)));
  const where = buildWhere(days, input.minRating, input.maxRating);

  const parts: string[] = [];
  const params: unknown[] = [];
  if (source !== 'app') {
    parts.push(`${QUERY_SELECT} ${where.clause}`);
    params.push(...where.params);
  }
  if (source !== 'query') {
    parts.push(`${APP_SELECT} ${where.clause}`);
    params.push(...where.params);
  }
  const union = parts.join(' UNION ALL ');

  const [rows] = await getPool().query<RatingRow[]>(
    `${union} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  );

  const countParts: string[] = [];
  const countParams: unknown[] = [];
  if (source !== 'app') {
    countParts.push(`SELECT id FROM query_ratings ${where.clause}`);
    countParams.push(...where.params);
  }
  if (source !== 'query') {
    countParts.push(`SELECT id FROM app_satisfaction ${where.clause}`);
    countParams.push(...where.params);
  }
  const [countRows] = await getPool().query<CountRow[]>(
    `SELECT COUNT(*) AS cnt FROM (${countParts.join(' UNION ALL ')}) t`,
    countParams
  );

  return {
    items: rows.map((r) => ({
      id: Number(r.id),
      source: String(r.source) === 'app' ? 'app' : 'query',
      username: String(r.username || ''),
      rating: Number(r.rating),
      tags: parseTags(r.tags),
      comment: String(r.comment || ''),
      question: String(r.question || ''),
      createdAt: String(r.created_at || ''),
    })),
    total: Number(countRows[0]?.cnt || 0),
    page,
    pageSize,
  };
}

/** CSV 单元格转义（逗号/引号/换行统一加引号） */
function csvCell(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** 评价明细 CSV（UTF-8 BOM，Excel 直接打开不乱码） */
export function buildRatingsCsv(items: RatingItem[]): string {
  const header = ['来源', '用户', '评分', '标签', '评价内容', '关联问题', '时间'];
  const rows = items.map((item) => [
    item.source === 'query' ? '问数评价' : '全站满意度',
    item.username,
    String(item.rating),
    item.tags.join(' / '),
    item.comment,
    item.question,
    item.createdAt,
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export { MAX_PAGE_SIZE };
