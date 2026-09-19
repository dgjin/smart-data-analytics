/**
 * orgUnits 路由契约测试（v0.9.66 组织架构树）：总部→机构→部门→团队。
 * 覆盖：鉴权（401/403）+ 层级强校验 + 同级重名 + 排序边界 + 删除保护 + 改名同步（用户部门与数据源 ACL）
 *     + 数据标识自动编码（v0.9.67：层级路径编号与一键补全）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import orgUnitRoutes, { buildDataCode } from './orgUnits';

applyTestEnv();

const app = buildApp('/api/admin/org-units', orgUnitRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };

const adminStub = (...rules: DbStubRule[]) => dbStub([adminAuth, ...rules]);

/** INSERT/UPDATE 的 ResultSetHeader 语义返回（dbStub 只透传行集，用带属性的数组冒充） */
const resultSet = (props: Record<string, unknown>) => Object.assign([] as unknown[], props);

/** SQL 片段常量：与路由实现逐字对齐，避免桩规则因改字而静默失配 */
const R = {
  list: 'FROM org_units u ORDER',
  loadNode: 'FROM org_units WHERE id = ? LIMIT 1',
  sibling: /SELECT id FROM org_units WHERE parent_id <=> \? AND name = \?( AND id != \?)? LIMIT 1$/,
  siblingExcludeSelf: 'AND id != ?',
  siblings: 'WHERE parent_id <=> ? ORDER BY sort_order',
  maxOrder: 'MAX(sort_order)',
  insert: 'INSERT INTO org_units',
  allCodes: 'SELECT data_code FROM org_units',
  allNodes: 'SELECT id, parent_id, level, name, data_code FROM org_units',
  updateDataCode: 'UPDATE org_units SET data_code',
  updateNode: 'UPDATE org_units SET',
  updateOrder: 'UPDATE org_units SET sort_order',
  updateUserDept: 'UPDATE users SET department',
  aclSelect: 'acl_json FROM data_sources',
  aclUpdate: 'UPDATE data_sources SET acl_json',
  childCount: 'COUNT(*) AS cnt FROM org_units',
  userCount: 'COUNT(*) AS cnt FROM users WHERE org_unit_id',
  del: 'DELETE FROM org_units',
  audit: 'INSERT INTO query_audit_log',
};

/** org_units 行（列名与 loadNode SELECT 对齐） */
const nodeRow = (over: Record<string, unknown> = {}) => ({
  id: 3,
  parent_id: 1,
  level: 'BRANCH',
  name: '安徽分公司',
  data_code: 'AH',
  sort_order: 10,
  ...over,
});

const post = (url: string, body: unknown) =>
  request(app).post(url).set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body as object);
const put = (url: string, body: unknown) =>
  request(app).put(url).set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body as object);
const del = (url: string) => request(app).delete(url).set('Authorization', `Bearer ${ADMIN_TOKEN}`);

beforeEach(() => {
  querySpy.mockReset();
  querySpy.mockImplementation(adminStub());
});

