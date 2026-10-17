import { afterEach, describe, expect, it } from 'vitest';
import {
  confidenceDeltaForVerdict,
  decayFactor,
  errorTypeLabel,
  fusionScore,
  initialConfidenceForApproval,
  isMemoryStatus,
  normalizeErrorType,
  sourceWeight,
} from './governance';

const DAY = 86400000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString();
}

describe('governance: 来源权重与融合分', () => {
  it('来源权重满足 纠错 > 权威知识/指标 > 样例 > 外部 > 反例 > 个人沉淀', () => {
    expect(sourceWeight('CORRECTION')).toBeGreaterThan(sourceWeight('IRON'));
    expect(sourceWeight('IRON')).toBe(sourceWeight('KNOWLEDGE'));
    expect(sourceWeight('EXAMPLE')).toBeLessThan(sourceWeight('KNOWLEDGE'));
    expect(sourceWeight('EXTERNAL')).toBeLessThan(sourceWeight('EXAMPLE'));
    expect(sourceWeight('NEGATIVE')).toBeLessThan(sourceWeight('EXTERNAL'));
    expect(sourceWeight('CONVERSATION')).toBeLessThan(sourceWeight('NEGATIVE'));
  });

  it('同样相关度/置信度下，新条目融合分高于旧条目', () => {
    const fresh = fusionScore('CORRECTION', 0.9, 0.9, daysAgo(1));
    const old = fusionScore('CORRECTION', 0.9, 0.9, daysAgo(400));
    expect(fresh).toBeGreaterThan(old);
  });

  it('createdAt 缺失不衰减（按 1 处理）', () => {
    expect(decayFactor(null, 'CORRECTION')).toBe(1);
    expect(decayFactor('not-a-date', 'CORRECTION')).toBe(1);
  });

  it('衰减到半衰期时约为 0.5（纠错系数 1.5，半衰期 120 天 → 180 天）', () => {
    const d = decayFactor(daysAgo(180), 'CORRECTION');
    expect(d).toBeGreaterThan(0.45);
    expect(d).toBeLessThanOrEqual(0.55);
  });
});

describe('governance: 置信度与校验', () => {
  it('点赞 +0.05、点踩 -0.20', () => {
    expect(confidenceDeltaForVerdict('UP')).toBeCloseTo(0.05);
    expect(confidenceDeltaForVerdict('DOWN')).toBeCloseTo(-0.2);
  });

  it('审核初始置信度：期望 SQL=1.0，管理员确认=0.9，普通用户=0.4', () => {
    expect(initialConfidenceForApproval({ expectedSql: 'SELECT 1', approvedByAdmin: true })).toBe(1);
    expect(initialConfidenceForApproval({ approvedByAdmin: true })).toBe(0.9);
    expect(initialConfidenceForApproval({ approvedByAdmin: false })).toBe(0.4);
  });

  it('错误类型归一化与中文标签', () => {
    expect(normalizeErrorType('caliber')).toBe('CALIBER');
    expect(normalizeErrorType('unknown')).toBe('OTHER');
    expect(errorTypeLabel('TABLE_CHOICE')).toBe('选表错误');
    expect(errorTypeLabel('CALIBER')).toContain('口径');
  });

  it('状态白名单', () => {
    expect(isMemoryStatus('ACTIVE')).toBe(true);
    expect(isMemoryStatus('ARCHIVED')).toBe(true);
    expect(isMemoryStatus('DELETED')).toBe(false);
  });
});

afterEach(() => {
  delete process.env.MEMORY_HALF_LIFE_DAYS;
});
