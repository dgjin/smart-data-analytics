/**
 * v0.9.77 P2-15 固定报表订阅：周期重跑固定报表 + 阈值告警，运行历史落库供前端订阅中心展示。
 * 重放链路复用 flexQueryRunner.runSavedFlexQuery（与 Excel 导出同源安全执行通道，
 * 数据源断开/敏感列/行级过滤/EXPLAIN 防线全部沿用）。
 * 调度：到期订阅原子领取（UPDATE ... WHERE next_run_at <= NOW() 抢占，affectedRows=1 才执行），
 * 多实例不重复执行；单实例内以 tick 防重入。崩溃恢复：next_run_at 基于数据库时间推进，
 * 实例重启后按当前时钟自然续跑（与 anomalyPatrol 巡检调度同模式，不引入外部 cron）。
 */
import type mysql from 'mysql2/promise';
import { getPool } from './infra/db';
import { logger } from './infra/logger';
import { getErrorMessage } from './infra/errorUtils';
import { runSavedFlexQuery } from './flexQueryRunner';

/** 订阅周期范围（分钟）：最短 5 分钟，最长 7 天 */
export const FLEX_SUB_MIN_FREQUENCY = 5;
export const FLEX_SUB_MAX_FREQUENCY = 7 * 24 * 60;

/** 告警比较符白名单（evaluateAlert 同步支持） */
export const FLEX_ALERT_OPS = ['>', '>=', '<', '<=', '='] as const;

export interface FlexSubscriptionPayload {
  frequencyMinutes: number;
  /** 告警指标结果列名（空 = 仅重跑不告警） */
  alertMetric: string;
  alertOp: string;
  alertThreshold: number;
}

/** 订阅入站校验（纯函数，供路由与单测）：周期/比较符/阈值/列名（ident-safe） */
export function normalizeSubscriptionPayload(
  raw: unknown,
): { ok: true; payload: FlexSubscriptionPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '订阅参数格式不正确' };
  }
  const r = raw as Record<string, unknown>;
  const frequencyRaw = Number(r.frequencyMinutes);
  if (!Number.isFinite(frequencyRaw) || frequencyRaw < FLEX_SUB_MIN_FREQUENCY || frequencyRaw > FLEX_SUB_MAX_FREQUENCY) {
    return { ok: false, error: `执行周期须在 ${FLEX_SUB_MIN_FREQUENCY} 分钟 ~ 7 天之间` };
  }
  const alertMetric = typeof r.alertMetric === 'string' ? r.alertMetric.trim() : '';
  if (alertMetric && (!/^[A-Za-z0-9_]{1,64}$/.test(alertMetric))) {
    return { ok: false, error: '告警指标列名非法（仅限字母/数字/下划线）' };
  }
  const alertOp = typeof r.alertOp === 'string' && r.alertOp.trim() ? r.alertOp.trim() : '>';
  if (!(FLEX_ALERT_OPS as readonly string[]).includes(alertOp)) {
    return { ok: false, error: '不支持的告警比较符' };
  }
  // 阈值与告警指标绑定：未提供/null/空串视为 0（仅重跑场景无需阈值）；提供了但非数字则拒绝
  const thresholdRaw =
    r.alertThreshold === undefined || r.alertThreshold === null || r.alertThreshold === '' ? 0 : Number(r.alertThreshold);
  if (!Number.isFinite(thresholdRaw)) {
    return { ok: false, error: '告警阈值须为数字' };
  }
  return {
    ok: true,
    payload: { frequencyMinutes: Math.floor(frequencyRaw), alertMetric, alertOp, alertThreshold: thresholdRaw },
  };
}

/** 阈值判定（纯函数）：value 为结果首行指标值；非法数值不触发 */
export function evaluateAlert(op: string, value: number, threshold: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  if (op === '>') return value > threshold;
  if (op === '>=') return value >= threshold;
  if (op === '<') return value < threshold;
  if (op === '<=') return value <= threshold;
  if (op === '=') return value === threshold;
  return false;
}