describe('鉴权与角色守卫', () => {
  it('缺少 token → 401', async () => {
    const res = await request(app).get('/api/admin/org-units');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('非 ADMIN 角色 → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app).get('/api/admin/org-units').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });
});

describe('GET /api/admin/org-units：节点列表', () => {
  it('成功 → 200 且计数列数值归一', async () => {
    querySpy.mockImplementation(
      adminStub({
        match: R.list,
        rows: () => [{ id: 1, parentId: null, level: 'HQ', name: '总部', dataCode: '', sortOrder: 0, userCount: '2', childCount: '1' }],
      })
    );
    const res = await request(app).get('/api/admin/org-units').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.units[0]).toMatchObject({ id: 1, parentId: null, level: 'HQ', name: '总部', userCount: 2, childCount: 1 });
  });

  it('DB 异常 → 500 兜底文案', async () => {
    const res = await request(app).get('/api/admin/org-units').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('组织架构加载失败');
  });
});

describe('POST /api/admin/org-units：新增节点', () => {
  it('节点类型非法 → 400', async () => {
    const res = await post('/api/admin/org-units', { parentId: 1, level: 'DIVISION', name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('节点类型无效，可选：BRANCH（机构）/ DEPT（部门）/ TEAM（团队）');
  });

  it('新增总部 → 400（系统内置唯一根节点）', async () => {
    const res = await post('/api/admin/org-units', { parentId: null, level: 'HQ', name: '总部二' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('总部为系统内置唯一根节点，不可新增');
  });

  it('未指定上级节点 → 400', async () => {
    const res = await post('/api/admin/org-units', { level: 'BRANCH', name: '安徽分公司' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('请指定上级节点');
  });

  it('节点名称为空 → 400', async () => {
    const res = await post('/api/admin/org-units', { parentId: 1, level: 'BRANCH', name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('节点名称需为 1-100 个字符');
  });

  it('数据标识超长 → 400', async () => {
    const res = await post('/api/admin/org-units', { parentId: 1, level: 'BRANCH', name: '安徽分公司', dataCode: 'x'.repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('数据标识不能超过 100 个字符');
  });

  it('上级节点不存在 → 400', async () => {
    querySpy.mockImplementation(adminStub({ match: R.loadNode, rows: [] }));
    const res = await post('/api/admin/org-units', { parentId: 999, level: 'BRANCH', name: '安徽分公司' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('上级节点不存在');
  });

  it('层级不符（总部下新增部门）→ 400', async () => {
    querySpy.mockImplementation(
      adminStub({ match: R.loadNode, rows: () => [nodeRow({ id: 1, parent_id: null, level: 'HQ', name: '总部', data_code: '' })] })
    );
    const res = await post('/api/admin/org-units', { parentId: 1, level: 'DEPT', name: '风险部' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('「总部」是总部，其下级只能是机构');
  });

  it('团队为末级（团队下新增）→ 400', async () => {
    querySpy.mockImplementation(
      adminStub({ match: R.loadNode, rows: () => [nodeRow({ id: 9, level: 'TEAM', name: '投资一部' })] })
    );
    const res = await post('/api/admin/org-units', { parentId: 9, level: 'TEAM', name: '投资二部' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('「投资一部」是团队，其下级只能是（无，团队为末级）');
  });

  it('同级同名 → 409', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow({ id: 1, parent_id: null, level: 'HQ', name: '总部', data_code: '' })] },
        { match: R.sibling, rows: () => [{ id: 3 }] }
      )
    );
    const res = await post('/api/admin/org-units', { parentId: 1, level: 'BRANCH', name: '安徽分公司' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('同级下已存在同名节点');
  });

  it('创建成功 → 201，排序号 = 同级最大值 + 10', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow({ id: 1, parent_id: null, level: 'HQ', name: '总部', data_code: '' })] },
        { match: R.sibling, rows: [] },
        { match: R.maxOrder, rows: () => [{ maxOrder: 20 }] },
        { match: R.insert, rows: resultSet({ insertId: 5, affectedRows: 1 }) },
        { match: R.audit, rows: [] }
      )
    );
    const res = await post('/api/admin/org-units', { parentId: 1, level: 'BRANCH', name: ' 安徽分公司 ', dataCode: 'AH' });
    expect(res.status).toBe(201);
    expect(res.body.unit).toMatchObject({ id: 5, parentId: 1, level: 'BRANCH', name: '安徽分公司', dataCode: 'AH', sortOrder: 30 });
    // 审计留痕（管理操作可追溯）
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes(R.audit))).toBe(true);
  });

  it('未传数据标识 → 按层级路径自动生成（机构 BR03）', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow({ id: 1, parent_id: null, level: 'HQ', name: '总部', data_code: '' })] },
        { match: R.sibling, rows: [] },
        { match: R.allCodes, rows: () => [{ data_code: 'BR01' }, { data_code: 'BR02' }, { data_code: '' }] },
        { match: R.maxOrder, rows: () => [{ maxOrder: 0 }] },
        { match: R.insert, rows: resultSet({ insertId: 7, affectedRows: 1 }) },
        { match: R.audit, rows: [] }
      )
    );
    const res = await post('/api/admin/org-units', { parentId: 1, level: 'BRANCH', name: '江苏分公司' });
    expect(res.status).toBe(201);
    expect(res.body.unit.dataCode).toBe('BR03');
    const insertCall = querySpy.mock.calls.find((c) => String(c[0]).includes(R.insert));
    expect((insertCall?.[1] as unknown[])[3]).toBe('BR03');
  });

  it('部门自动生成父路径编号（BR01-D02）', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow({ id: 3, level: 'BRANCH', name: '安徽分公司', data_code: 'BR01' })] },
        { match: R.sibling, rows: [] },
        { match: R.allCodes, rows: () => [{ data_code: 'BR01' }, { data_code: 'BR01-D01' }] },
        { match: R.maxOrder, rows: () => [{ maxOrder: 10 }] },
        { match: R.insert, rows: resultSet({ insertId: 8, affectedRows: 1 }) },
        { match: R.audit, rows: [] }
      )
    );
    const res = await post('/api/admin/org-units', { parentId: 3, level: 'DEPT', name: '投资二部' });
    expect(res.status).toBe(201);
    expect(res.body.unit.dataCode).toBe('BR01-D02');
  });

  it('DB 唯一键冲突 → 409', async () => {
    querySpy.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes(R.insert)) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      return adminStub(
        { match: R.loadNode, rows: () => [nodeRow({ id: 1, parent_id: null, level: 'HQ', name: '总部', data_code: '' })] },
        { match: R.sibling, rows: [] },
        { match: R.allCodes, rows: () => [] },
        { match: R.maxOrder, rows: () => [{ maxOrder: 0 }] }
      )(sql, params);
    });
    const res = await post('/api/admin/org-units', { parentId: 1, level: 'BRANCH', name: '安徽分公司' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('同级下已存在同名节点');
  });
});

