/**
 * P0-4 北极星指标聚合纯函数单测：computeNorthStar / buildDailyTrend / toWeeklyTrend。
 */
import { describe, it, expect } from 'vitest';
import {
  computeNorthStar,
  buildDailyTrend,
  toWeeklyTrend,
  DailyCountRow,
  DailyTraceRow,
} from './opsMetrics';

const audit = (date: string, bucket: string, cnt: number): DailyCountRow => ({ date, bucket, cnt });

describe('computeNorthStar', () => {
  it('十态聚合：成功率/缓存命中率/澄清率/拒答率/降级率/拒绝拦截率正确', () => {
    const auditRows: DailyCountRow[] = [
      audit('2026-01-01', 'SUCCESS', 60),
      audit('2026-01-01', 'CACHE', 20),
      audit('2026-01-01', 'CLARIFY', 5),
      audit('2026-01-01', 'REFUSED', 5),
      audit('2026-01-01', 'FALLBACK', 4),
      audit('2026-01-01', 'ERROR', 2),
      audit('2026-01-02', 'DENIED_INPUT', 1),
      audit('2026-01-02', 'DENIED_AUTH', 1),
      audit('2026-01-02', 'DENIED_RATE', 1),
      audit('2026-01-02', 'DENIED_SWITCH', 1),
    ];
    const m = computeNorthStar(auditRows, [], [], 1234.6);
    expect(m.totalQueries).toBe(100);
    expect(m.answered).toBe(80);
    expect(m.successRate).toBeCloseTo(0.8);
    expect(m.cacheHitRate).toBeCloseTo(0.2);
    expect(m.clarifyRate).toBeCloseTo(0.05);
    expect(m.refuseRate).toBeCloseTo(0.05);
    expect(m.fallbackRate).toBeCloseTo(0.04);
    expect(m.errorRate).toBeCloseTo(0.02);
    expect(m.deniedRate).toBeCloseTo(0.04);
    expect(m.avgDurationMs).toBe(1235);
  });

  it('反馈：点赞率/点踩率按 UP+DOWN 为基数；无反馈时为 null', () => {
    const fb: DailyCountRow[] = [audit('2026-01-01', 'UP', 7), audit('2026-01-01', 'DOWN', 3)];
    const m = computeNorthStar([], fb, [], 0);
    expect(m.feedbackTotal).toBe(10);
    expect(m.upRate).toBeCloseTo(0.7);
    expect(m.downRate).toBeCloseTo(0.3);

    const empty = computeNorthStar([], [], [], 0);
    expect(empty.upRate).toBeNull();
    expect(empty.downRate).toBeNull();
    expect(empty.selfCorrectRate).toBeNull();
  });

  it('自纠错触发率：按留痕链路中 ≥2 次 SQL 生成的占比', () => {
    const traces: DailyTraceRow[] = [
      { date: '2026-01-01', traces: 8, selfCorrected: 2 },
      { date: '2026-01-02', traces: 2, selfCorrected: 0 },
    ];
    const m = computeNorthStar([], [], traces, 0);
    expect(m.tracedQueries).toBe(10);
    expect(m.selfCorrected).toBe(2);
    expect(m.selfCorrectRate).toBeCloseTo(0.2);
  });
});

describe('buildDailyTrend', () => {
  it('按日聚合且缺口日期补零（含今天），升序输出', () => {
    const today = new Date('2026-01-05T12:00:00');
    const auditRows: DailyCountRow[] = [
      audit('2026-01-03', 'SUCCESS', 3),
      audit('2026-01-03', 'CACHE', 1),
      audit('2026-01-05', 'CLARIFY', 2),
      audit('2026-01-05', 'DENIED_RATE', 1),
    ];
    const fb: DailyCountRow[] = [audit('2026-01-05', 'UP', 4)];
    const traces: DailyTraceRow[] = [{ date: '2026-01-03', traces: 2, selfCorrected: 1 }];
    const daily = buildDailyTrend(auditRows, fb, traces, 3, today);

    expect(daily.map((p) => p.date)).toEqual(['2026-01-03', '2026-01-04', '2026-01-05']);
    expect(daily[0]).toMatchObject({ total: 4, success: 3, cache: 1, traces: 2, selfCorrected: 1 });
    expect(daily[1].total).toBe(0); // 缺口补零
    expect(daily[2]).toMatchObject({ total: 3, clarify: 2, denied: 1, up: 4 });
  });
});

describe('toWeeklyTrend', () => {
  it('按周（周一起始）聚合：比率为周内合计再计算', () => {
    // 2026-01-05 是周一；01-04 属上一周（2025-12-29 起）
    const daily = [
      { date: '2026-01-04', total: 2, success: 1, cache: 1, clarify: 0, refused: 0, fallback: 0, error: 0, denied: 0, up: 1, down: 1, traces: 2, selfCorrected: 1 },
      { date: '2026-01-05', total: 6, success: 3, cache: 0, clarify: 2, refused: 1, fallback: 0, error: 0, denied: 0, up: 3, down: 0, traces: 4, selfCorrected: 1 },
      { date: '2026-01-06', total: 4, success: 2, cache: 1, clarify: 0, refused: 1, fallback: 0, error: 0, denied: 0, up: 0, down: 1, traces: 4, selfCorrected: 0 },
    ];
    const weekly = toWeeklyTrend(daily);
    expect(weekly.map((w) => w.week)).toEqual(['2025-12-29', '2026-01-05']);
    // 上一周：success+cache=2/2=1
    expect(weekly[0].successRate).toBeCloseTo(1);
    expect(weekly[0].upRate).toBeCloseTo(0.5);
    expect(weekly[0].selfCorrectRate).toBeCloseTo(0.5);
    // 本周：success+cache=6/10=0.6，clarify=2/10=0.2，refuse=2/10=0.2
    expect(weekly[1].total).toBe(10);
    expect(weekly[1].successRate).toBeCloseTo(0.6);
    expect(weekly[1].clarifyRate).toBeCloseTo(0.2);
    expect(weekly[1].refuseRate).toBeCloseTo(0.2);
    expect(weekly[1].upRate).toBeCloseTo(0.75);
    expect(weekly[1].selfCorrectRate).toBeCloseTo(1 / 8);
  });

  it('无数据周比率输出 null 而非 NaN', () => {
    const weekly = toWeeklyTrend([
      { date: '2026-01-05', total: 0, success: 0, cache: 0, clarify: 0, refused: 0, fallback: 0, error: 0, denied: 0, up: 0, down: 0, traces: 0, selfCorrected: 0 },
    ]);
    expect(weekly[0].successRate).toBeNull();
    expect(weekly[0].upRate).toBeNull();
  });
});
