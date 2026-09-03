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
import type { Request, Response } from 'express';
import type { AuditEntry } from './auditLog';
import type { LlmUsageEntry } from './llmUsage';

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

// ---------- /metrics 端点（不走 JWT；可选 METRICS_TOKEN 保护） ----------

export async function metricsHandler(req: Request, res: Response): Promise<void> {
  const token = process.env.METRICS_TOKEN;
  if (token) {
    const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || String(req.query.token || '');
    if (provided !== token) {
      res.status(403).end('forbidden');
      return;
    }
  }
  try {
    res.set('Content-Type', metricsRegister.contentType);
    res.end(await metricsRegister.metrics());
  } catch (err: any) {
    res.status(500).end(`metrics error: ${err?.message || 'unknown'}`);
  }
}
