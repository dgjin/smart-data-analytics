/**
 * Prometheus 监控埋点（P0）。
 * 设计原则：
 * - 单点接入：writeAudit（问数全状态/耗时）、queryCache（L1/L2 命中）、
 *   recordLlmUsage（LLM 时延/token）、executeSafeSql（SQL 执行耗时）旁路打点，
 *   不侵入业务热路径；
 * - 基数红线：question / userId / dataSourceId 一律不进 label，
 *   label 仅使用低基数枚举（status/endpoint/channel/model 等）；
 * - fail-open：监控埋点异常绝不影响业务链路（全 try/catch 静默）。
 */
import client from 'prom-client';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuditEntry } from './auditLog';
import type { LlmUsageEntry } from '../llm/llmUsage';
import { getErrorMessage } from './errorUtils';
import { probeRedisPersistence } from './health';

export const metricsRegister = new client.Registry();
client.collectDefaultMetrics({ register: metricsRegister });

// ---------- 问数业务指标（埋点：auditLog.writeAudit 单点） ----------

export const nl2sqlRequests = new client.Counter({
  name: 'nl2sql_requests_total',
  help: '审计落账请求总数（问数/报表等，按终态与端点分）',
  labelNames: ['status', 'endpoint'],
  registers: [metricsRegister],
});

export const nl2sqlDuration = new client.Histogram({
  name: 'nl2sql_duration_seconds',
  help: '请求端到端耗时（秒）',
  labelNames: ['status'],
  // 对齐性能评估基线：SUCCESS avg 249s，bucket 覆盖缓存命中（ms 级）到长查询（分钟级）
  buckets: [0.01, 0.1, 1, 5, 10, 30, 60, 120, 300, 600],
  registers: [metricsRegister],
});

// ---------- 缓存命中（埋点：queryCache getCachedQuery / getSemanticCachedQuery） ----------

export const nl2sqlCacheHits = new client.Counter({
  name: 'nl2sql_cache_hits_total',
  help: '查询缓存命中次数（l1=归一化精确，l2=语义）',
  labelNames: ['layer'],
  registers: [metricsRegister],
});

// ---------- LLM 调用（埋点：llmUsage.recordLlmUsage 单点） ----------

