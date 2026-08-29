/**
 * P2-5 SSE 会话韧性（企业级改进计划 2-5）：问数流式事件重放缓冲。
 * 流式过程中客户端断网/断连时，服务端 LLM 链路仍继续执行并把事件写入本缓冲；
 * 客户端凭 traceId + 已收事件序号（Last-Event-ID 语义）经专用端点续传，
 * 已完成阶段即时回放、不重新执行 SQL。
 *
 * 单机进程内实现（local-accel）：多实例部署重连到不同实例时缓冲未命中，
 * 端点返回 404 由前端降级为完整重试；部署指南建议网关开启粘性会话。
 */
export interface BufferedSseEvent {
  /** 从 1 递增的事件序号（SSE id 字段） */
  seq: number;
  event: string;
  data: string;
}

interface TraceBuffer {
  userId: number;
  events: BufferedSseEvent[];
  /** 终态事件（done/clarify/refuse/error）的序号；0=进行中 */
  terminalSeq: number;
  /** 终态到达时间（TTL 清扫依据）；进行中为创建时间 */
  touchedAt: number;
  listeners: Set<(e: BufferedSseEvent) => void>;
}

/** 终态事件集合：到达后该 traceId 不再产生新事件 */
const TERMINAL_EVENTS = new Set(['done', 'clarify', 'refuse', 'error']);
/** 终态后保留 10 分钟供断线重连回放；进行中的缓冲最长保留 30 分钟（异常泄漏兜底） */
const TERMINAL_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 30 * 60 * 1000;
/** 单 trace 事件上限（异常刷屏兜底，正常链路 <100 条） */
const MAX_EVENTS_PER_TRACE = 500;

const buffers = new Map<string, TraceBuffer>();

export function clearSseReplayBuffersForTest(): void {
  buffers.clear();
}

/** 追加事件并返回分配的序号；同一 traceId 的序号从 1 单调递增 */
export function appendQueryEvent(traceId: string, userId: number, event: string, data: string): number {
  let buf = buffers.get(traceId);
  if (!buf) {
    buf = { userId, events: [], terminalSeq: 0, touchedAt: Date.now(), listeners: new Set() };
    buffers.set(traceId, buf);
  }
  // 终态后不再接受新事件（防御重复调用）
  if (buf.terminalSeq > 0) return buf.terminalSeq;
  const entry: BufferedSseEvent = { seq: buf.events.length + 1, event, data };
  if (buf.events.length < MAX_EVENTS_PER_TRACE) {
    buf.events.push(entry);
  }
  if (TERMINAL_EVENTS.has(event)) {
    buf.terminalSeq = entry.seq;
  }
  buf.touchedAt = Date.now();
  for (const listener of buf.listeners) {
    try {
      listener(entry);
    } catch {
      // 监听器异常不影响主链路
    }
  }
  return entry.seq;
}

export interface ReplaySlice {
  userId: number;
  events: BufferedSseEvent[];
  /** true 表示终态事件已在本切片（或之前）到达 */
  terminal: boolean;
}

/** 读取 seq > afterSeq 的存量事件；未知 traceId 返回 null。terminal=true 表示终态已到达（回放完即可关闭） */
export function getEventsAfter(traceId: string, afterSeq: number): ReplaySlice | null {
  const buf = buffers.get(traceId);
  if (!buf) return null;
  return {
    userId: buf.userId,
    events: buf.events.filter((e) => e.seq > afterSeq),
    terminal: buf.terminalSeq > 0,
  };
}

/** 校验 traceId 归属（本人或 ADMIN 可续传） */
export function getTraceOwner(traceId: string): number | null {
  return buffers.get(traceId)?.userId ?? null;
}

/** 是否已到达终态 */
export function isTerminal(traceId: string): boolean {
  return (buffers.get(traceId)?.terminalSeq ?? 0) > 0;
}

/** 终态事件判定（done/clarify/refuse/error） */
export function isTerminalEvent(event: string): boolean {
  return TERMINAL_EVENTS.has(event);
}

/** 订阅增量事件（续传端点回放存量后挂接）；返回退订函数 */
export function subscribeTrace(traceId: string, listener: (e: BufferedSseEvent) => void): () => void {
  const buf = buffers.get(traceId);
  if (!buf) return () => undefined;
  buf.listeners.add(listener);
  return () => {
    buf.listeners.delete(listener);
  };
}

/** 清扫过期缓冲（终态 10 分钟 / 进行中 30 分钟） */
export function sweepSseReplayBuffers(now = Date.now()): number {
  let swept = 0;
  for (const [traceId, buf] of buffers) {
    const ttl = buf.terminalSeq > 0 ? TERMINAL_TTL_MS : PENDING_TTL_MS;
    if (now - buf.touchedAt > ttl) {
      buffers.delete(traceId);
      swept++;
    }
  }
  return swept;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** 启动周期性清扫（服务启动时调用一次，unref 不阻塞退出） */
export function startSseReplaySweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepSseReplayBuffers(), 60 * 1000);
  sweepTimer.unref?.();
}
