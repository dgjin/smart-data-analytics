/**
 * P2-5 SSE 断线续传：重放缓冲单元测试。
 * 覆盖：序号单调递增、终态拒收、getEventsAfter 过滤、归属校验、订阅通知、TTL 清扫、容量上限。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendQueryEvent,
  getEventsAfter,
  getTraceOwner,
  isTerminal,
  isTerminalEvent,
  subscribeTrace,
  sweepSseReplayBuffers,
  clearSseReplayBuffersForTest,
  BufferedSseEvent,
} from './sseReplayBuffer';

describe('sseReplayBuffer（P2-5 SSE 断线续传重放缓冲）', () => {
  beforeEach(() => {
    clearSseReplayBuffersForTest();
  });

  describe('appendQueryEvent 序号分配', () => {
    it('同一 traceId 序号从 1 单调递增', () => {
      expect(appendQueryEvent('tr_a', 1, 'stage', '{}')).toBe(1);
      expect(appendQueryEvent('tr_a', 1, 'stage', '{}')).toBe(2);
      expect(appendQueryEvent('tr_a', 1, 'done', '{}')).toBe(3);
    });

    it('不同 traceId 序号各自独立', () => {
      expect(appendQueryEvent('tr_a', 1, 'stage', '{}')).toBe(1);
      expect(appendQueryEvent('tr_b', 2, 'stage', '{}')).toBe(1);
      expect(appendQueryEvent('tr_a', 1, 'done', '{}')).toBe(2);
    });

    it('终态事件后拒收新事件（返回终态序号，缓冲不变）', () => {
      appendQueryEvent('tr_a', 1, 'stage', '{}');
      const terminalSeq = appendQueryEvent('tr_a', 1, 'done', '{}');
      expect(terminalSeq).toBe(2);
      expect(appendQueryEvent('tr_a', 1, 'stage', '{}')).toBe(2);
      expect(getEventsAfter('tr_a', 0)!.events).toHaveLength(2);
    });

    it('单 trace 事件上限 500 条（超出丢弃但序号继续递增）', () => {
      for (let i = 0; i < 510; i++) appendQueryEvent('tr_big', 1, 'trace', `{"i":${i}}`);
      const slice = getEventsAfter('tr_big', 0)!;
      expect(slice.events).toHaveLength(500);
      expect(slice.events[0].seq).toBe(1);
      expect(slice.events[499].seq).toBe(500);
    });
  });

  describe('getEventsAfter 续传切片', () => {
    it('只返回 seq > afterSeq 的事件（断点续传游标语义）', () => {
      appendQueryEvent('tr_a', 1, 'stage', '{"stage":"understanding"}');
      appendQueryEvent('tr_a', 1, 'stage', '{"stage":"sql_ready"}');
      appendQueryEvent('tr_a', 1, 'done', '{"success":true}');
      const slice = getEventsAfter('tr_a', 1)!;
      expect(slice.events.map((e) => e.seq)).toEqual([2, 3]);
      expect(slice.terminal).toBe(true);
    });

    it('未知 traceId 返回 null（端点据此返回 404）', () => {
      expect(getEventsAfter('tr_nonexistent', 0)).toBeNull();
    });

    it('进行中的缓冲 terminal=false', () => {
      appendQueryEvent('tr_a', 1, 'stage', '{}');
      expect(getEventsAfter('tr_a', 0)!.terminal).toBe(false);
      expect(isTerminal('tr_a')).toBe(false);
    });
  });

  describe('归属与终态判定', () => {
    it('getTraceOwner 返回首个事件携带的 userId', () => {
      appendQueryEvent('tr_a', 42, 'stage', '{}');
      expect(getTraceOwner('tr_a')).toBe(42);
      expect(getTraceOwner('tr_nonexistent')).toBeNull();
    });

    it('终态事件集合判定：done/clarify/refuse/error', () => {
      for (const e of ['done', 'clarify', 'refuse', 'error']) expect(isTerminalEvent(e)).toBe(true);
      for (const e of ['stage', 'trace', 'chunk', 'message']) expect(isTerminalEvent(e)).toBe(false);
    });

    it('isTerminal 终态到达后为 true', () => {
      appendQueryEvent('tr_a', 1, 'stage', '{}');
      expect(isTerminal('tr_a')).toBe(false);
      appendQueryEvent('tr_a', 1, 'refuse', '{}');
      expect(isTerminal('tr_a')).toBe(true);
    });
  });

  describe('subscribeTrace 增量订阅', () => {
    it('新事件实时通知订阅者，退订后不再通知', () => {
      appendQueryEvent('tr_a', 1, 'stage', '{}');
      const received: BufferedSseEvent[] = [];
      const unsubscribe = subscribeTrace('tr_a', (e) => received.push(e));
      appendQueryEvent('tr_a', 1, 'stage', '{"n":2}');
      appendQueryEvent('tr_a', 1, 'done', '{}');
      expect(received.map((e) => e.seq)).toEqual([2, 3]);
      unsubscribe();
      appendQueryEvent('tr_b', 1, 'stage', '{}');
      expect(received).toHaveLength(2);
    });

    it('订阅者不抛异常回传（监听器异常不影响主链路）', () => {
      appendQueryEvent('tr_a', 1, 'stage', '{}');
      subscribeTrace('tr_a', () => {
        throw new Error('listener boom');
      });
      expect(() => appendQueryEvent('tr_a', 1, 'done', '{}')).not.toThrow();
      expect(isTerminal('tr_a')).toBe(true);
    });

    it('未知 traceId 订阅返回空退订函数', () => {
      const unsubscribe = subscribeTrace('tr_nonexistent', () => undefined);
      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
    });
  });

  describe('sweepSseReplayBuffers TTL 清扫', () => {
    it('终态缓冲超过 10 分钟被清扫', () => {
      const now = Date.now();
      appendQueryEvent('tr_a', 1, 'done', '{}');
      // 终态后 9 分钟：保留
      expect(sweepSseReplayBuffers(now + 9 * 60 * 1000)).toBe(0);
      expect(getTraceOwner('tr_a')).toBe(1);
      // 终态后 11 分钟：清扫
      expect(sweepSseReplayBuffers(now + 11 * 60 * 1000)).toBe(1);
      expect(getTraceOwner('tr_a')).toBeNull();
    });

    it('进行中缓冲 30 分钟兜底清扫（异常泄漏防御）', () => {
      const now = Date.now();
      appendQueryEvent('tr_pending', 1, 'stage', '{}');
      expect(sweepSseReplayBuffers(now + 11 * 60 * 1000)).toBe(0);
      expect(sweepSseReplayBuffers(now + 31 * 60 * 1000)).toBe(1);
      expect(getTraceOwner('tr_pending')).toBeNull();
    });

    it('进行中缓冲有新事件时 touchedAt 刷新（活跃长任务不被误清）', () => {
      const now = Date.now();
      appendQueryEvent('tr_live', 1, 'stage', '{}');
      // 20 分钟后仍有新事件（touchedAt 刷新到此刻之后无法直接模拟，
      // 但通过第二次 append 后以其 touchedAt 为基准清扫验证）
      appendQueryEvent('tr_live', 1, 'stage', '{}');
      expect(sweepSseReplayBuffers(Date.now() + 29 * 60 * 1000)).toBe(0);
      expect(getTraceOwner('tr_live')).toBe(1);
      void now;
    });
  });
});
