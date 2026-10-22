/**
 * P2-1 轻量分布式追踪（零依赖，语义对齐 OpenTelemetry）：
 * 一次问数请求的耗时分散在 HTTP 入口 / 记忆召回 / LLM 调用 / SQL 执行多个阶段，
 * 既有 Prometheus 指标只有「各阶段各自的分布」，无法回答「这一次为什么慢」。
 *
 * 设计：
 * - trace/span 模型对齐 W3C Trace Context：traceId 32 hex、spanId 16 hex，
 *   入站解析 `traceparent` 头（上游已埋点时沿用其 traceId），响应回写 `traceparent`，
 *   为将来接入 OTLP Collector 保留格式兼容（届时只需替换 exporter，无需改埋点）。
 * - 上下文经独立 AsyncLocalStorage 贯穿异步链（与 asyncContext 同源思路，但独立实例：
 *   LogContext 是日志字段容器，SpanContext 需要随 withSpan 嵌套切换）。
 *   logger 经 getTraceContext() 自动注入 traceId/spanId，日志与 span 天然可互查。
 * - 埋点单点接入：HTTP 根 span 由中间件统一建立；LLM/SQL/记忆召回在既有旁路埋点处补录，
 *   不改业务路径的返回语义。
 * - fail-open：任何追踪异常静默降级为主链路照常执行（与 monitoring.ts 同约定）。
 * - 存储：进程内环形缓冲（默认 500 条链路），多实例各存各的；观测数据丢失可接受，
 *   故登记为 local-accel（正确性不依赖跨实例共享）。完整链路明细以结构化日志为准。
 *
 * 环境变量：
 * - TRACE_ENABLED=1|0       总开关（默认 1；置 0 后 withSpan 直通，零额外开销）
 * - TRACE_SAMPLE_RATE=0~1   根链路采样率（默认 1；生产高流量可下调，未采样的链路不记 span 但仍生成 traceId 供日志关联）
 * - TRACE_BUFFER_SIZE=500   环形缓冲保留的链路条数（50~5000）
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type express from 'express';

// ---------- 类型 ----------

export type SpanStatus = 'ok' | 'error';

export type SpanAttributeValue = string | number | boolean;

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** 语义命名：http.request / llm.call / sql.execute / memory.recall 等 */
  name: string;
  /** 层级深度（0 = 根 span），前端据此缩进渲染树；同起点 span 亦按此排序 */
  depth: number;
  /** epoch 毫秒（便于与日志 ts 对齐）；对外快照同时给出相对偏移 */
  startMs: number;
  durationMs: number;
  status: SpanStatus;
  attributes: Record<string, SpanAttributeValue>;
}

export interface TraceSnapshot {
  traceId: string;
  requestId?: string;
  userId?: number;
  method?: string;
  route?: string;
  statusCode?: number;
  startMs: number;
  durationMs: number;
  spanCount: number;
  /** 是否命中采样（未采样链路只保留根 span 摘要） */
  sampled: boolean;
  spans: TraceSpan[];
}

interface SpanContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
  depth: number;
}

interface TraceBuffer {
  traceId: string;
  requestId?: string;
  userId?: number;
  method?: string;
  route?: string;
  statusCode?: number;
  startMs: number;
  durationMs: number;
  sampled: boolean;
  spans: TraceSpan[];
}

// ---------- 配置（惰性读取：settings 面板变更重启生效） ----------

function traceEnabled(): boolean {
  return (process.env.TRACE_ENABLED ?? '1').trim() !== '0';
}

function sampleRate(): number {
  const raw = Number(process.env.TRACE_SAMPLE_RATE ?? '1');
  if (!Number.isFinite(raw)) return 1;
  return Math.min(1, Math.max(0, raw));
}

function bufferSize(): number {
  const raw = Number(process.env.TRACE_BUFFER_SIZE ?? '500');
  if (!Number.isFinite(raw) || raw < 50) return 500;
  return Math.min(5000, Math.floor(raw));
}

// ---------- 上下文 ----------

const storage = new AsyncLocalStorage<SpanContext>();

/** 读取当前 span 上下文（无追踪上下文时 undefined） */
export function getTraceContext(): SpanContext | undefined {
  return storage.getStore();
}

/** 当前链路 id（供日志/响应头使用；无上下文时 undefined） */
export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

// ---------- ID 与 W3C traceparent ----------

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function newTraceId(): string {
  return hex(16); // 32 hex
}

