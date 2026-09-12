/**
 * P0-1 异常巡检订阅：数据源级巡检计划 = 既有报表异常检测引擎（scanReportForAnomalies）
 * + MySQL 巡检计划/运行历史表 + 内置低频调度器，不引入外部调度组件。
 *
 * 机制：每个计划绑定一个数据源，到期后扫描该数据源「最近一份真实数据（live）决策报表」，
 * 复用与报表同源的 Z-Score/阈值异常规则，把命中项写入巡检运行历史，供前端巡检中心展示。
 * 调度：到期计划原子领取（UPDATE ... WHERE next_run_at <= NOW() 抢占），多实例不重复执行；
 * 单实例内以内存集合防手动/定时并发重入。
 * 崩溃恢复：next_run_at 基于数据库时间推进，实例重启后按当前时钟自然续跑，无状态丢失。
 */
import { randomUUID } from 'node:crypto';
import type mysql from 'mysql2/promise';
import { getPool } from './infra/db';
import { logger } from './infra/logger';
import { scanReportForAnomalies } from '../src/utils/anomalyDetector';
import type { AnomalyItem, SavedReport } from '../src/types/analytics';

export type PatrolStatus = 'ACTIVE' | 'PAUSED';
/** 单次巡检终态：ANOMALY=发现异常 / CLEAN=无异常 / NO_DATA=无可扫描报表 / ERROR=执行失败 */
export type PatrolRunStatus = 'ANOMALY' | 'CLEAN' | 'NO_DATA' | 'ERROR';

/** 巡检计划（API 出参与行投影共用） */
export interface PatrolPlan {
  patrolId: string;
  userId: number;
  username: string;
  dataSourceId: string;
  name: string;
  intervalMinutes: number;
  status: PatrolStatus;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: PatrolRunStatus | '';
  lastAnomalyCount: number;
  createdAt: string | null;
}

/** 巡检运行记录（含命中的异常明细，最多 Top 10） */
export interface PatrolRun {
  id: number;
  patrolId: string;
  runAt: string | null;
  status: PatrolRunStatus;
  reportId: string;
  reportTitle: string;
  anomalyCount: number;
  highCount: number;
  anomalies: AnomalyItem[];
  error: string;
}

interface PatrolRow extends mysql.RowDataPacket {
  patrol_id: string;
  user_id: number;
  username: string;
  data_source_id: string;
  name: string;
  interval_minutes: number;
  status: PatrolStatus;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_run_status: string;
  last_anomaly_count: number;
  created_at: Date | null;
}

/** 巡检频率边界（分钟）：下限防高频轰炸、上限 30 天 */
export const PATROL_MIN_INTERVAL_MINUTES = 15;
export const PATROL_MAX_INTERVAL_MINUTES = 43_200;
/** 单条运行记录保留的异常明细上限（完整明细在报表详情页可查） */
const MAX_STORED_ANOMALIES = 10;