/** 订阅执行结果上限（只看首行告警值 + 行数摘要，防大结果集拖垮调度；env FLEX_SUB_MAX_ROWS） */
export function subscriptionRunMaxRows(): number {
  const n = Number(process.env.FLEX_SUB_MAX_ROWS);
  return Number.isFinite(n) && n >= 1 ? Math.min(10000, Math.floor(n)) : 1000;
}

export interface FlexSubscriptionRow extends mysql.RowDataPacket {
  subscription_id: string;
  query_id: string;
  user_id: number;
  username: string;
  frequency_minutes: number;
  alert_metric: string;
  alert_op: string;
  alert_threshold: number;
  status: string;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_at: Date;
}

function toIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return v ? String(v) : null;
}

/** 行记录 → API 响应（camelCase） */
export function toSubscriptionRecord(row: FlexSubscriptionRow) {
  return {
    subscriptionId: row.subscription_id,
    queryId: row.query_id,
    userId: row.user_id,
    username: row.username,
    frequencyMinutes: Number(row.frequency_minutes),
    alertMetric: String(row.alert_metric || ''),
    alertOp: String(row.alert_op || '>'),
    alertThreshold: Number(row.alert_threshold),
    status: String(row.status || 'ACTIVE'),
    lastRunAt: toIso(row.last_run_at),
    nextRunAt: toIso(row.next_run_at),
    createdAt: toIso(row.created_at),
  };
}

/** 单 tick 最多领取的到期订阅数（env FLEX_SUB_TICK_BATCH） */
export function subscriptionTickBatch(): number {
  const n = Number(process.env.FLEX_SUB_TICK_BATCH);
  return Number.isFinite(n) && n >= 1 ? Math.min(20, Math.floor(n)) : 3;
}

/**
 * 到期订阅原子领取：把 next_run_at 推进到下一周期，affectedRows=1 的实例才执行。
 * 多实例/多 worker 场景下不会重复执行同一订阅。
 */
export async function claimDueSubscriptions(batch = subscriptionTickBatch(), pool?: mysql.Pool): Promise<FlexSubscriptionRow[]> {
  const p = pool ?? getPool();
  const [due] = await p.query<FlexSubscriptionRow[]>(
    "SELECT * FROM flex_query_subscriptions WHERE status = 'ACTIVE' AND (next_run_at IS NULL OR next_run_at <= NOW()) ORDER BY next_run_at ASC LIMIT ?",
    [batch],
  );
  const claimed: FlexSubscriptionRow[] = [];
  for (const row of due) {
    const [r] = await p.query<mysql.ResultSetHeader>(
      'UPDATE flex_query_subscriptions SET next_run_at = NOW() + INTERVAL frequency_minutes MINUTE WHERE subscription_id = ? AND status = ? AND (next_run_at IS NULL OR next_run_at <= NOW())',
      [row.subscription_id, 'ACTIVE'],
    );
    if (r.affectedRows === 1) claimed.push(row);
  }
  return claimed;
}

export interface FlexSubExecResult {
  status: 'SUCCESS' | 'ALERT' | 'FAILED';
  rowCount: number;
  alertValue: string;
  message: string;
  durationMs: number;
}

/** 运行历史保留条数（超出清理，防无限增长） */
const RUN_KEEP = 200;

/**
 * 执行一次订阅（调度器与「立即执行」端点共用）：重放固定报表 → 阈值判定 → 落运行历史。
 * 报表不存在/数据源断开/执行失败均落 FAILED 记录，不抛出（调度场景不中断其他订阅）。
 */