export function newSpanId(): string {
  return hex(8); // 16 hex
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export interface ParsedTraceparent {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

/**
 * 解析 W3C traceparent 头；格式非法或全零 id 返回 null（调用方回退为新链路）。
 * 格式：version(2)-traceId(32)-parentSpanId(16)-flags(2)，如 00-4bf9...-00f0...-01
 */
export function parseTraceparent(header: string | undefined | null): ParsedTraceparent | null {
  if (!header) return null;
  const m = TRACEPARENT_RE.exec(header.trim());
  if (!m) return null;
  const [, version, traceId, parentSpanId, flags] = m;
  if (version === 'ff') return null; // 规范保留值
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return null;
  return { traceId: traceId.toLowerCase(), parentSpanId: parentSpanId.toLowerCase(), sampled: (parseInt(flags, 16) & 0x01) === 1 };
}

/** 构造出站 traceparent 头（当前链路 + 本端 spanId），供未来跨服务调用透传 */
export function buildTraceparent(spanId = getTraceContext()?.spanId): string | undefined {
  const ctx = getTraceContext();
  if (!ctx) return undefined;
  const flags = ctx.sampled ? '01' : '00';
  return `00-${ctx.traceId}-${spanId ?? newSpanId()}-${flags}`;
}

// ---------- 环形缓冲 ----------

/** traceId → 链路缓冲（Map 插入序即时间序，超容量淘汰最旧） */
const traces = new Map<string, TraceBuffer>();

function traceById(traceId: string): TraceBuffer | undefined {
  return traces.get(traceId);
}

function ensureTrace(traceId: string, sampled: boolean, startMs: number): TraceBuffer {
  const existing = traces.get(traceId);
  if (existing) return existing;
  const created: TraceBuffer = { traceId, startMs, durationMs: 0, sampled, spans: [] };
  traces.set(traceId, created);
  // 淘汰最旧：Map 迭代顺序 = 插入顺序
  while (traces.size > bufferSize()) {
    const oldest = traces.keys().next().value;
    if (oldest === undefined) break;
    traces.delete(oldest);
  }
  return created;
}

/** 结束一条 span 并挂到对应链路（无上下文时忽略） */
function pushSpan(span: TraceSpan, ctx: SpanContext): void {
  try {
    if (!ctx.sampled) return;
    const buf = ensureTrace(ctx.traceId, ctx.sampled, span.startMs);
    buf.spans.push(span);
    const endMs = span.startMs + span.durationMs;
    buf.startMs = Math.min(buf.startMs, span.startMs);
    buf.durationMs = Math.max(buf.durationMs, endMs - buf.startMs);
  } catch {
    /* 观测失败静默 */
  }
}

// ---------- span 记录 ----------

/**
 * 执行 fn 并记录一条 span（支持嵌套：父 span 由 AsyncLocalStorage 自动关联）。
 * 无追踪上下文时自成一条链路（后台任务/定时器场景）。
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T> | T,
  attributes: Record<string, SpanAttributeValue> = {}
): Promise<T> {
  const parent = storage.getStore();
  if (!traceEnabled()) return fn();

  const ctx: SpanContext = parent
    ? { traceId: parent.traceId, spanId: newSpanId(), sampled: parent.sampled, depth: parent.depth + 1 }
    : { traceId: newTraceId(), spanId: newSpanId(), sampled: Math.random() < sampleRate(), depth: 0 };

  const startedAt = Date.now();
  let status: SpanStatus = 'ok';
  const attrs: Record<string, SpanAttributeValue> = { ...attributes };

  try {
    const result = await storage.run(ctx, async () => fn());
    return result;
  } catch (err) {
    status = 'error';
    attrs['error.message'] = String((err as Error)?.message || err).slice(0, 300);
    throw err;
  } finally {
    pushSpan(
      {
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        parentSpanId: parent?.spanId,
        name,
        depth: ctx.depth,
        startMs: startedAt,
        durationMs: Date.now() - startedAt,
        status,
        attributes: attrs,
      },
      ctx
    );
  }
}

/**
 * 补录一条已结束的 span（调用方已持有耗时，如 LLM/记忆召回的既有旁路埋点）。
 * 与 withSpan 的区别：不建立子上下文，只做时间轴记账；无链路上下文时降级为独立链路。
 */
export function recordSpan(
  name: string,
  durationMs: number,
  status: SpanStatus,
  attributes: Record<string, SpanAttributeValue> = {}
): void {
  try {
    if (!traceEnabled()) return;
    const parent = storage.getStore();
    const ctx: SpanContext = parent ?? {
      traceId: newTraceId(),
      spanId: newSpanId(),
      sampled: Math.random() < sampleRate(),
      depth: 0,
    };
    const endMs = Date.now();
    pushSpan(
      {
        traceId: ctx.traceId,
        spanId: newSpanId(),
        parentSpanId: parent?.spanId,
        name,
        depth: parent ? parent.depth + 1 : 0,
        startMs: Math.max(0, endMs - Math.max(0, durationMs)),
        durationMs: Math.max(0, durationMs),
        status,
        attributes,
      },
      ctx
    );
  } catch {
    /* 观测失败静默 */
  }
}

// ---------- HTTP 根 span ----------

export interface TraceHttpMeta {
  requestId?: string;
  userId?: number;
  method: string;
  route: string;
  statusCode: number;
  /** 入站 traceparent（上游链路透传；缺省则新建链路） */
  traceparent?: string;
}

/**
 * 建立请求根上下文：解析上游 traceparent（沿用 traceId）或新开链路，
 * 在 AsyncLocalStorage 中运行 next()，使整条处理链可被 withSpan/recordSpan 关联。
 * 返回的 ctx 供 finish 时补写根 span 元信息。
 */
export function startRequestTrace(meta: { traceparent?: string }): {
  ctx: SpanContext;
  run: (fn: () => void) => void;
} {
  const parsed = parseTraceparent(meta.traceparent);
  const ctx: SpanContext = {
    traceId: parsed?.traceId ?? newTraceId(),
    // 根 span 使用新 spanId（上游 spanId 作为 parentSpanId 记录，保持调用树完整）
    spanId: newSpanId(),
    sampled: parsed ? parsed.sampled && Math.random() < sampleRate() : Math.random() < sampleRate(),
    depth: 0,
  };
  return { ctx, run: (fn) => storage.run(ctx, fn) };
}

/**
 * Express 中间件：为 /api/* 请求建立根 span（静态资源不追踪，避免开发态 Vite 资源刷爆缓冲）。
 * 须位于 requestLogger 之后（复用其 requestId），鉴权之前（被拒请求同样留链路）。
 */
export function traceMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!traceEnabled() || !req.path.startsWith('/api/')) {
    next();
    return;
  }
  const startedAt = Date.now();
  const inbound = req.get('traceparent') || undefined;
  const { ctx, run } = startRequestTrace({ traceparent: inbound });
  // 回写本端链路标识：下游服务/前端报错可据此关联瀑布
  try {
    res.setHeader('traceparent', `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? '01' : '00'}`);
  } catch { /* 响应头已发出等异常场景静默 */ }

  res.on('finish', () => {
    // req.route 由 Express 路由层在匹配后挂载；无匹配（404/中间件短路）回退实际路径
    const routePath = typeof req.route?.path === 'string' ? req.route.path : '';
    finishRequestTrace(ctx, {
      requestId: req.requestId,
      userId: req.user?.id,
      method: req.method,
      route: (req.baseUrl || '') + routePath || req.path,
      statusCode: res.statusCode,
      traceparent: inbound,
      startMs: startedAt,
      durationMs: Date.now() - startedAt,
    });
  });

  run(next);
}