describe('PUT /api/admin/org-units/:id：更新节点', () => {
  it('ID 非整数 → 400', async () => {
    const res = await put('/api/admin/org-units/abc', { name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('组织节点 ID 无效');
  });

  it('节点不存在 → 404', async () => {
    querySpy.mockImplementation(adminStub({ match: R.loadNode, rows: [] }));
    const res = await put('/api/admin/org-units/99', { name: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('组织节点不存在');
  });

  it('无可更新字段 → 400', async () => {
    querySpy.mockImplementation(adminStub({ match: R.loadNode, rows: () => [nodeRow()] }));
    const res = await put('/api/admin/org-units/3', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('没有需要更新的字段');
  });

  it('改名撞同级同名 → 409', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow()] },
        { match: R.siblingExcludeSelf, rows: () => [{ id: 4 }] }
      )
    );
    const res = await put('/api/admin/org-units/3', { name: '江苏分公司' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('同级下已存在同名节点');
  });

  it('改名成功 → 同步用户部门文本与数据源 ACL 部门清单', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow()] },
        { match: R.siblingExcludeSelf, rows: [] },
        { match: R.updateNode, rows: resultSet({ affectedRows: 1 }) },
        { match: R.updateUserDept, rows: resultSet({ affectedRows: 2 }) },
        {
          match: R.aclSelect,
          rows: () => [
            { id: 'ds_a', acl_json: JSON.stringify({ departments: ['安徽分公司', '其他部门'], userIds: [] }) },
            { id: 'ds_b', acl_json: JSON.stringify({ departments: ['其他部门'], userIds: [] }) },
          ],
        },
        { match: R.aclUpdate, rows: resultSet({ affectedRows: 1 }) },
        { match: R.audit, rows: [] }
      )
    );
    const res = await put('/api/admin/org-units/3', { name: '安徽分公司（本部）' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, syncedUsers: 2, syncedDataSources: 1 });
    // 仅命中旧名的数据源被改写（未命中的不改）
    const aclWrites = querySpy.mock.calls.filter((c) => String(c[0]).includes(R.aclUpdate));
    expect(aclWrites).toHaveLength(1);
    expect(JSON.parse(String(aclWrites[0][1][0])).departments).toEqual(['安徽分公司（本部）', '其他部门']);
  });

  it('仅改数据标识 → 200 且不触发同步', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow()] },
        { match: R.updateNode, rows: resultSet({ affectedRows: 1 }) },
        { match: R.audit, rows: [] }
      )
    );
    const res = await put('/api/admin/org-units/3', { dataCode: 'AH-B1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, syncedUsers: 0, syncedDataSources: 0 });
  });
});