export const llmCallDuration = new client.Histogram({
  name: 'llm_call_duration_seconds',
  help: 'LLM 调用耗时（秒）；model label 天然区分快速/主模型',
  labelNames: ['channel', 'engine', 'model', 'ok'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [metricsRegister],
});

export const llmTokens = new client.Counter({
  name: 'llm_tokens_total',
  help: 'LLM token 消耗量',
  labelNames: ['channel', 'model', 'type'],
  registers: [metricsRegister],
});

// ---------- SQL 执行（埋点：sqlExecutor.executeSafeSql 包装） ----------

export const sqlExecDuration = new client.Histogram({
  name: 'sql_execute_duration_seconds',
  help: '安全 SQL 执行耗时（秒，含白名单校验+真库执行）',
  labelNames: ['result'],
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [metricsRegister],
});

export const sqlExplainGuard = new client.Counter({
  name: 'sql_explain_guard_total',
  help: 'EXPLAIN 防线统计：passed=扫描量在阈值内放行 / blocked=超阈值拦截 / error=EXPLAIN 自身失败（fail-open 放行）',
  labelNames: ['outcome', 'dialect'],
  registers: [metricsRegister],
});

// ---------- HTTP 接口（埋点：server.ts 中间件，仅 /api/* 避免 Vite 静态资源高基数） ----------

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP /api/* 接口耗时（秒）',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [metricsRegister],
});

// ---------- 埋点函数（全部 fail-open） ----------

/** 审计落账旁路：状态计数 + 耗时直方图 */
export function observeAudit(entry: AuditEntry): void {
  try {
    nl2sqlRequests.inc({ status: entry.status, endpoint: entry.endpoint });
    if (typeof entry.durationMs === 'number' && entry.durationMs > 0) {
      nl2sqlDuration.observe({ status: entry.status }, entry.durationMs / 1000);
    }
  } catch { /* 监控埋点失败静默 */ }
}

/** 缓存命中旁路 */
export function observeCacheHit(layer: 'l1' | 'l2'): void {
  try {
    nl2sqlCacheHits.inc({ layer });
  } catch { /* 静默 */ }
}

/** EXPLAIN 防线旁路：passed/blocked/error 三态计数 */
export function observeExplainGuard(outcome: 'passed' | 'blocked' | 'error', dialect: string): void {
  try {
    sqlExplainGuard.inc({ outcome, dialect });
  } catch { /* 静默 */ }
}

/** LLM 用量旁路：调用耗时 + token 计数 */
export function observeLlmUsage(entry: LlmUsageEntry): void {
  try {
    llmCallDuration.observe(
      { channel: entry.channel, engine: entry.engine, model: entry.model, ok: entry.ok ? '1' : '0' },
      Math.max(0, entry.durationMs) / 1000
    );
    if (entry.promptTokens > 0) llmTokens.inc({ channel: entry.channel, model: entry.model, type: 'prompt' }, entry.promptTokens);
    if (entry.completionTokens > 0) llmTokens.inc({ channel: entry.channel, model: entry.model, type: 'completion' }, entry.completionTokens);
  } catch { /* 静默 */ }
}

/** SQL 执行耗时旁路 */
export function observeSqlExec(durationMs: number, ok: boolean): void {
  try {
    sqlExecDuration.observe({ result: ok ? 'ok' : 'error' }, Math.max(0, durationMs) / 1000);
  } catch { /* 静默 */ }
}

// ---------- 自动运维事件（埋点：opsEvents.recordOpsEvent 单点） ----------

export const opsEventsRecorded = new client.Counter({
  name: 'ops_events_recorded_total',
  help: '自动运维事件记录数（含同键去重合并；明细见 /api/ops/events）',
  labelNames: ['severity', 'category'],
  registers: [metricsRegister],
});

/** 运维事件旁路（fail-open，不影响事件落库） */
export function observeOpsEvent(severity: string, category: string): void {
  try {
    opsEventsRecorded.inc({ severity, category });
  } catch { /* 静默 */ }
}

// ---------- 统一记忆体（v0.9.106）：召回耗时/注入 token/通道命中 ----------

export const memoryRecallDuration = new client.Histogram({
  name: 'nl2sql_memory_recall_duration_ms',
  help: '统一记忆体召回耗时（毫秒）；验收：P95 ≤ 300ms',
  labelNames: ['mode', 'result'],
  buckets: [20, 50, 100, 200, 300, 500, 800, 1500],
  registers: [metricsRegister],
});

export const memoryRecallTokens = new client.Histogram({
  name: 'nl2sql_memory_injected_tokens',
  help: '统一记忆体单次注入 token 估算（不含铁律/指标强制段）',
  labelNames: ['mode'],
  buckets: [100, 300, 600, 1200, 2400, 3600, 6000],
  registers: [metricsRegister],
});

export const memoryChannelHits = new client.Counter({
  name: 'nl2sql_memory_channel_hits_total',
  help: '统一记忆体各通道召回命中条数',
  labelNames: ['channel'],
  registers: [metricsRegister],
});

/** 召回旁路（fail-open，不影响主链路） */
export function observeMemoryRecall(entry: {
  mode: 'off' | 'shadow' | 'on';
  ok: boolean;
  durationMs: number;
  injectedTokens: number;
  channelHits: Record<string, number | undefined>;
}): void {
  try {
    memoryRecallDuration.observe({ mode: entry.mode, result: entry.ok ? 'ok' : 'error' }, Math.max(0, entry.durationMs));
    if (entry.ok) memoryRecallTokens.observe({ mode: entry.mode }, Math.max(0, entry.injectedTokens));
    for (const [channel, hits] of Object.entries(entry.channelHits)) {
      if ((hits || 0) > 0) memoryChannelHits.inc({ channel }, hits as number);
    }
  } catch { /* 静默 */ }
}

// ---------- Redis 落盘巡检（v0.9.116）：/metrics 抓取时实时读取 INFO persistence ----------
//
// 背景：Redis 自动保存规则被运行期 CONFIG SET save "" 清空时不写任何日志，只能靠
// rdb_last_save_time 年龄 + 未落盘写入数发现（详见《混沌工程演练手册》复盘）。

export const redisRdbLastSaveAge = new client.Gauge({
  name: 'redis_rdb_last_save_age_seconds',
  help: 'Redis 最近一次 RDB 落盘距今秒数（未启用 Redis 或读取失败时不更新）',
  registers: [metricsRegister],
});

export const redisRdbChangesSinceSave = new client.Gauge({
  name: 'redis_rdb_changes_since_last_save',
  help: 'Redis 距上次落盘的写命令累计数（>0 表示有未落盘数据）',
  registers: [metricsRegister],
});

export const redisRdbSavesConsecutiveFailures = new client.Gauge({
  name: 'redis_rdb_saves_consecutive_failures',
  help: 'Redis 连续 BGSAVE 失败次数（>0 触发告警）',
  registers: [metricsRegister],
});

/** 抓取前刷新落盘指标（观测类 fail-open：读取失败保持旧值，不影响其他指标） */
export async function refreshRedisPersistenceMetrics(): Promise<void> {
  try {
    const r = await probeRedisPersistence();
    if (!r.enabled || r.error) return;
    redisRdbLastSaveAge.set(r.lastSaveAgeSec ?? 0);
    redisRdbChangesSinceSave.set(r.changesSinceLastSave ?? 0);
    redisRdbSavesConsecutiveFailures.set(r.savesConsecutiveFailures ?? 0);
  } catch { /* 静默 */ }
}

// ---------- /metrics 端点（不走 JWT；可选 METRICS_TOKEN 保护） ----------

/** 定长摘要后恒时比较：消除明文比较的计时侧信道（摘要后长度恒定，timingSafeEqual 不会因长度差异抛错） */
function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function metricsHandler(req: Request, res: Response): Promise<void> {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || String(req.query.token || '');
    if (!tokensMatch(provided, token)) {
      res.status(403).end('forbidden');
      return;
    }
  }
  try {
    await refreshRedisPersistenceMetrics();
    res.set('Content-Type', metricsRegister.contentType);
    res.end(await metricsRegister.metrics());
  } catch (err) {
    res.status(500).end(`metrics error: ${getErrorMessage(err) || 'unknown'}`);
  }
}
