/**
 * admin 路由契约测试（质量优化 Stage 2）：用户 CRUD（列表/创建/更新/重置密码/删除）
 * + 环境配置在线化 GET/PUT env-config。
 * 覆盖：鉴权（401/403）+ 参数校验（400）+ 业务错误码（404/409）+ 成功路径。
 * 注：本路由为 router.use(authMiddleware, requireRole('ADMIN'))，所有端点共享同一守卫。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import adminRoutes from './admin';

applyTestEnv();

const app = buildApp('/api/admin', adminRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

/** authMiddleware 回查行（ADMIN） */
const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
/** authMiddleware 回查行（VIEWER，仅用于 403 用例） */
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };

/** 以 ADMIN 鉴权行开头拼装桩规则（authMiddleware 的回查 SQL 恒最先执行） */
const adminStub = (...rules: DbStubRule[]) => dbStub([adminAuth, ...rules]);

/**
 * INSERT/UPDATE 的 ResultSetHeader 语义返回。
 * dbStub 只把规则行集整体透传（[rows]），故用「带属性的数组」冒充 affectedRows/insertId。
 */
const resultSet = (props: Record<string, unknown>) => Object.assign([] as unknown[], props);

/** users 列表行（列名与路由 SELECT 的别名对齐） */
const listRow = (over: Record<string, unknown> = {}) => ({
  id: 3,
  username: 'lisi',
  displayName: '李四',
  department: '风险部',
  role: 'ANALYST',
  status: 'ACTIVE',
  mustChangePassword: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  ...over,
});

beforeEach(() => {
  querySpy.mockReset();
  // 默认仅装配鉴权回查；需要业务 SQL 的用例再行覆盖（dbStub 未命中规则即抛错，避免假通过）
  querySpy.mockImplementation(adminStub());
});

describe('鉴权与角色守卫（router.use(authMiddleware, requireRole(ADMIN))）', () => {
  it('缺少 token → 401', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('非 ADMIN 角色 → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('没有权限执行此操作');
  });

  it('token 有效但账号被禁用 → 401', async () => {
    querySpy.mockImplementation(
      dbStub([{ match: 'must_change_password FROM users WHERE id', rows: [{ ...activeUserRow('ADMIN', 1), status: 'DISABLED' }] }]),
    );
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('账号不存在或已被禁用');
  });
});

describe('GET /api/admin/users：用户列表', () => {
  it('成功 → 200 返回用户列表', async () => {
    querySpy.mockImplementation(adminStub({ match: 'FROM users ORDER BY id ASC', rows: [listRow()] }));
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({ id: 3, username: 'lisi', displayName: '李四', role: 'ANALYST' });
  });

  it('DB 异常 → 500 兜底文案', async () => {
    // 仅装配鉴权规则：列表 SQL 未配桩 → dbStub 抛错 → 路由 catch
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('用户列表获取失败');
  });
});