describe('POST /api/admin/org-units/:id/move：同级排序', () => {
  it('direction 非法 → 400', async () => {
    const res = await post('/api/admin/org-units/3/move', { direction: 'left' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('direction 只能是 up 或 down');
  });

  it('总部调整顺序 → 400', async () => {
    querySpy.mockImplementation(
      adminStub({ match: R.loadNode, rows: () => [nodeRow({ id: 1, parent_id: null, level: 'HQ', name: '总部' })] })
    );
    const res = await post('/api/admin/org-units/1/move', { direction: 'up' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('总部为根节点，无法调整顺序');
  });

  it('已在首位再上移 → 400', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow({ id: 3, sort_order: 10 })] },
        { match: R.siblings, rows: () => [nodeRow({ id: 3, sort_order: 10 }), nodeRow({ id: 4, sort_order: 20 })] }
      )
    );
    const res = await post('/api/admin/org-units/3/move', { direction: 'up' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('已是同级首位');
  });

  it('下移成功 → 200 且返回新顺序', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow({ id: 3, sort_order: 10 })] },
        { match: R.siblings, rows: () => [nodeRow({ id: 3, sort_order: 10 }), nodeRow({ id: 4, sort_order: 20 })] },
        { match: R.updateOrder, rows: resultSet({ affectedRows: 1 }) },
        { match: R.audit, rows: [] }
      )
    );
    const res = await post('/api/admin/org-units/3/move', { direction: 'down' });
    expect(res.status).toBe(200);
    expect(res.body.order).toEqual([4, 3]);
  });
});

describe('DELETE /api/admin/org-units/:id：删除节点', () => {
  it('总部不可删除 → 400', async () => {
    querySpy.mockImplementation(
      adminStub({ match: R.loadNode, rows: () => [nodeRow({ id: 1, parent_id: null, level: 'HQ', name: '总部' })] })
    );
    const res = await del('/api/admin/org-units/1');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('总部为根节点，不可删除');
  });

  it('有下级节点 → 409', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow()] },
        { match: R.childCount, rows: () => [{ cnt: 2 }] }
      )
    );
    const res = await del('/api/admin/org-units/3');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('请先删除其下级节点（2 个）');
  });

  it('仍有用户归属 → 409', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow()] },
        { match: R.childCount, rows: () => [{ cnt: 0 }] },
        { match: R.userCount, rows: () => [{ cnt: 3 }] }
      )
    );
    const res = await del('/api/admin/org-units/3');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('有 3 个用户归属该节点，请先调整其组织归属');
  });

  it('删除成功 → 200', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: R.loadNode, rows: () => [nodeRow()] },
        { match: R.childCount, rows: () => [{ cnt: 0 }] },
        { match: R.userCount, rows: () => [{ cnt: 0 }] },
        { match: R.del, rows: resultSet({ affectedRows: 1 }) },
        { match: R.audit, rows: [] }
      )
    );
    const res = await del('/api/admin/org-units/3');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('buildDataCode：层级路径编号（v0.9.67）', () => {
  it('机构：空集合 → BR01；已有 BR01/BR02 → BR03', () => {
    expect(buildDataCode('BRANCH', '', [])).toBe('BR01');
    expect(buildDataCode('BRANCH', '', ['BR01', 'BR02'])).toBe('BR03');
  });

  it('部门：以机构编码为前缀，按同前缀序号递增', () => {
    expect(buildDataCode('DEPT', 'BR01', [])).toBe('BR01-D01');
    expect(buildDataCode('DEPT', 'BR01', ['BR01-D01', 'BR01-D02', 'BR02-D01'])).toBe('BR01-D03');
  });

  it('团队：以部门编码为前缀', () => {
    expect(buildDataCode('TEAM', 'BR01-D01', [])).toBe('BR01-D01-T01');
    expect(buildDataCode('TEAM', 'BR01-D01', ['BR01-D01-T01'])).toBe('BR01-D01-T02');
  });

  it('父编码缺失 → 退化为 D01 / T01', () => {
    expect(buildDataCode('DEPT', '', [])).toBe('D01');
    expect(buildDataCode('TEAM', '', ['T01', 'T02'])).toBe('T03');
  });

  it('序号两位补零，超过 99 自然进位', () => {
    expect(buildDataCode('BRANCH', '', ['BR09'])).toBe('BR10');
    expect(buildDataCode('BRANCH', '', ['BR99'])).toBe('BR100');
  });

  it('手动编码不干扰序号识别（仅同前缀精确匹配）', () => {
    expect(buildDataCode('BRANCH', '', ['AH', 'BR02', 'BR01'])).toBe('BR03');
    expect(buildDataCode('DEPT', 'BR01', ['BR010-D01'])).toBe('BR01-D01');
  });
});

