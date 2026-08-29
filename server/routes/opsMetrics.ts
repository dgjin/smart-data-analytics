/**
 * P0-4 在线准确率度量看板：北极星指标聚合 API（仅 ADMIN）。
 * 数据源：query_audit_log（十态）+ query_feedback（点赞/点踩）+ query_trace（自纠错触发）。
 * 聚合逻辑抽取为纯函数（computeNorthStar / buildDailyTrend / toWeeklyTrend）便于单测。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import { getPool } from '../db';

// ---------- 类型 ----------

export interface DailyCountRow {
  date: string; // YYYY-MM-DD
  bucket: string; // audit status / feedback verdict
  cnt: number;
}

export interface DailyTraceRow {
  date: string;
  traces: number;
  selfCorrected: number;
}

export interface NorthStarMetrics {
  totalQueries: number;
  /** 成功应答（含缓存命中） */
  answered: number;
  successRate: number;
  cacheHitRate: number;
  clarifyRate: number;
  refuseRate: number;
  fallbackRate: number;
  errorRate: number;
  deniedRate: number;
  feedbackTotal: number;
  upCount: number;
  downCount: number;
  /** 点赞率 = UP / (UP+DOWN)；无反馈时为 null */
  upRate: number | null;
  downRate: number | null;
  tracedQueries: number;
  selfCorrected: number;
  /** 自纠错触发率 = 触发重试（≥2 次 SQL 生成）的链路 / 有留痕链路 */
  selfCorrectRate: number | null;
  avgDurationMs: number;
}

export interface DailyTrendPoint {
  date: string;
  total: number;
  success: number;
  cache: number;
  clarify: number;
  refused: number;
  fallback: number;
  error: number;
  denied: number;
  up: number;
  down: number;
  traces: number;
  selfCorrected: number;
}

export interface WeeklyTrendPoint {
  week: string; // ISO 周起始日 YYYY-MM-DD（周一）
  total: number;
  successRate: number | null;
  cacheHitRate: number | null;
  clarifyRate: number | null;
  refuseRate: number | null;
  upRate: number | null;
  /** P3-1 四率周报补齐：点踩率 = DOWN / (UP+DOWN)；无反馈时为 null */
  downRate: number | null;
  selfCorrectRate: number | null;
}

// ---------- 纯函数（可单测） ----------