describe('POST /api/admin/users：创建用户', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/admin/users').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('用户名不合规 → 400', async () => {
    const res = await post({ username: 'ab', password: 'New#Passw0rd', role: 'ANALYST' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('用户名需为 3-20 位字母、数字或下划线');
  });

  it('密码长度越界 → 400', async () => {
    const res = await post({ username: 'newuser', password: '123', role: 'ANALYST' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('密码长度需为 6-64 位');
  });

  it('角色无效 → 400', async () => {
    const res = await post({ username: 'newuser', password: 'New#Passw0rd', role: 'SUPER' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('角色无效，可选：ADMIN / ANALYST / VIEWER');
  });

  it('密码强度不达标 → 400', async () => {
    const res = await post({ username: 'newuser', password: 'abcdefgh', role: 'ANALYST' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('密码需同时包含字母和数字');
  });

  it('创建成功 → 201 返回新用户（部门首尾空格归一）', async () => {
    querySpy.mockImplementation(adminStub({ match: 'INSERT INTO users', rows: resultSet({ insertId: 42, affectedRows: 1 }) }));
    const res = await post({
      username: 'newuser',
      password: 'New#Passw0rd',
      displayName: '新用户',
      role: 'ANALYST',
      department: ' 风控部 ',
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.user).toMatchObject({ id: 42, username: 'newuser', displayName: '新用户', role: 'ANALYST', department: '风控部' });
  });

  it('用户名重复 → 409', async () => {
    querySpy.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO users')) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      return adminStub()(sql, params);
    });
    const res = await post({ username: 'newuser', password: 'New#Passw0rd', role: 'ANALYST' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('用户名已存在');
  });

  it('DB 异常 → 500 兜底文案（INSERT 未配桩即抛错）', async () => {
    const res = await post({ username: 'newuser', password: 'New#Passw0rd', role: 'ANALYST' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('用户创建失败');
  });
});

describe('PUT /api/admin/users/:id：更新用户', () => {
  const put = (id: string, body: Record<string, unknown>) =>
    request(app).put(`/api/admin/users/${id}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('用户 ID 非整数 → 400', async () => {
    const res = await put('abc', { displayName: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('用户 ID 无效');
  });

  it('无可更新字段 → 400', async () => {
    const res = await put('9', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('没有需要更新的字段');
  });

  it('角色非法 → 400', async () => {
    const res = await put('9', { role: 'SUPER' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('角色无效');
  });

  it('状态非法 → 400', async () => {
    const res = await put('9', { status: 'PAUSED' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('状态无效');
  });

  it('修改自己的角色/状态 → 400（自我保护）', async () => {
    const res = await put('1', { role: 'ANALYST' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('不能修改自己的角色或状态');
  });

  it('目标用户不存在（affectedRows=0）→ 404', async () => {
    querySpy.mockImplementation(adminStub({ match: 'UPDATE users SET', rows: resultSet({ affectedRows: 0 }) }));
    const res = await put('9', { displayName: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('用户不存在');
  });

  it('更新成功 → 200', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT role, status FROM users WHERE id', rows: [{ role: 'ANALYST', status: 'ACTIVE' }] },
        { match: 'UPDATE users SET', rows: resultSet({ affectedRows: 1 }) },
      ),
    );
    const res = await put('9', { role: 'ANALYST', department: '风险部' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('降级最后一个 ACTIVE 管理员 → 400', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT role, status FROM users WHERE id', rows: [{ role: 'ADMIN', status: 'ACTIVE' }] },
        { match: "COUNT(*) AS cnt FROM users WHERE role = 'ADMIN'", rows: [{ cnt: 0 }] },
      ),
    );
    const res = await put('9', { role: 'ANALYST' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('系统至少需要保留一个可用管理员');
  });

  it('DB 异常 → 500 兜底文案（UPDATE 未配桩即抛错）', async () => {
    querySpy.mockImplementation(adminStub({ match: 'SELECT role, status FROM users WHERE id', rows: [{ role: 'ANALYST', status: 'ACTIVE' }] }));
    const res = await put('9', { role: 'ANALYST' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('用户更新失败');
  });
});

describe('POST /api/admin/users/:id/reset-password：重置密码', () => {
  const reset = (id: string, body: Record<string, unknown>) =>
    request(app).post(`/api/admin/users/${id}/reset-password`).set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('用户 ID 非整数 → 400', async () => {
    const res = await reset('x', { newPassword: 'N3w#Passw0rd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('用户 ID 无效');
  });

  it('新密码强度不达标 → 400', async () => {
    const res = await reset('9', { newPassword: 'short1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('密码长度需为 8-64 位');
  });

  it('目标用户不存在（affectedRows=0）→ 404', async () => {
    querySpy.mockImplementation(adminStub({ match: 'UPDATE users SET password_hash', rows: resultSet({ affectedRows: 0 }) }));
    const res = await reset('9', { newPassword: 'N3w#Passw0rd' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('用户不存在');
  });

  it('重置成功 → 200', async () => {
    querySpy.mockImplementation(adminStub({ match: 'UPDATE users SET password_hash', rows: resultSet({ affectedRows: 1 }) }));
    const res = await reset('9', { newPassword: 'N3w#Passw0rd' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DB 异常 → 500 兜底文案（UPDATE 未配桩即抛错）', async () => {
    const res = await reset('9', { newPassword: 'N3w#Passw0rd' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('密码重置失败');
  });
});

describe('DELETE /api/admin/users/:id：删除用户', () => {
  const del = (id: string) => request(app).delete(`/api/admin/users/${id}`).set('Authorization', `Bearer ${ADMIN_TOKEN}`);

  it('用户 ID 非整数 → 400', async () => {
    const res = await del('x');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('用户 ID 无效');
  });

  it('删除自己 → 400（自我保护）', async () => {
    const res = await del('1');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('不能删除当前登录的管理员账号');
  });

  it('目标用户不存在 → 404', async () => {
    querySpy.mockImplementation(adminStub({ match: 'SELECT role, status FROM users WHERE id', rows: [] }));
    const res = await del('9');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('用户不存在');
  });

  it('删除最后一个 ACTIVE 管理员 → 400', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT role, status FROM users WHERE id', rows: [{ role: 'ADMIN', status: 'ACTIVE' }] },
        { match: "COUNT(*) AS cnt FROM users WHERE role = 'ADMIN'", rows: [{ cnt: 0 }] },
      ),
    );
    const res = await del('9');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('系统至少需要保留一个可用管理员');
  });

  it('删除成功 → 200', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'SELECT role, status FROM users WHERE id', rows: [{ role: 'ANALYST', status: 'ACTIVE' }] },
        { match: 'DELETE FROM users WHERE id', rows: [] },
      ),
    );
    const res = await del('9');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DB 异常 → 500 兜底文案', async () => {
    // 目标存在但 DELETE 未配桩 → 抛错
    querySpy.mockImplementation(adminStub({ match: 'SELECT role, status FROM users WHERE id', rows: [{ role: 'ANALYST', status: 'ACTIVE' }] }));
    const res = await del('9');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('用户删除失败');
  });
});

describe('GET /api/admin/env-config：环境配置读取', () => {
  it('成功 → 200 且敏感项脱敏为哨兵、非敏感项保留原值', async () => {
    querySpy.mockImplementation(
      adminStub({
        match: 'FROM env_config',
        rows: [
          { key: 'LLM_MODEL', value: 'qwen3:8b', category: 'ai_engine', description: 'd', is_sensitive: 0, updated_at: '2026-01-01T00:00:00.000Z' },
          { key: 'QWEN_API_KEY', value: 'sk-secret', category: 'ai_engine', description: 'd', is_sensitive: 1, updated_at: null },
        ],
      }),
    );
    const res = await request(app).get('/api/admin/env-config').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data[0].value).toBe('qwen3:8b');
    expect(res.body.data[0].runtime_value).toBe('');
    expect(res.body.data[1].value).toBe('***hidden***');
    expect(typeof res.body.data[0].runtime_configured).toBe('boolean');
  });

  it('缺少 token → 401', async () => {
    const res = await request(app).get('/api/admin/env-config');
    expect(res.status).toBe(401);
  });

  it('DB 异常 → 500', async () => {
    const res = await request(app).get('/api/admin/env-config').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('PUT /api/admin/env-config：环境配置更新（仅断言契约，不深究热更副作用）', () => {
  const put = (body: Record<string, unknown>) =>
    request(app).put('/api/admin/env-config').set('Authorization', `Bearer ${ADMIN_TOKEN}`).send(body);

  it('updates 非数组 → 400', async () => {
    const res = await put({ updates: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Invalid input');
  });

  it('键位不在白名单 → 400 Forbidden key', async () => {
    const res = await put({ updates: [{ key: 'NOT_ALLOWED_KEY', value: 'x' }] });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Forbidden key: NOT_ALLOWED_KEY');
  });

  it('全为脱敏哨兵（未修改）→ 200 且 applied 为空', async () => {
    const res = await put({ updates: [{ key: 'JWT_SECRET', value: '***hidden***' }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.applied).toEqual([]);
    expect(res.body.skippedUnchanged).toEqual(['JWT_SECRET']);
  });

  it('更新成功 → 200 返回落库条数与热更清单', async () => {
    querySpy.mockImplementation(
      adminStub(
        { match: 'INSERT INTO env_config', rows: [] },
        { match: 'INSERT INTO query_audit_log', rows: [] },
      ),
    );
    process.env.LLM_MODEL = 'prev-model';
    const res = await put({ updates: [{ key: 'LLM_MODEL', value: 'unit-test-model' }] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.applied).toEqual(['LLM_MODEL']);
    expect(res.body.audit_log).toMatchObject({ user_id: 1, username: 'u1', changes: ['LLM_MODEL'] });
    // 清理热更副作用，避免污染其他用例
    delete process.env.LLM_MODEL;
  });

  it('缺少 token → 401', async () => {
    const res = await request(app).put('/api/admin/env-config').send({ updates: [] });
    expect(res.status).toBe(401);
  });
});