describe('POST /api/admin/org-units/auto-code：一键补全数据标识', () => {
  it('仅补空节点，已有编码保留，子节点取父级编号为前缀', async () => {
    querySpy.mockImplementation(
      adminStub(
        {
          match: R.allNodes,
          rows: () => [
            { id: 1, parent_id: null, level: 'HQ', name: '总部', data_code: '' },
            { id: 2, parent_id: 1, level: 'BRANCH', name: '安徽分公司', data_code: 'AH' },
            { id: 3, parent_id: 1, level: 'BRANCH', name: '江苏分公司', data_code: '' },
            { id: 4, parent_id: 2, level: 'DEPT', name: '投资一部', data_code: '' },
            { id: 5, parent_id: 4, level: 'TEAM', name: '投资一队', data_code: '' },
          ],
        },
        { match: R.updateDataCode, rows: resultSet({ affectedRows: 1 }) },
        { match: R.audit, rows: [] }
      )
    );
    const res = await post('/api/admin/org-units/auto-code', {});
    expect(res.status).toBe(200);
    expect(res.body.filled).toBe(3);
    expect(res.body.codes).toEqual([
      { id: 3, name: '江苏分公司', dataCode: 'BR01' },
      { id: 4, name: '投资一部', dataCode: 'AH-D01' },
      { id: 5, name: '投资一队', dataCode: 'AH-D01-T01' },
    ]);
    // 总部与已有编码节点不被改写，且逐条 UPDATE 落库
    const updates = querySpy.mock.calls.filter((c) => String(c[0]).includes(R.updateDataCode));
    expect(updates.map((c) => (c[1] as unknown[])[1])).toEqual([3, 4, 5]);
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes(R.audit))).toBe(true);
  });

  it('全部已配置或仅总部 → filled=0 且不写审计', async () => {
    querySpy.mockImplementation(
      adminStub({
        match: R.allNodes,
        rows: () => [
          { id: 1, parent_id: null, level: 'HQ', name: '总部', data_code: '' },
          { id: 2, parent_id: 1, level: 'BRANCH', name: '安徽分公司', data_code: 'AH' },
        ],
      })
    );
    const res = await post('/api/admin/org-units/auto-code', {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, filled: 0, codes: [] });
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes(R.audit))).toBe(false);
  });

  it('DB 异常 → 500 兜底文案', async () => {
    const res = await post('/api/admin/org-units/auto-code', {});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('数据标识自动编码失败');
  });
});
