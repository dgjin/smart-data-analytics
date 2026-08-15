/**
 * P1-3 行级权限单元测试：谓词结构清洗、scope 持久化清洗、tableId→实际表名映射。
 */
import { describe, it, expect } from 'vitest';
import { sanitizeRowFilterPredicate, sanitizeDataScope, rowFiltersByTableName, applyDataScope } from './scope';

const TABLES = [
  { id: 'tbl_clients', name: 'clients', columns: [{ name: 'id' }, { name: 'region' }] },
  { id: 'tbl_visits', name: 'visits', columns: [{ name: 'id' }, { name: 'type' }] },
];

describe('sanitizeRowFilterPredicate: 谓词结构防线', () => {
  it('放行常规比较/逻辑谓词', () => {
    expect(sanitizeRowFilterPredicate("region = '华东'")).toBe("region = '华东'");
    expect(sanitizeRowFilterPredicate('status = 1 AND id > 10')).toBe('status = 1 AND id > 10');
  });

  it('拒绝多语句/注释/子查询/INTO', () => {
    expect(sanitizeRowFilterPredicate('id = 1; DROP TABLE clients')).toBeNull();
    expect(sanitizeRowFilterPredicate('id = 1 -- x')).toBeNull();
    expect(sanitizeRowFilterPredicate('id IN (SELECT id FROM users)')).toBeNull();
    expect(sanitizeRowFilterPredicate('1=1 INTO OUTFILE "/tmp/x"')).toBeNull();
  });

  it('拒绝非字符串/空/超长', () => {
    expect(sanitizeRowFilterPredicate(123)).toBeNull();
    expect(sanitizeRowFilterPredicate('   ')).toBeNull();
    expect(sanitizeRowFilterPredicate('x'.repeat(301))).toBeNull();
  });
});

describe('sanitizeDataScope: rowFilters 清洗', () => {
  it('保留合法谓词并剔除不存在表的谓词', () => {
    const scope = sanitizeDataScope(TABLES, {
      tables: ['tbl_clients'],
      rowFilters: { tbl_clients: "region = '华东'", tbl_ghost: 'id = 1' },
    });
    expect(scope?.rowFilters).toEqual({ tbl_clients: "region = '华东'" });
  });

  it('非法谓词被剔除；全部无效时 rowFilters 不落盘', () => {
    const scope = sanitizeDataScope(TABLES, {
      tables: ['tbl_clients'],
      rowFilters: { tbl_clients: 'id = 1; DROP TABLE x' },
    });
    expect(scope?.rowFilters).toBeUndefined();
  });

  it('仅 rowFilters 有效（无 tables 限制）也构成有效 scope', () => {
    const scope = sanitizeDataScope(TABLES, { tables: [], rowFilters: { tbl_visits: "type = '电话'" } });
    expect(scope?.rowFilters).toEqual({ tbl_visits: "type = '电话'" });
  });
});

describe('rowFiltersByTableName: tableId → 实际表名映射', () => {
  it('只对 scope 过滤后可见表生成映射', () => {
    const scoped = applyDataScope(TABLES, { tables: ['tbl_clients'] });
    const scope = { tables: ['tbl_clients'], rowFilters: { tbl_clients: 'id > 0', tbl_visits: 'id > 0' } };
    expect(rowFiltersByTableName(scoped, scope)).toEqual({ clients: 'id > 0' });
  });

  it('scope 为空或无 rowFilters 时返回空对象', () => {
    expect(rowFiltersByTableName(TABLES, null)).toEqual({});
    expect(rowFiltersByTableName(TABLES, { tables: [] })).toEqual({});
  });
});
