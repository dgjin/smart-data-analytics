/**
 * v0.9.107 访问计数器（隐私最小化）：
 * - 只做聚合计数，不落访问明细、IP、User-Agent 或停留时长；
 * - 会话以 SHA-256(sessionId) 存储，7 天自动清理；累计/今日访问来自日聚合表；
 * - 写库失败仅告警（计数器不应影响页面与问数主流程），查询失败正常抛出由路由兜底。
 */
import { createHash } from 'node:crypto';
import type mysql from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2';
import { getPool } from '../infra/db';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';

/** 会话记录保留天数（仅用于在线判断与访问去重） */
export const ACCESS_SESSION_TTL_DAYS = 7;
/** 在线窗口：最近 5 分钟有心跳的会话 */
export const ONLINE_WINDOW_MINUTES = 5;
/** 模块标识：小写字母开头，允许连字符，长度 2-32（如 query-reports） */
const MODULE_PATTERN = /^[a-z][a-z-]{1,31}$/;

export interface PublicAccessStats {
  totalVisits: number;
  todayVisits: number;
  online: number;
  updatedAt: string;
}

export interface ModuleAccessStat {
  module: string;
  hits: number;
  /** 占所选时间范围全部模块访问次数的百分比（保留 1 位小数） */
  share: number;
}

export interface AccessStats extends PublicAccessStats {
  days: number;
  modules: ModuleAccessStat[];
}

interface PublicStatsRow extends mysql.RowDataPacket {
  total_visits: number | string | null;
  today_visits: number | string | null;
  online: number | string | null;
}

interface ModuleStatRow extends mysql.RowDataPacket {
  module: string;
  hits: number | string | null;
}

/** sessionId 只以摘要形式入库，避免原始标识可被反查 */
export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

/** 前端 crypto.randomUUID() 产物为 36 位；兼容旧浏览器降级生成的 16-64 位标识 */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

/** 模块 key 归一化：非法值返回 null（直接忽略，不影响访问计数） */
export function normalizeModule(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const module = value.trim().toLowerCase();
  return MODULE_PATTERN.test(module) ? module : null;
}

/** 时间范围归一化：1-365 天，默认 30 天 */
export function normalizeDays(value: unknown, fallback = 30): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(365, Math.max(1, Math.floor(n)));
}

/**
 * 记录一次访问：新会话才递增当日访问数；模块热度按上报次数累加（前端 60s 节流）。
 * 写库失败只告警，不阻塞调用方。
 */
export async function recordVisit(sessionId: string, module: string | null, userId?: number): Promise<void> {
  const hash = hashSessionId(sessionId);
  const authed = userId ? 1 : 0;
  try {
    const pool = getPool();
    const [insert] = await pool.query<ResultSetHeader>(
      'INSERT IGNORE INTO access_sessions (session_hash, is_authed) VALUES (?, ?)',
      [hash, authed]
    );
    if (Number(insert.affectedRows) > 0) {
      await pool.query(
        `INSERT INTO access_daily (stat_date, visits, authed_visits) VALUES (CURDATE(), 1, ?)
         ON DUPLICATE KEY UPDATE visits = visits + 1, authed_visits = authed_visits + ?`,
        [authed, authed]
      );
    } else {
      await pool.query(
        'UPDATE access_sessions SET last_seen = CURRENT_TIMESTAMP, is_authed = GREATEST(is_authed, ?) WHERE session_hash = ?',
        [authed, hash]
      );
    }
    if (module) {
      await pool.query(
        `INSERT INTO access_module_daily (stat_date, module, hits) VALUES (CURDATE(), ?, 1)
         ON DUPLICATE KEY UPDATE hits = hits + 1`,
        [module]
      );
    }
  } catch (err) {
    logger.warn('[Access] 访问计数写入失败（忽略）:', getErrorMessage(err));
  }
}

/** 在线心跳：仅刷新 last_seen；会话不存在时静默补建（不重复计访问） */
export async function touchSession(sessionId: string, userId?: number): Promise<void> {
  const hash = hashSessionId(sessionId);
  const authed = userId ? 1 : 0;
  try {
    const pool = getPool();
    const [result] = await pool.query<ResultSetHeader>(
      'UPDATE access_sessions SET last_seen = CURRENT_TIMESTAMP, is_authed = GREATEST(is_authed, ?) WHERE session_hash = ?',
      [authed, hash]
    );
    if (Number(result.affectedRows) === 0) {
      await pool.query('INSERT IGNORE INTO access_sessions (session_hash, is_authed) VALUES (?, ?)', [hash, authed]);
    }
  } catch (err) {
    logger.warn('[Access] 在线心跳写入失败（忽略）:', getErrorMessage(err));
  }
}

/** 对外计数器：累计访问 / 今日访问 / 当前在线 */
export async function publicStats(): Promise<PublicAccessStats> {
  const [rows] = await getPool().query<PublicStatsRow[]>(
    `SELECT
       (SELECT COALESCE(SUM(visits), 0) FROM access_daily) AS total_visits,
       (SELECT COALESCE(visits, 0) FROM access_daily WHERE stat_date = CURDATE()) AS today_visits,
       (SELECT COUNT(*) FROM access_sessions WHERE last_seen > NOW() - INTERVAL ? MINUTE) AS online`,
    [ONLINE_WINDOW_MINUTES]
  );
  const row = rows[0];
  return {
    totalVisits: Number(row?.total_visits || 0),
    todayVisits: Number(row?.today_visits || 0),
    online: Number(row?.online || 0),
    updatedAt: new Date().toISOString(),
  };
}

/** 管理端：计数器 + 近 N 天模块热度排行（按访问次数降序） */
export async function accessStats(daysInput: unknown): Promise<AccessStats> {
  const days = normalizeDays(daysInput, 30);
  const [base, [moduleRows]] = await Promise.all([
    publicStats(),
    getPool().query<ModuleStatRow[]>(
      `SELECT module, SUM(hits) AS hits
       FROM access_module_daily
       WHERE stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY module
       ORDER BY hits DESC`,
      [days]
    ),
  ]);
  const raw = (moduleRows || []).map((r) => ({ module: String(r.module), hits: Number(r.hits || 0) }));
  const total = raw.reduce((acc, r) => acc + r.hits, 0);
  return {
    ...base,
    days,
    modules: raw.map((r) => ({
      ...r,
      share: total > 0 ? Number(((r.hits / total) * 100).toFixed(1)) : 0,
    })),
  };
}

/**
 * 每小时清理过期会话（幂等，多实例重复执行无副作用）。
 * 日聚合表不清理：累计访问只有计数，不含任何个人信息。
 */
export function startAccessSweeper(): void {
  if (sweeperStarted) return;
  sweeperStarted = true;
  const sweep = () => {
    getPool()
      .query('DELETE FROM access_sessions WHERE last_seen < NOW() - INTERVAL ? DAY', [ACCESS_SESSION_TTL_DAYS])
      .catch((err) => logger.warn('[Access] 过期会话清理失败（忽略）:', getErrorMessage(err)));
  };
  sweep();
  const timer = setInterval(sweep, 60 * 60 * 1000);
  // 不因定时器阻止进程退出（测试/CLI 场景）
  timer.unref?.();
}

let sweeperStarted = false;
