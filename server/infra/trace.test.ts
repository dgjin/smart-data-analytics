/**
 * P2-1 轻量分布式追踪单元测试：
 * - W3C traceparent 解析（合法/非法/全零/保留版本）
 * - withSpan 嵌套父子关系与异常状态
 * - recordSpan 补录（有/无上下文）
 * - 开关（TRACE_ENABLED=0 直通）与采样（TRACE_SAMPLE_RATE=0 不记 span）
 * - HTTP 中间件：/api 前缀过滤、traceparent 透传与响应头回写
 * - 缓冲查询：listTraces 倒序/limit、getTrace 瀑布排序
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  parseTraceparent,
  buildTraceparent,
  withSpan,
  recordSpan,
  listTraces,
  getTrace,
  clearTraces,
  traceMiddleware,
  getTraceContext,
  newTraceId,
  type TraceSnapshot,
} from './trace';

beforeEach(() => {
  clearTraces();
  delete process.env.TRACE_ENABLED;
  delete process.env.TRACE_SAMPLE_RATE;
  delete process.env.TRACE_BUFFER_SIZE;
});

afterEach(() => {
  clearTraces();
  delete process.env.TRACE_ENABLED;
  delete process.env.TRACE_SAMPLE_RATE;
});

/** finish 事件与 supertest 响应存在理论竞态：轮询等待链路落缓冲（上限 300ms） */
async function waitForTrace(traceId: string, minSpans = 1): Promise<TraceSnapshot | undefined> {
  for (let i = 0; i < 30; i++) {
    const t = getTrace(traceId);
    if (t && t.spans.length >= minSpans) return t;
    await new Promise((r) => setTimeout(r, 10));
  }
  return getTrace(traceId);
}

