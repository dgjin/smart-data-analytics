import { describe, expect, it } from 'vitest';
import { approxTokens, budgetText, budgetHistory, KNOWLEDGE_TOKEN_BUDGET } from './promptBudget';

describe('promptBudget: token 预算控制', () => {
  it('approxTokens 对中文按字符保守估算', () => {
    expect(approxTokens('你好世界')).toBe(3);
    expect(approxTokens('')).toBe(0);
  });

  it('budgetText 在预算内原样返回', () => {
    expect(budgetText('短文本', 100)).toBe('短文本');
  });

  it('budgetText 超预算时按字符截断', () => {
    const long = '知'.repeat(5000);
    const out = budgetText(long, KNOWLEDGE_TOKEN_BUDGET);
    expect(approxTokens(out)).toBeLessThanOrEqual(KNOWLEDGE_TOKEN_BUDGET);
    expect(out.length).toBeLessThan(long.length);
  });

  it('budgetHistory 从最新往前贪心保留且不破坏顺序', () => {
    const msgs = [
      { content: '旧'.repeat(900) },
      { content: '较新' },
      { content: '最新' },
    ];
    const kept = budgetHistory(msgs, 10);
    expect(kept[kept.length - 1].content).toBe('最新');
    expect(kept.map((m) => m.content)).toEqual(kept.map((m) => m.content));
    // 第一条超长消息应被挤出
    expect(kept.some((m) => m.content.startsWith('旧'))).toBe(false);
  });

  it('budgetHistory 空数组安全返回', () => {
    expect(budgetHistory([], 10)).toEqual([]);
  });
});