export async function executeSubscription(subscriptionId: string, pool?: mysql.Pool): Promise<FlexSubExecResult> {
  const p = pool ?? getPool();
  const [rows] = await p.query<FlexSubscriptionRow[]>(
    'SELECT * FROM flex_query_subscriptions WHERE subscription_id = ? LIMIT 1',
    [subscriptionId],
  );
  const sub = rows[0];
  if (!sub) throw new Error('订阅不存在');
  const startedAt = Date.now();
  let status: 'SUCCESS' | 'ALERT' | 'FAILED' = 'SUCCESS';
  let rowCount = 0;
  let alertValue = '';
  let message: string;
  try {
    const run = await runSavedFlexQuery(String(sub.query_id), { maxRows: subscriptionRunMaxRows(), scenario: 'export' });
    if (run.ok !== true) {
      status = 'FAILED';
      message = run.error.slice(0, 500);
    } else {
      rowCount = run.data.rowCount;
      const metric = String(sub.alert_metric || '');
      if (!metric) {
        message = `执行成功（${rowCount} 行）`;
      } else if (run.data.rows.length === 0) {
        message = '执行成功但无数据行，未触发告警判定';
      } else {
        const value = Number(run.data.rows[0][metric]);
        if (!Number.isFinite(value)) {
          message = `结果列「${metric}」无有效数值，未触发告警判定`;
        } else {
          alertValue = String(value);
          if (evaluateAlert(String(sub.alert_op || '>'), value, Number(sub.alert_threshold))) {
            status = 'ALERT';
            message = `告警命中：${metric} ${sub.alert_op} ${sub.alert_threshold}（实际 ${value}）`;
          } else {
            message = `未触发告警：${metric} = ${value}（阈值 ${sub.alert_op} ${sub.alert_threshold}）`;
          }
        }
      }
    }
  } catch (err) {
    status = 'FAILED';
    message = getErrorMessage(err).slice(0, 500);
  }
  const durationMs = Date.now() - startedAt;
  await p.query(
    'INSERT INTO flex_query_subscription_runs (subscription_id, status, row_count, alert_value, message, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
    [subscriptionId, status, rowCount, alertValue, message, durationMs],
  );
  await p.query('UPDATE flex_query_subscriptions SET last_run_at = NOW() WHERE subscription_id = ?', [subscriptionId]);
  // 历史保留最近 RUN_KEEP 条（派生表物化绕过 MySQL 同表子查询限制；不足 RUN_KEEP 条时子查询无行不删除）
  await p.query(
    'DELETE FROM flex_query_subscription_runs WHERE subscription_id = ? AND id < (SELECT id FROM (SELECT id FROM flex_query_subscription_runs WHERE subscription_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?) AS keep_from)',
    [subscriptionId, subscriptionId, RUN_KEEP - 1],
  );
  return { status, rowCount, alertValue, message, durationMs };
}

/** 执行本轮到期订阅，返回实际执行数 */
export async function runDueSubscriptions(pool?: mysql.Pool): Promise<number> {
  const claimed = await claimDueSubscriptions(subscriptionTickBatch(), pool);
  for (const row of claimed) {
    try {
      const out = await executeSubscription(row.subscription_id, pool);
      logger.info(`[FlexSub] ${row.subscription_id} 执行完成（${out.status}，${out.message}）`);
    } catch (err) {
      logger.warn(`[FlexSub] ${row.subscription_id} 执行失败:`, getErrorMessage(err));
    }
  }
  return claimed.length;
}

let timer: NodeJS.Timeout | null = null;

/** 调度间隔（env FLEX_SUB_INTERVAL_MS，默认 60s，下限 5s） */
export function flexSubscriptionIntervalMs(): number {
  const n = Number(process.env.FLEX_SUB_INTERVAL_MS);
  return Number.isFinite(n) && n >= 5000 ? Math.floor(n) : 60_000;
}

/** 启动调度器（幂等；tick 级防重入由闭包守卫） */
export function startFlexSubscriptionScheduler(intervalMs = flexSubscriptionIntervalMs()): void {
  if (timer) return;
  let ticking = false;
  timer = setInterval(() => {
    if (ticking) return; // 上一轮 tick 未完成（慢查询），跳过本轮避免并发重入
    ticking = true;
    void runDueSubscriptions()
      .catch((err) => logger.warn('[FlexSub] 调度 tick 失败:', err?.message || err))
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  timer.unref?.();
  logger.info(`[FlexSub] 固定报表订阅调度器已启动（tick=${intervalMs}ms）`);
}

/** 测试/停机用 */
export function stopFlexSubscriptionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