/** 请求结束：写根 span 摘要（含 requestId/路由/状态码），供 /api/ops/traces 查询 */
export function finishRequestTrace(
  ctx: SpanContext,
  meta: TraceHttpMeta & { startMs: number; durationMs: number; parentSpanId?: string }
): void {
  try {
    if (!traceEnabled()) return;
    const parsed = parseTraceparent(meta.traceparent);
    pushSpan(
      {
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        parentSpanId: parsed?.parentSpanId,
        name: 'http.request',
        depth: 0,
        startMs: meta.startMs,
        durationMs: Math.max(0, meta.durationMs),
        status: meta.statusCode >= 500 ? 'error' : 'ok',
        attributes: {
          'http.method': meta.method,
          'http.route': meta.route,
          'http.status_code': meta.statusCode,
        },
      },
      ctx
    );
    const buf = traceById(ctx.traceId);
    if (buf) {
      if (meta.requestId) buf.requestId = meta.requestId;
      if (meta.userId !== undefined) buf.userId = meta.userId;
      buf.method = meta.method;
      buf.route = meta.route;
      buf.statusCode = meta.statusCode;
    }
  } catch {
    /* 观测失败静默 */
  }
}

// ---------- 查询（供路由与测试） ----------

/** 最近 N 条链路摘要（按开始时间倒序，不含 spans 明细） */
export function listTraces(limit = 50): Omit<TraceSnapshot, 'spans'>[] {
  const n = Math.min(500, Math.max(1, Math.floor(limit) || 50));
  return Array.from(traces.values())
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, n)
    .map((t) => ({
      traceId: t.traceId,
      requestId: t.requestId,
      userId: t.userId,
      method: t.method,
      route: t.route,
      statusCode: t.statusCode,
      startMs: t.startMs,
      durationMs: t.durationMs,
      spanCount: t.spans.length,
      sampled: t.sampled,
    }));
}

/** 单条链路瀑布（spans 按开始时间升序，同起点按耗时降序） */
export function getTrace(traceId: string): TraceSnapshot | undefined {
  const t = traces.get(traceId);
  if (!t) return undefined;
  return {
    traceId: t.traceId,
    requestId: t.requestId,
    userId: t.userId,
    method: t.method,
    route: t.route,
    statusCode: t.statusCode,
    startMs: t.startMs,
    durationMs: t.durationMs,
    spanCount: t.spans.length,
    sampled: t.sampled,
    spans: [...t.spans].sort((a, b) => a.startMs - b.startMs || a.depth - b.depth || b.durationMs - a.durationMs),
  };
}

/** 清空缓冲（仅测试使用） */
export function clearTraces(): void {
  traces.clear();
}
