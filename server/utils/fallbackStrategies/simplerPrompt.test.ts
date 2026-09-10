/**
 * Simpler Prompt 策略纯函数单测（v0.9.47 P0 回归）：
 * extractMinimalSchema 读真实 schema 字段（name / columns[].name，
 * 回归：原读 table_name/column_name 且按硬编码 KEY_TABLES 过滤 → 任何数据源都得到空 schema）。
 */
import { describe, expect, it, vi } from 'vitest';

// 依赖隔离：本文件只测纯函数，db / llm / logger 全部 mock（vi.mock 按 hoisted 生效）
vi.mock('../../infra/db', () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock('../../infra/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
vi.mock('../../llm/llmClient', () => ({ callLLMText: vi.fn() }));

import { extractMinimalSchema, buildSimplerPrompt } from './simplerPrompt';

describe('extractMinimalSchema', () => {
  it('按 name / columns[].name 提取（回归：原读 table_name 恒空）', () => {
    const schema = [
      { name: 'orders', columns: [{ name: 'id' }, { name: 'amount' }] },
      { name: 'customers', columns: [{ name: 'cid' }, { name: 'cname' }] },
    ];
    expect(extractMinimalSchema(schema)).toEqual([
      'orders: id, amount',
      'customers: cid, cname',
    ]);
  });

  it('超出表预算时截断，无 name 的表被过滤', () => {
    const schema: any[] = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, columns: [{ name: 'c' }] }));
    schema.push({ table_name: 'legacy-shape', columns: [] });
    expect(extractMinimalSchema(schema).length).toBe(8);
  });

  it('列数超出预算时截断到前 12 列', () => {
    const columns = Array.from({ length: 20 }, (_, i) => ({ name: `col_${i}` }));
    const [line] = extractMinimalSchema([{ name: 'wide_table', columns }]);
    expect(line!.split(', ').length).toBe(12);
  });
});

describe('buildSimplerPrompt', () => {
  it('few-shot 为空时不产生空段落，schema 与问题正确嵌入', () => {
    const p = buildSimplerPrompt('上月销售额', ['sales: amount, month'], '');
    expect(p).not.toContain('undefined');
    expect(p).toContain('【数据库结构（简化版）】');
    expect(p).toContain('sales: amount, month');
    expect(p).toContain('上月销售额');
  });

  it('few-shot 存在时嵌入示例段', () => {
    const p = buildSimplerPrompt('q', ['t: c'], '【Few-Shot 示例】\nQ: "x"\nA: SELECT 1');
    expect(p).toContain('【Few-Shot 示例】');
  });
});