describe('traceparent 解析', () => {
  it('合法头 → traceId/parentSpanId/sampled 正确提取', () => {
    const parsed = parseTraceparent(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
    expect(parsed).toEqual({ traceId: 'a'.repeat(32), parentSpanId: 'b'.repeat(16), sampled: true });
  });

  it('flags=00 → sampled=false', () => {
    const parsed = parseTraceparent(`00-${'1'.repeat(32)}-${'2'.repeat(16)}-00`);
    expect(parsed?.sampled).toBe(false);
  });

  it.each([
    ['空值', undefined],
    ['格式不符', 'abc'],
    ['全零 traceId', `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`],
    ['全零 parentSpanId', `00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`],
    ['保留版本 ff', `ff-${'a'.repeat(32)}-${'b'.repeat(16)}-01`],
  ])('%s → null', (_name, header) => {
    expect(parseTraceparent(header)).toBeNull();
  });
});

describe('withSpan', () => {
  it('无上下文时自成链路并记录 span', async () => {
    const out = await withSpan('unit.demo', async () => 'done', { 'demo.k': 'v' });
    expect(out).toBe('done');
    const [summary] = listTraces(1);
    expect(summary).toBeDefined();
    expect(summary.spanCount).toBe(1);
    const trace = getTrace(summary.traceId);
    expect(trace?.spans[0].name).toBe('unit.demo');
    expect(trace?.spans[0].status).toBe('ok');
    expect(trace?.spans[0].attributes['demo.k']).toBe('v');
  });

  it('嵌套 span 共享 traceId 且 parentSpanId 指向父 span', async () => {
    await withSpan('parent', async () => {
      await withSpan('child', async () => {
        await withSpan('grandchild', async () => undefined);
      });
    });
    const [summary] = listTraces(1);
    const trace = getTrace(summary.traceId);
    expect(trace?.spans.map((s) => s.name)).toEqual(['parent', 'child', 'grandchild']);
    const [parent, child, grand] = trace!.spans;
    expect(parent.parentSpanId).toBeUndefined();
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(grand.parentSpanId).toBe(child.spanId);
    expect(new Set(trace!.spans.map((s) => s.traceId))).toEqual(new Set([summary.traceId]));
  });

  it('抛错 → status=error 并原样向上抛出', async () => {
    await expect(
      withSpan('boom', async () => {
        throw new Error('炸弹');
      })
    ).rejects.toThrow('炸弹');
    const [summary] = listTraces(1);
    const span = getTrace(summary.traceId)!.spans[0];
    expect(span.status).toBe('error');
    expect(span.attributes['error.message']).toBe('炸弹');
  });

  it('TRACE_ENABLED=0 → 直通执行且不记录', async () => {
    process.env.TRACE_ENABLED = '0';
    await expect(withSpan('skip', async () => 42)).resolves.toBe(42);
    expect(listTraces()).toHaveLength(0);
  });

  it('TRACE_SAMPLE_RATE=0 → 生成链路上下文但不落 span', async () => {
    process.env.TRACE_SAMPLE_RATE = '0';
    let innerTraceId: string | undefined;
    await withSpan('noop', async () => {
      innerTraceId = getTraceContext()?.traceId;
    });
    expect(innerTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(listTraces()).toHaveLength(0);
  });
});

describe('recordSpan 补录', () => {
  it('无上下文时独立成链路（后台任务场景）', () => {
    recordSpan('llm.call', 12, 'ok', { 'llm.model': 'm1' });
    const [summary] = listTraces(1);
    expect(summary.spanCount).toBe(1);
    expect(summary.durationMs).toBeGreaterThanOrEqual(12);
  });

  it('有上下文时挂到当前 span 下', async () => {
    await withSpan('http.request', async () => {
      recordSpan('sql.execute', 5, 'ok', {});
    });
    const [summary] = listTraces(1);
    const trace = getTrace(summary.traceId)!;
    const root = trace.spans.find((s) => s.name === 'http.request')!;
    const sql = trace.spans.find((s) => s.name === 'sql.execute')!;
    expect(sql.parentSpanId).toBe(root.spanId);
  });

  it('status=error 与属性原样落库', () => {
    recordSpan('memory.recall', 3, 'error', { 'memory.mode': 'on', 'memory.timeout': true });
    const trace = getTrace(listTraces(1)[0].traceId)!;
    expect(trace.spans[0].status).toBe('error');
    expect(trace.spans[0].attributes['memory.timeout']).toBe(true);
  });
});

describe('buildTraceparent', () => {
  it('无上下文 → undefined', () => {
    expect(buildTraceparent()).toBeUndefined();
  });

  it('span 内 → 携带当前 traceId 的合法头', async () => {
    await withSpan('ctx', async () => {
      const header = buildTraceparent();
      expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
      expect(header).toContain(getTraceContext()!.traceId);
    });
  });
});

describe('缓冲查询', () => {
  it('listTraces 按开始时间倒序并遵守 limit', () => {
    for (let i = 0; i < 5; i++) recordSpan(`s${i}`, 1, 'ok', {});
    const all = listTraces(10);
    expect(all).toHaveLength(5);
    expect(all[0].startMs).toBeGreaterThanOrEqual(all[4].startMs);
    expect(listTraces(2)).toHaveLength(2);
  });

  it('非法 traceId 查询返回 undefined', () => {
    expect(getTrace('nope')).toBeUndefined();
  });
});

describe('traceMiddleware', () => {
  function buildApp() {
    const app = express();
    app.use(traceMiddleware);
    app.get('/api/demo', async (_req, res) => {
      await withSpan('stage.one', async () => new Promise((r) => setTimeout(r, 3)));
      res.json({ ok: true });
    });
    app.get('/static/demo', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('/api 请求 → 响应头带 traceparent，根 span + 子 span 成树', async () => {
    const res = await request(buildApp()).get('/api/demo');
    expect(res.status).toBe(200);
    expect(res.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    const traceId = (res.headers.traceparent as string).split('-')[1];
    const trace = await waitForTrace(traceId, 2);
    expect(trace).toBeDefined();
    expect(trace!.route).toBe('/api/demo');
    expect(trace!.statusCode).toBe(200);
    expect(trace!.spans.map((s) => s.name)).toEqual(['http.request', 'stage.one']);
    const root = trace!.spans[0];
    expect(root.attributes['http.method']).toBe('GET');
    expect(root.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('非 /api 请求不追踪（静态资源不建链路）', async () => {
    const res = await request(buildApp()).get('/static/demo');
    expect(res.status).toBe(200);
    expect(res.headers.traceparent).toBeUndefined();
    expect(listTraces()).toHaveLength(0);
  });

  it('入站 traceparent → 沿用上游 traceId，并在根 span 记录上游 parentSpanId', async () => {
    const upstreamTraceId = 'c'.repeat(32);
    const upstreamSpanId = 'd'.repeat(16);
    const res = await request(buildApp())
      .get('/api/demo')
      .set('traceparent', `00-${upstreamTraceId}-${upstreamSpanId}-01`);
    expect((res.headers.traceparent as string).split('-')[1]).toBe(upstreamTraceId);
    // 等根 span（finish 时最后落库）与子 span 都到齐
    const trace = await waitForTrace(upstreamTraceId, 2);
    expect(trace!.spans[0].name).toBe('http.request');
    expect(trace!.spans[0].parentSpanId).toBe(upstreamSpanId);
  });

  it('5xx → 根 span status=error', async () => {
    const app = express();
    app.use(traceMiddleware);
    app.get('/api/fail', (_req, res) => {
      res.status(500).json({ error: 'x' });
    });
    const res = await request(app).get('/api/fail');
    const traceId = (res.headers.traceparent as string).split('-')[1];
    const trace = await waitForTrace(traceId, 1);
    expect(trace!.spans[0].status).toBe('error');
  });

  it('新链路 id 为 32 位十六进制', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });
});
