import { describe, expect, it } from 'vitest';
import { parseClarification } from './liveQuery';

describe('parseClarification: 歧义澄清契约解析', () => {
  it('合法澄清输出解析为结构化对象', () => {
    const text = JSON.stringify({
      needClarification: true,
      clarification: {
        question: '「人员」指哪个字段？',
        options: [
          { label: '拜访人', query: '按拜访人统计客户拜访记录数量' },
          { label: '客户负责人', query: '按客户负责人统计客户拜访记录数量' },
        ],
      },
    });
    const out = parseClarification(text);
    expect(out).not.toBeNull();
    expect(out!.question).toBe('「人员」指哪个字段？');
    expect(out!.options).toHaveLength(2);
    expect(out!.options[0].label).toBe('拜访人');
    expect(out!.options[1].query).toContain('客户负责人');
  });

  it('needClarification 非 true 返回 null（走 SQL 契约）', () => {
    expect(parseClarification(JSON.stringify({ needClarification: false, clarification: { question: 'q', options: [{ label: 'a', query: 'b' }] } }))).toBeNull();
    expect(parseClarification(JSON.stringify({ sql: 'SELECT 1' }))).toBeNull();
  });

  it('question 为空或 options 缺失返回 null', () => {
    expect(parseClarification(JSON.stringify({ needClarification: true, clarification: { question: '', options: [{ label: 'a', query: 'b' }] } }))).toBeNull();
    expect(parseClarification(JSON.stringify({ needClarification: true, clarification: { question: 'q' } }))).toBeNull();
  });

  it('全部选项非法（缺 query）返回 null', () => {
    const text = JSON.stringify({
      needClarification: true,
      clarification: { question: 'q', options: [{ label: '只有标签' }, { label: '', query: '' }] },
    });
    expect(parseClarification(text)).toBeNull();
  });

  it('选项上限 4 个，非法选项被过滤', () => {
    const options = [1, 'x', { label: 'a', query: 'qa' }, { label: 'b', query: 'qb' }, { label: 'c', query: 'qc' }, { label: 'd', query: 'qd' }, { label: 'e', query: 'qe' }];
    const out = parseClarification(JSON.stringify({ needClarification: true, clarification: { question: 'q', options } }));
    expect(out).not.toBeNull();
    expect(out!.options).toHaveLength(4);
    expect(out!.options.map((o) => o.label)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('非法 JSON 返回 null', () => {
    expect(parseClarification('不是 JSON')).toBeNull();
    expect(parseClarification('')).toBeNull();
  });
});
