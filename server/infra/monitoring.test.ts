/**
 * Prometheus 监控埋点单测：
 * 验证指标注册、埋点函数 fail-open 行为与 /metrics 输出格式。
 */
import { describe, expect, it } from 'vitest';
import {
  metricsRegister,
  metricsHandler,
  observeAudit,
  observeCacheHit,
  observeLlmUsage,
  observeSqlExec,
} from './monitoring';

describe('monitoring（Prometheus 埋点）', () => {
  it('注册表包含全部业务指标与 Node 默认指标', async () => {
    const text = await metricsRegister.metrics();
    for (const name of [
      'nl2sql_requests_total',
      'nl2sql_duration_seconds',
      'nl2sql_cache_hits_total',
      'llm_call_duration_seconds',
      'llm_tokens_total',
      'sql_execute_duration_seconds',
      'http_request_duration_seconds',
      'nodejs_eventloop_lag_seconds', // collectDefaultMetrics
    ]) {
      expect(text).toContain(`# TYPE ${name}`);
    }
  });

  it('observeAudit 按 status/endpoint 计数并观测耗时', async () => {
    const before = await metricsRegister.getSingleMetricAsString('nl2sql_requests_total');
    observeAudit({ userId: 1, username: 't', endpoint: 'query', status: 'SUCCESS', durationMs: 2500 });
    const after = await metricsRegister.getSingleMetricAsString('nl2sql_requests_total');
    expect(after).toContain('status="SUCCESS"');
    expect(after).not.toBe(before);
    const hist = await metricsRegister.getSingleMetricAsString('nl2sql_duration_seconds');
    expect(hist).toContain('status="SUCCESS"');
  });

  it('observeCacheHit 区分 L1/L2 层', async () => {
    observeCacheHit('l1');
    observeCacheHit('l2');
    const text = await metricsRegister.getSingleMetricAsString('nl2sql_cache_hits_total');
    expect(text).toContain('layer="l1"');
    expect(text).toContain('layer="l2"');
  });

  it('observeLlmUsage 记录耗时与 token（含 ok=0 失败调用）', async () => {
    observeLlmUsage({ engine: 'ollama', model: 'qwen3:8b', channel: 'json', promptTokens: 100, completionTokens: 50, durationMs: 1200, ok: true });
    observeLlmUsage({ engine: 'ollama', model: 'qwen3:8b', channel: 'json', promptTokens: 0, completionTokens: 0, durationMs: 300, ok: false });
    const dur = await metricsRegister.getSingleMetricAsString('llm_call_duration_seconds');
    expect(dur).toContain('model="qwen3:8b"');
    expect(dur).toContain('ok="0"');
    const tokens = await metricsRegister.getSingleMetricAsString('llm_tokens_total');
    expect(tokens).toContain('type="prompt"');
    expect(tokens).toContain('type="completion"');
  });

  it('observeSqlExec 记录成败 label', async () => {
    observeSqlExec(120, true);
    observeSqlExec(80, false);
    const text = await metricsRegister.getSingleMetricAsString('sql_execute_duration_seconds');
    expect(text).toContain('result="ok"');
    expect(text).toContain('result="error"');
  });

  it('埋点函数对非法输入 fail-open（不抛异常）', () => {
    expect(() => observeAudit({ userId: 0, username: '', endpoint: 'query', status: 'ERROR' })).not.toThrow();
    expect(() => observeLlmUsage({ engine: '', model: '', channel: 'text', promptTokens: -1, completionTokens: 0, durationMs: -5, ok: false })).not.toThrow();
    expect(() => observeSqlExec(Number.NaN, true)).not.toThrow();
  });

  it('metricsHandler 输出 Prometheus 文本格式；设置 METRICS_TOKEN 后未授权返回 403', async () => {
    const mkRes = () => {
      const res: any = {
        statusCode: 200,
        body: '',
        headers: {} as Record<string, string>,
        set(k: string, v: string) { this.headers[k] = v; },
        status(code: number) { this.statusCode = code; return this; },
        end(b?: string) { this.body = b || ''; return this; },
      };
      return res;
    };

    delete process.env.METRICS_TOKEN;
    const res1 = mkRes();
    await metricsHandler({ get: () => undefined, query: {} } as any, res1);
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['Content-Type']).toContain('text/plain');
    expect(res1.body).toContain('nl2sql_requests_total');

    process.env.METRICS_TOKEN = 'secret-x';
    const res2 = mkRes();
    await metricsHandler({ get: () => undefined, query: {} } as any, res2);
    expect(res2.statusCode).toBe(403);
    const res3 = mkRes();
    await metricsHandler({ get: () => 'Bearer secret-x', query: {} } as any, res3);
    expect(res3.statusCode).toBe(200);
    delete process.env.METRICS_TOKEN;
  });
});
