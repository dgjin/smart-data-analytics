/**
 * P2-11 数据源访问控制（ACL）单元测试：解析/判定/清洗/授权并入。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  parseAcl,
  canAccessDataSource,
  sanitizeAcl,
  loadDataSourceAcl,
  checkDataSourceAccess,
  grantUserAccess,
} from './accessControl';
import { getPool } from './db';

vi.mock('./db', () => ({ getPool: vi.fn() }));

describe('parseAcl: acl_json 解析', () => {
  it('null/undefined/空串/非法 JSON → null（不限制）', () => {
    expect(parseAcl(null)).toBeNull();
    expect(parseAcl(undefined)).toBeNull();
    expect(parseAcl('')).toBeNull();
    expect(parseAcl('   ')).toBeNull();
    expect(parseAcl('{bad json')).toBeNull();
  });

  it('非对象结构（数组/数字/字符串字面量）→ null', () => {
    expect(parseAcl('[1,2]')).toBeNull();
    expect(parseAcl(42)).toBeNull();
    expect(parseAcl('"dept"')).toBeNull();
  });

  it('两组皆空 → null（不限制）', () => {
    expect(parseAcl('{}')).toBeNull();
    expect(parseAcl({ departments: [], userIds: [] })).toBeNull();
    expect(parseAcl({ departments: ['  '], userIds: ['abc'] })).toBeNull();
  });

  it('合法结构解析并过滤非法项', () => {
    expect(parseAcl('{"departments":["财务部","",123],"userIds":[7,"8",-1,1.5]}')).toEqual({
      departments: ['财务部'],
      userIds: [7, 8],
    });
    expect(parseAcl({ departments: [' 运营部 '], userIds: [] })).toEqual({ departments: ['运营部'], userIds: [] });
  });
});

describe('canAccessDataSource: 访问判定', () => {
  const acl = { departments: ['财务部'], userIds: [9] };

  it('无用户 → 拒绝；ADMIN → 永远放行', () => {
    expect(canAccessDataSource(undefined, acl)).toBe(false);
    expect(canAccessDataSource(null, acl)).toBe(false);
    expect(canAccessDataSource({ id: 1, role: 'ADMIN', department: '' }, acl)).toBe(true);
  });

  it('ACL 为空（null）→ 全员可访问', () => {
    expect(canAccessDataSource({ id: 5, role: 'VIEWER', department: '' }, null)).toBe(true);
  });

  it('个人授权命中（userIds）', () => {
    expect(canAccessDataSource({ id: 9, role: 'ANALYST', department: '市场部' }, acl)).toBe(true);
    expect(canAccessDataSource({ id: 10, role: 'ANALYST', department: '市场部' }, acl)).toBe(false);
  });

  it('部门授权命中（department），空部门不命中', () => {
    expect(canAccessDataSource({ id: 11, role: 'VIEWER', department: '财务部' }, acl)).toBe(true);
    expect(canAccessDataSource({ id: 12, role: 'VIEWER', department: ' 财务部 ' }, acl)).toBe(true);
    expect(canAccessDataSource({ id: 13, role: 'VIEWER', department: '' }, acl)).toBe(false);
  });
});

describe('sanitizeAcl: 管理端入参清洗', () => {
  it('非对象 → null；空清单 → null（解除限制）', () => {
    expect(sanitizeAcl(null)).toBeNull();
    expect(sanitizeAcl('x')).toBeNull();
    expect(sanitizeAcl({ departments: [], userIds: [] })).toBeNull();
  });

  it('去重/去空白/截断超长部门名/过滤非法 userId', () => {
    const out = sanitizeAcl({
      departments: ['财务部', '财务部', ' ', 'x'.repeat(150), 7],
      userIds: [3, 3, '4', 0, -2, 2.5],
    });
    expect(out).toEqual({ departments: ['财务部', 'x'.repeat(100)], userIds: [3, 4] });
  });

  it('规模上限：部门 ≤50，用户 ≤200', () => {
    const out = sanitizeAcl({
      departments: Array.from({ length: 60 }, (_, i) => `部门${i}`),
      userIds: Array.from({ length: 300 }, (_, i) => i + 1),
    });
    expect(out?.departments).toHaveLength(50);
    expect(out?.userIds).toHaveLength(200);
  });
});

describe('DB 交互（mock pool）', () => {
  it('loadDataSourceAcl：数据源不存在 → null；存在则解析 acl_json', async () => {
    (getPool as any).mockReturnValue({ query: vi.fn().mockResolvedValue([[]]) });
    expect(await loadDataSourceAcl('ds_none')).toBeNull();

    (getPool as any).mockReturnValue({
      query: vi.fn().mockResolvedValue([[{ acl_json: '{"departments":["财务部"],"userIds":[]}' }]]),
    });
    expect(await loadDataSourceAcl('ds_a')).toEqual({ departments: ['财务部'], userIds: [] });
  });

  it('checkDataSourceAccess：ADMIN 短路不查库；个人授权命中放行', async () => {
    const query = vi.fn();
    (getPool as any).mockReturnValue({ query });
    expect(await checkDataSourceAccess({ id: 1, role: 'ADMIN', department: '' }, 'ds_a')).toBe(true);
    expect(query).not.toHaveBeenCalled();

    query.mockResolvedValue([[{ acl_json: '{"departments":[],"userIds":[9]}' }]]);
    expect(await checkDataSourceAccess({ id: 9, role: 'ANALYST', department: '' }, 'ds_a')).toBe(true);
    expect(await checkDataSourceAccess({ id: 8, role: 'ANALYST', department: '' }, 'ds_a')).toBe(false);
  });

  it('grantUserAccess：并入 userIds 且幂等去重；数据源不存在抛错', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ acl_json: '{"departments":["财务部"],"userIds":[9]}' }]])
      .mockResolvedValueOnce([{}]);
    (getPool as any).mockReturnValue({ query });

    await grantUserAccess('ds_a', 10);
    expect(query).toHaveBeenNthCalledWith(
      2,
      'UPDATE data_sources SET acl_json = ? WHERE id = ?',
      [JSON.stringify({ departments: ['财务部'], userIds: [9, 10] }), 'ds_a']
    );

    // 重复并入同一用户 → 不重复
    query.mockReset()
      .mockResolvedValueOnce([[{ acl_json: '{"departments":[],"userIds":[9]}' }]])
      .mockResolvedValueOnce([{}]);
    await grantUserAccess('ds_a', 9);
    expect(query).toHaveBeenNthCalledWith(
      2,
      'UPDATE data_sources SET acl_json = ? WHERE id = ?',
      [JSON.stringify({ departments: [], userIds: [9] }), 'ds_a']
    );

    (getPool as any).mockReturnValue({ query: vi.fn().mockResolvedValue([[]]) });
    await expect(grantUserAccess('ds_none', 1)).rejects.toThrow('数据源不存在');
  });
});
