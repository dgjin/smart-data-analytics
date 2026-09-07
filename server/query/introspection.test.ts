import { describe, expect, it } from 'vitest';
import { parseIntrospection, formatIntrospectionRows } from './liveQuery';
import { validateExampleInput } from './queryFeedback';

describe('parseIntrospection: 数据自省请求解析', () => {
  it('合法自省请求解析出 SQL 与说明', () => {
    const out = parseIntrospection(
      JSON.stringify({ needIntrospection: true, intermediateSql: 'SELECT DISTINCT visitor_name FROM visit_records LIMIT 30', note: '确认拜访人真实写法' })
    );
    expect(out).not.toBeNull();
    expect(out!.sql).toContain('SELECT DISTINCT');
    expect(out!.note).toBe('确认拜访人真实写法');
  });

  it('needIntrospection 非 true 返回 null', () => {
    expect(parseIntrospection(JSON.stringify({ needIntrospection: 'yes', intermediateSql: 'SELECT 1' }))).toBeNull();
  });

  it('非 SELECT 语句拒绝', () => {
    expect(parseIntrospection(JSON.stringify({ needIntrospection: true, intermediateSql: 'DELETE FROM t' }))).toBeNull();
  });

  it('intermediateSql 缺失或超长拒绝', () => {
    expect(parseIntrospection(JSON.stringify({ needIntrospection: true }))).toBeNull();
    expect(parseIntrospection(JSON.stringify({ needIntrospection: true, intermediateSql: `SELECT ${'x'.repeat(600)} FROM t` }))).toBeNull();
  });

  it('非法 JSON 返回 null', () => {
    expect(parseIntrospection('not-json')).toBeNull();
  });
});

describe('formatIntrospectionRows: 自省结果回喂格式', () => {
  it('最多保留 30 行并输出 JSON', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ name: `n${i}` }));
    const out = formatIntrospectionRows(rows);
    expect(JSON.parse(out)).toHaveLength(30);
  });
});

describe('validateExampleInput: SQL 样例校验', () => {
  it('合法样例通过', () => {
    expect(validateExampleInput({ question: '各客户类型数量', sql: 'SELECT type, COUNT(*) FROM customers GROUP BY type' })).toBeNull();
  });

  it('问题或 SQL 为空拒绝', () => {
    expect(validateExampleInput({ question: '', sql: 'SELECT 1' })).toContain('问题');
    expect(validateExampleInput({ question: '问题', sql: '  ' })).toContain('SQL');
  });

  it('非 SELECT 拒绝', () => {
    expect(validateExampleInput({ question: '问题', sql: 'UPDATE t SET a=1' })).toContain('SELECT');
  });
});