function rate(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

/** 由按日分桶计数聚合北极星指标 */
export function computeNorthStar(
  auditRows: DailyCountRow[],
  feedbackRows: DailyCountRow[],
  traceRows: DailyTraceRow[],
  avgDurationMs: number
): NorthStarMetrics {
  const byStatus: Record<string, number> = {};
  let totalQueries = 0;
  for (const r of auditRows) {
    byStatus[r.bucket] = (byStatus[r.bucket] || 0) + r.cnt;
    totalQueries += r.cnt;
  }
  const denied =
    (byStatus['DENIED_INPUT'] || 0) +
    (byStatus['DENIED_AUTH'] || 0) +
    (byStatus['DENIED_RATE'] || 0) +
    (byStatus['DENIED_SWITCH'] || 0);
  const answered = (byStatus['SUCCESS'] || 0) + (byStatus['CACHE'] || 0);

  let upCount = 0;
  let downCount = 0;
  for (const r of feedbackRows) {
    if (r.bucket === 'UP') upCount += r.cnt;
    else if (r.bucket === 'DOWN') downCount += r.cnt;
  }
  const feedbackTotal = upCount + downCount;

  let tracedQueries = 0;
  let selfCorrected = 0;
  for (const r of traceRows) {
    tracedQueries += r.traces;
    selfCorrected += r.selfCorrected;
  }

  return {
    totalQueries,
    answered,
    successRate: rate(answered, totalQueries),
    cacheHitRate: rate(byStatus['CACHE'] || 0, totalQueries),
    clarifyRate: rate(byStatus['CLARIFY'] || 0, totalQueries),
    refuseRate: rate(byStatus['REFUSED'] || 0, totalQueries),
    fallbackRate: rate(byStatus['FALLBACK'] || 0, totalQueries),
    errorRate: rate(byStatus['ERROR'] || 0, totalQueries),
    deniedRate: rate(denied, totalQueries),
    feedbackTotal,
    upCount,
    downCount,
    upRate: feedbackTotal > 0 ? upCount / feedbackTotal : null,
    downRate: feedbackTotal > 0 ? downCount / feedbackTotal : null,
    tracedQueries,
    selfCorrected,
    selfCorrectRate: tracedQueries > 0 ? selfCorrected / tracedQueries : null,
    avgDurationMs: Math.round(avgDurationMs || 0),
  };
}

const DENIED_STATUSES = new Set(['DENIED_INPUT', 'DENIED_AUTH', 'DENIED_RATE', 'DENIED_SWITCH']);

/** 按日趋势：缺口日期补零，升序输出 */
export function buildDailyTrend(
  auditRows: DailyCountRow[],
  feedbackRows: DailyCountRow[],
  traceRows: DailyTraceRow[],
  days: number,
  today: Date = new Date()
): DailyTrendPoint[] {
  const map = new Map<string, DailyTrendPoint>();
  const ensure = (date: string): DailyTrendPoint => {
    let p = map.get(date);
    if (!p) {
      p = { date, total: 0, success: 0, cache: 0, clarify: 0, refused: 0, fallback: 0, error: 0, denied: 0, up: 0, down: 0, traces: 0, selfCorrected: 0 };
      map.set(date, p);
    }
    return p;
  };
  for (const r of auditRows) {
    const p = ensure(r.date);
    p.total += r.cnt;
    if (r.bucket === 'SUCCESS') p.success += r.cnt;
    else if (r.bucket === 'CACHE') p.cache += r.cnt;
    else if (r.bucket === 'CLARIFY') p.clarify += r.cnt;
    else if (r.bucket === 'REFUSED') p.refused += r.cnt;
    else if (r.bucket === 'FALLBACK') p.fallback += r.cnt;
    else if (r.bucket === 'ERROR') p.error += r.cnt;
    else if (DENIED_STATUSES.has(r.bucket)) p.denied += r.cnt;
  }
  for (const r of feedbackRows) {
    const p = ensure(r.date);
    if (r.bucket === 'UP') p.up += r.cnt;
    else if (r.bucket === 'DOWN') p.down += r.cnt;
  }
  for (const r of traceRows) {
    const p = ensure(r.date);
    p.traces += r.traces;
    p.selfCorrected += r.selfCorrected;
  }
  // 补零：从 today 往前 days 天（含今天）
  const out: DailyTrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = formatDate(d);
    out.push(map.get(key) || { date: key, total: 0, success: 0, cache: 0, clarify: 0, refused: 0, fallback: 0, error: 0, denied: 0, up: 0, down: 0, traces: 0, selfCorrected: 0 });
  }
  return out;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 按周聚合（周一起始）：比率为周内合计再计算 */
export function toWeeklyTrend(daily: DailyTrendPoint[]): WeeklyTrendPoint[] {
  const weeks = new Map<string, DailyTrendPoint[]>();
  for (const p of daily) {
    const d = new Date(`${p.date}T00:00:00`);
    const dow = (d.getDay() + 6) % 7; // 周一=0
    d.setDate(d.getDate() - dow);
    const key = formatDate(d);
    const arr = weeks.get(key) || [];
    arr.push(p);
    weeks.set(key, arr);
  }
  const out: WeeklyTrendPoint[] = [];
  for (const [week, points] of [...weeks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sum = (f: (p: DailyTrendPoint) => number) => points.reduce((acc, p) => acc + f(p), 0);
    const total = sum((p) => p.total);
    const fb = sum((p) => p.up + p.down);
    const traces = sum((p) => p.traces);
    out.push({
      week,
      total,
      successRate: total > 0 ? sum((p) => p.success + p.cache) / total : null,
      cacheHitRate: total > 0 ? sum((p) => p.cache) / total : null,
      clarifyRate: total > 0 ? sum((p) => p.clarify) / total : null,
      refuseRate: total > 0 ? sum((p) => p.refused) / total : null,
      upRate: fb > 0 ? sum((p) => p.up) / fb : null,
      downRate: fb > 0 ? sum((p) => p.down) / fb : null,
      selfCorrectRate: traces > 0 ? sum((p) => p.selfCorrected) / traces : null,
    });
  }
  return out;
}

// ---------- 路由 ----------

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

// GET /api/ops/metrics?days=7&dataSourceId= —— 北极星指标 + 日/周趋势（仅 ADMIN）
// P3-1：dataSourceId 可选过滤（四率按数据源下钻；空=全部数据源汇总）
router.get('/metrics', async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const dataSourceId = typeof req.query.dataSourceId === 'string' ? req.query.dataSourceId.trim() : '';
  const dsFilter = dataSourceId ? ' AND data_source_id = ?' : '';
  const dsParams = (base: unknown[]): unknown[] => (dataSourceId ? [...base, dataSourceId] : base);
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));

  try {
    const pool = getPool();
    // 问数主链路（endpoint='query'）按日 × 十态
    const [auditRowsRaw] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS date, status AS bucket, COUNT(*) AS cnt
       FROM query_audit_log
       WHERE endpoint = 'query' AND created_at >= ?${dsFilter}
       GROUP BY date, status`,
      dsParams([since])
    );
    // 反馈按日 × UP/DOWN
    const [feedbackRowsRaw] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS date, verdict AS bucket, COUNT(*) AS cnt
       FROM query_feedback
       WHERE created_at >= ?${dsFilter}
       GROUP BY date, verdict`,
      dsParams([since])
    );
    // 自纠错触发：同一 trace 出现 ≥2 次 SQL 生成视为触发重试/多候选择优
    const [traceRowsRaw] = await pool.query(
      `SELECT t.date AS date, COUNT(*) AS traces, SUM(t.gen_cnt >= 2) AS selfCorrected
       FROM (
         SELECT trace_id, DATE_FORMAT(MIN(created_at), '%Y-%m-%d') AS date, COUNT(*) AS gen_cnt
         FROM query_trace
         WHERE step_type = 'sql_gen' AND created_at >= ?${dsFilter}
         GROUP BY trace_id
       ) t
       GROUP BY t.date`,
      dsParams([since])
    );
    // 平均端到端耗时（问数主链路）
    const [avgRows] = await pool.query(
      `SELECT AVG(duration_ms) AS avgMs FROM query_audit_log WHERE endpoint = 'query' AND created_at >= ?${dsFilter}`,
      dsParams([since])
    );

    const toCountRows = (rows: any): DailyCountRow[] =>
      (rows as any[]).map((r) => ({ date: String(r.date), bucket: String(r.bucket), cnt: Number(r.cnt) }));
    const auditRows = toCountRows(auditRowsRaw);
    const feedbackRows = toCountRows(feedbackRowsRaw);
    const traceRows: DailyTraceRow[] = (traceRowsRaw as any[]).map((r) => ({
      date: String(r.date),
      traces: Number(r.traces),
      selfCorrected: Number(r.selfCorrected || 0),
    }));
    const avgMs = Number((avgRows as any[])[0]?.avgMs || 0);

    const northStar = computeNorthStar(auditRows, feedbackRows, traceRows, avgMs);
    const daily = buildDailyTrend(auditRows, feedbackRows, traceRows, days);
    const weekly = toWeeklyTrend(daily);

    return res.json({ success: true, days, dataSourceId: dataSourceId || null, northStar, daily, weekly });
  } catch (err: any) {
    console.error('[OpsMetrics] 聚合失败:', err?.message || err);
    return res.status(500).json({ error: '运维指标获取失败' });
  }
});

export default router;