function ts(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export function toPatrolPlan(row: PatrolRow): PatrolPlan {
  return {
    patrolId: String(row.patrol_id),
    userId: Number(row.user_id),
    username: String(row.username || ''),
    dataSourceId: String(row.data_source_id || ''),
    name: String(row.name || ''),
    intervalMinutes: Number(row.interval_minutes || 0),
    status: row.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
    nextRunAt: ts(row.next_run_at),
    lastRunAt: ts(row.last_run_at),
    lastRunStatus: (row.last_run_status || '') as PatrolPlan['lastRunStatus'],
    lastAnomalyCount: Number(row.last_anomaly_count || 0),
    createdAt: ts(row.created_at),
  };
}

/** 建表（幂等；由 server 启动时在 initSchema 后调用） */
export async function ensurePatrolTables(pool?: mysql.Pool): Promise<void> {
  const p = pool ?? getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS anomaly_patrols (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      patrol_id VARCHAR(64) NOT NULL UNIQUE COMMENT '巡检计划唯一标识（patrol-{uuid}）',
      user_id INT NOT NULL,
      username VARCHAR(50) NOT NULL DEFAULT '',
      data_source_id VARCHAR(64) NOT NULL,
      name VARCHAR(100) NOT NULL DEFAULT '',
      interval_minutes INT NOT NULL DEFAULT 1440 COMMENT '巡检间隔（分钟）',
      status ENUM('ACTIVE','PAUSED') NOT NULL DEFAULT 'ACTIVE',
      next_run_at TIMESTAMP NULL DEFAULT NULL COMMENT '下次到期时间（NULL=立即到期）',
      last_run_at TIMESTAMP NULL DEFAULT NULL,
      last_run_status VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'ANOMALY/CLEAN/NO_DATA/ERROR',
      last_anomaly_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ap_due (status, next_run_at),
      INDEX idx_ap_ds (data_source_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS anomaly_patrol_runs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      patrol_id VARCHAR(64) NOT NULL,
      run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      status VARCHAR(20) NOT NULL,
      report_id VARCHAR(64) NOT NULL DEFAULT '' COMMENT '被扫描报表 ID',
      report_title VARCHAR(500) NOT NULL DEFAULT '',
      anomaly_count INT NOT NULL DEFAULT 0,
      high_count INT NOT NULL DEFAULT 0,
      anomalies_json MEDIUMTEXT NULL COMMENT '异常明细 Top10（AnomalyItem JSON）',
      error VARCHAR(500) NOT NULL DEFAULT '',
      INDEX idx_apr_patrol (patrol_id, run_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// ---------------- CRUD ----------------

export function normalizePatrolInterval(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < PATROL_MIN_INTERVAL_MINUTES || n > PATROL_MAX_INTERVAL_MINUTES) return null;
  return n;
}

export async function listPatrols(dataSourceId?: string, pool?: mysql.Pool): Promise<PatrolPlan[]> {
  const p = pool ?? getPool();
  const hasFilter = typeof dataSourceId === 'string' && dataSourceId.length > 0;
  const [rows] = hasFilter
    ? await p.query<PatrolRow[]>('SELECT * FROM anomaly_patrols WHERE data_source_id = ? ORDER BY id DESC LIMIT 200', [dataSourceId])
    : await p.query<PatrolRow[]>('SELECT * FROM anomaly_patrols ORDER BY id DESC LIMIT 200');
  return rows.map(toPatrolPlan);
}

export async function findPatrol(patrolId: string, pool?: mysql.Pool): Promise<PatrolRow | null> {
  const p = pool ?? getPool();
  const [rows] = await p.query<PatrolRow[]>('SELECT * FROM anomaly_patrols WHERE patrol_id = ? LIMIT 1', [patrolId]);
  return rows[0] || null;
}

export async function createPatrol(opts: {
  name: string;
  dataSourceId: string;
  intervalMinutes: number;
  user: { id: number; username: string };
  pool?: mysql.Pool;
}): Promise<PatrolPlan> {
  const p = opts.pool ?? getPool();
  const patrolId = `patrol-${randomUUID()}`;
  await p.query(
    `INSERT INTO anomaly_patrols (patrol_id, user_id, username, data_source_id, name, interval_minutes, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW() + INTERVAL ? MINUTE)`,
    [patrolId, opts.user.id, opts.user.username, opts.dataSourceId, opts.name, opts.intervalMinutes, opts.intervalMinutes],
  );
  const row = await findPatrol(patrolId, p);
  return toPatrolPlan(row as PatrolRow);
}

export async function updatePatrol(
  patrolId: string,
  patch: { name?: string; intervalMinutes?: number; status?: PatrolStatus },
  pool?: mysql.Pool,
): Promise<boolean> {
  const p = pool ?? getPool();
  const sets: string[] = [];
  const args: unknown[] = [];
  if (typeof patch.name === 'string') {
    sets.push('name = ?');
    args.push(patch.name);
  }
  if (patch.intervalMinutes !== undefined) {
    sets.push('interval_minutes = ?');
    args.push(patch.intervalMinutes);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    args.push(patch.status);
    // 恢复启用时重置到期时间（避免停机期间积压的“立即到期”连环补跑）
    if (patch.status === 'ACTIVE') {
      sets.push('next_run_at = NOW() + INTERVAL interval_minutes MINUTE');
    }
  }
  if (sets.length === 0) return false;
  args.push(patrolId);
  const [r] = await p.query<mysql.ResultSetHeader>(`UPDATE anomaly_patrols SET ${sets.join(', ')} WHERE patrol_id = ?`, args);
  return r.affectedRows > 0;
}

export async function deletePatrol(patrolId: string, pool?: mysql.Pool): Promise<boolean> {
  const p = pool ?? getPool();
  const [r] = await p.query<mysql.ResultSetHeader>('DELETE FROM anomaly_patrols WHERE patrol_id = ?', [patrolId]);
  await p.query('DELETE FROM anomaly_patrol_runs WHERE patrol_id = ?', [patrolId]);
  return r.affectedRows > 0;
}

export async function listPatrolRuns(patrolId: string, limit = 20, pool?: mysql.Pool): Promise<PatrolRun[]> {
  const p = pool ?? getPool();
  const [rows] = await p.query<mysql.RowDataPacket[]>(
    'SELECT * FROM anomaly_patrol_runs WHERE patrol_id = ? ORDER BY id DESC LIMIT ?',
    [patrolId, Math.min(100, Math.max(1, limit))],
  );
  return rows.map((row) => {
    let anomalies: AnomalyItem[] = [];
    if (row.anomalies_json) {
      try {
        const parsed = JSON.parse(row.anomalies_json);
        if (Array.isArray(parsed)) anomalies = parsed;
      } catch {
        anomalies = [];
      }
    }
    return {
      id: Number(row.id),
      patrolId: String(row.patrol_id),
      runAt: ts(row.run_at),
      status: (row.status || 'ERROR') as PatrolRunStatus,
      reportId: String(row.report_id || ''),
      reportTitle: String(row.report_title || ''),
      anomalyCount: Number(row.anomaly_count || 0),
      highCount: Number(row.high_count || 0),
      anomalies,
      error: String(row.error || ''),
    };
  });
}

// ---------------- 扫描执行 ----------------

/** 取该数据源最近一份 live 决策报表（排除 simulated，避免演示数据触发误报） */
async function loadLatestLiveReport(dataSourceId: string, pool?: mysql.Pool): Promise<{ reportId: string; report: SavedReport } | null> {
  const p = pool ?? getPool();
  const [rows] = await p.query<mysql.RowDataPacket[]>(
    "SELECT report_id, report_data FROM saved_reports WHERE data_source_id = ? AND data_provenance = 'live' ORDER BY created_at DESC LIMIT 1",
    [dataSourceId],
  );
  const row = rows[0];
  if (!row) return null;
  let report: SavedReport;
  try {
    report = JSON.parse(String(row.report_data));
  } catch {
    return null;
  }
  // 结构最小校验：扫描引擎依赖 kpiList 与 charts 数组
  if (!report || !Array.isArray(report.kpiList) || !Array.isArray(report.charts)) return null;
  return { reportId: String(row.report_id), report };
}

export interface PatrolExecResult {
  status: PatrolRunStatus;
  anomalyCount: number;
  highCount: number;
  reportId: string;
  reportTitle: string;
  anomalies: AnomalyItem[];
  error: string;
}

/**
 * 执行一次巡检查询并落库（运行历史 + 计划 last_* 快照）。
 * 供调度器与「立即执行」端点共用；扫描引擎为纯统计规则，无 LLM 依赖，秒级完成。
 */
export async function executePatrol(patrolId: string, pool?: mysql.Pool): Promise<PatrolExecResult> {
  const p = pool ?? getPool();
  const plan = await findPatrol(patrolId, p);
  if (!plan) throw new Error('巡检计划不存在');

  let outcome: PatrolExecResult;
  try {
    const latest = await loadLatestLiveReport(plan.data_source_id, p);
    if (!latest) {
      outcome = { status: 'NO_DATA', anomalyCount: 0, highCount: 0, reportId: '', reportTitle: '', anomalies: [], error: '' };
    } else {
      const scanned = scanReportForAnomalies(latest.report);
      const all = Array.isArray(scanned.anomalies) ? scanned.anomalies : [];
      const sorted = [...all].sort((a, b) => {
        const sev = (x: AnomalyItem) => (x.severity === 'high' ? 2 : x.severity === 'medium' ? 1 : 0);
        return sev(b) - sev(a);
      });
      outcome = {
        status: all.length > 0 ? 'ANOMALY' : 'CLEAN',
        anomalyCount: all.length,
        highCount: all.filter((a) => a.severity === 'high').length,
        reportId: latest.reportId,
        reportTitle: String(latest.report.title || ''),
        anomalies: sorted.slice(0, MAX_STORED_ANOMALIES),
        error: '',
      };
    }
  } catch (err: any) {
    outcome = { status: 'ERROR', anomalyCount: 0, highCount: 0, reportId: '', reportTitle: '', anomalies: [], error: String(err?.message || err).slice(0, 500) };
  }

  await p.query(
    `INSERT INTO anomaly_patrol_runs (patrol_id, status, report_id, report_title, anomaly_count, high_count, anomalies_json, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      patrolId,
      outcome.status,
      outcome.reportId,
      outcome.reportTitle.slice(0, 500),
      outcome.anomalyCount,
      outcome.highCount,
      JSON.stringify(outcome.anomalies),
      outcome.error,
    ],
  );
  await p.query(
    'UPDATE anomaly_patrols SET last_run_at = NOW(), last_run_status = ?, last_anomaly_count = ? WHERE patrol_id = ?',
    [outcome.status, outcome.anomalyCount, patrolId],
  );
  return outcome;
}

// ---------------- 调度器 ----------------

let timer: NodeJS.Timeout | null = null;

/** 调度器 tick 周期（环境变量可覆盖，仅用于测试调快） */
export function patrolSchedulerIntervalMs(): number {
  const n = Number(process.env.PATROL_SCHEDULER_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 60_000;
}

/** 单 tick 最多领取的到期计划数 */
export function patrolTickBatch(): number {
  const n = Number(process.env.PATROL_TICK_BATCH);
  return Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : 5;
}

/**
 * 到期计划原子领取：把 next_run_at 推进到下一周期，affectedRows=1 的实例才执行扫描。
 * 多实例/多 worker 场景下不会重复执行同一计划。
 */
export async function claimDuePatrols(batch = patrolTickBatch(), pool?: mysql.Pool): Promise<PatrolRow[]> {
  const p = pool ?? getPool();
  const [due] = await p.query<PatrolRow[]>(
    "SELECT * FROM anomaly_patrols WHERE status = 'ACTIVE' AND (next_run_at IS NULL OR next_run_at <= NOW()) ORDER BY next_run_at ASC LIMIT ?",
    [batch],
  );
  const claimed: PatrolRow[] = [];
  for (const row of due) {
    const [r] = await p.query<mysql.ResultSetHeader>(
      'UPDATE anomaly_patrols SET next_run_at = NOW() + INTERVAL interval_minutes MINUTE WHERE patrol_id = ? AND status = ? AND (next_run_at IS NULL OR next_run_at <= NOW())',
      [row.patrol_id, 'ACTIVE'],
    );
    if (r.affectedRows === 1) claimed.push(row);
  }
  return claimed;
}

/** 执行到期计划，返回本轮实际执行的计划数 */
export async function runDuePatrols(pool?: mysql.Pool): Promise<number> {
  const claimed = await claimDuePatrols(patrolTickBatch(), pool);
  for (const row of claimed) {
    try {
      const out = await executePatrol(row.patrol_id, pool);
      logger.info(`[Patrol] ${row.patrol_id} 巡检完成（${out.status}，异常 ${out.anomalyCount} 项）`);
    } catch (err: any) {
      logger.warn(`[Patrol] ${row.patrol_id} 巡检执行失败:`, err?.message || err);
    }
  }
  return claimed.length;
}

/** 启动调度器（幂等；与 taskQueue 类似内置 worker，不引入外部 cron；tick 级防重入由闭包守卫） */
export function startPatrolScheduler(intervalMs = patrolSchedulerIntervalMs()): void {
  if (timer) return;
  let ticking = false;
  timer = setInterval(() => {
    if (ticking) return; // 上一轮 tick 未完成（慢扫描），跳过本轮避免并发重入
    ticking = true;
    void runDuePatrols()
      .catch((err) => logger.warn('[Patrol] 调度 tick 失败:', err?.message || err))
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  timer.unref?.();
  logger.info(`[Patrol] 异常巡检调度器已启动（tick=${intervalMs}ms）`);
}

/** 测试/停机用 */
export function stopPatrolScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
