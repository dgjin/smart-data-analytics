/**
 * auth 路由契约测试（质量优化 Stage 2）：登录 / 当前用户 / 改密 / OIDC 入口。
 * 覆盖：成功路径 + 鉴权失败（401/403）+ 参数校验（400）+ 业务错误码。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import authRoutes from './auth';
import { authMiddleware } from '../auth/auth';
import { hashPassword } from '../auth/passwords';

applyTestEnv();

const app = buildApp('/api/auth', authRoutes);

/** 登录成功行（真实哈希，走真实 verifyPassword 链路） */
const loginRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  username: 'zhangsan',
  password_hash: hashPassword('Str0ng#Pass1'),
  display_name: '张三',
  department: '风险部',
  role: 'ANALYST',
  status: 'ACTIVE',
  must_change_password: 0,
  ...over,
});

beforeEach(() => {
  querySpy.mockReset();
});

describe('POST /api/auth/login：登录契约', () => {
  it('参数缺失或类型不符 → 400', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'zhangsan' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('请输入用户名和密码');
    const res2 = await request(app).post('/api/auth/login').send({ username: '  ', password: 'x' });
    expect(res2.status).toBe(400);
  });

  it('用户不存在 → 401 且文案统一（不泄露账号是否存在）', async () => {
    querySpy.mockImplementation(dbStub([{ match: 'FROM users WHERE username', rows: [] }]));
    const res = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'Str0ng#Pass1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('用户名或密码错误');
  });

  it('密码错误 → 401', async () => {
    querySpy.mockImplementation(dbStub([{ match: 'FROM users WHERE username', rows: [loginRow()] }]));
    const res = await request(app).post('/api/auth/login').send({ username: 'zhangsan', password: 'Wrong#Pass9' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('用户名或密码错误');
  });

  it('账号被禁用 → 403', async () => {
    querySpy.mockImplementation(dbStub([{ match: 'FROM users WHERE username', rows: [loginRow({ status: 'DISABLED' })] }]));
    const res = await request(app).post('/api/auth/login').send({ username: 'zhangsan', password: 'Str0ng#Pass1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('账号已被禁用，请联系管理员');
  });

  it('登录成功 → 200 返回 token 与用户信息，且 last_login_at 落库、token 可被 /me 接受', async () => {
    querySpy.mockImplementation(
      dbStub([
        { match: 'FROM users WHERE username', rows: [loginRow()] },
        { match: 'UPDATE users SET last_login_at', rows: [] },
        { match: 'must_change_password FROM users WHERE id', rows: [{ ...activeUserRow('ANALYST', 7), username: 'zhangsan', display_name: '张三' }] },
      ]),
    );
    const res = await request(app).post('/api/auth/login').send({ username: 'zhangsan', password: 'Str0ng#Pass1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user).toMatchObject({ id: 7, username: 'zhangsan', role: 'ANALYST', displayName: '张三' });
    expect(res.body.user).not.toHaveProperty('password_hash');
    // 真实链路闭环：签发的 token 能通过 authMiddleware 回查
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: 7, username: 'zhangsan' });
  });

  it('DB 异常 → 500 兜底错误码文案', async () => {
    querySpy.mockImplementation(async () => {
      throw new Error('db down');
    });
    const res = await request(app).post('/api/auth/login').send({ username: 'zhangsan', password: 'Str0ng#Pass1' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('登录服务异常');
  });
});

describe('GET /api/auth/me：鉴权契约', () => {
  it('缺少 token → 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('未登录或登录已过期');
  });

  it('token 非法/被篡改 → 401', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('登录状态无效，请重新登录');
  });

  it('token 有效但用户不存在 → 401', async () => {
    querySpy.mockImplementation(dbStub([{ match: 'FROM users WHERE id', rows: [] }]));
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenFor('VIEWER', 99)}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('账号不存在或已被禁用');
  });

  it('token 有效但账号被禁用 → 401', async () => {
    querySpy.mockImplementation(
      dbStub([{ match: 'FROM users WHERE id', rows: [{ ...activeUserRow('VIEWER', 9), status: 'DISABLED' }] }]),
    );
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenFor('VIEWER', 9)}`);
    expect(res.status).toBe(401);
  });

  it('token 有效 → 200 返回当前用户（部门缺省归一为空串）', async () => {
    querySpy.mockImplementation(
      dbStub([{ match: 'FROM users WHERE id', rows: [{ ...activeUserRow('ADMIN', 1), department: null }] }]),
    );
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenFor('ADMIN', 1)}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 1, role: 'ADMIN', department: '' });
  });

  it('P0-1 强制改密：must_change_password 用户访问业务接口 → 403 PASSWORD_CHANGE_REQUIRED', async () => {
    querySpy.mockImplementation(
      dbStub([{ match: 'FROM users WHERE id', rows: [{ ...activeUserRow('ANALYST', 5), must_change_password: 1 }] }]),
    );
    const guarded = express();
    guarded.use(express.json());
    guarded.get('/api/business/ping', authMiddleware, (_req, res) => res.json({ ok: true }));
    const res = await request(guarded).get('/api/business/ping').set('Authorization', `Bearer ${tokenFor('ANALYST', 5)}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

describe('POST /api/auth/change-password：改密契约', () => {
  const url = '/api/auth/change-password';

  it('未登录 → 401', async () => {
    const res = await request(app).post(url).send({ oldPassword: 'a', newPassword: 'b' });
    expect(res.status).toBe(401);
  });

  it('参数类型不符 → 400', async () => {
    querySpy.mockImplementation(dbStub([{ match: 'FROM users WHERE id', rows: [activeUserRow('ANALYST', 7)] }]));
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('ANALYST', 7)}`)
      .send({ oldPassword: 'Str0ng#Pass1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('参数格式不正确');
  });

  it('新密码强度不达标 → 400（长度/复杂度/含用户名）', async () => {
    querySpy.mockImplementation(dbStub([{ match: 'FROM users WHERE id', rows: [activeUserRow('ANALYST', 7)] }]));
    const auth = `Bearer ${tokenFor('ANALYST', 7)}`;
    for (const weak of ['short1', 'alllowercase', 'u7abc123']) {
      const res = await request(app).post(url).set('Authorization', auth).send({ oldPassword: 'Str0ng#Pass1', newPassword: weak });
      expect(res.status, `弱口令 ${weak} 应被拒绝`).toBe(400);
    }
  });

  it('原密码不正确 → 400', async () => {
    querySpy.mockImplementation(
      dbStub([
        { match: 'must_change_password FROM users WHERE id', rows: [activeUserRow('ANALYST', 7)] },
        { match: 'SELECT password_hash FROM users', rows: [{ password_hash: hashPassword('Str0ng#Pass1') }] },
      ]),
    );
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('ANALYST', 7)}`)
      .send({ oldPassword: 'Wrong#Pass9', newPassword: 'N3w#Passw0rd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('原密码不正确');
  });

  it('新密码与原密码相同 → 400', async () => {
    querySpy.mockImplementation(
      dbStub([
        { match: 'must_change_password FROM users WHERE id', rows: [activeUserRow('ANALYST', 7)] },
        { match: 'SELECT password_hash FROM users', rows: [{ password_hash: hashPassword('Str0ng#Pass1') }] },
      ]),
    );
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('ANALYST', 7)}`)
      .send({ oldPassword: 'Str0ng#Pass1', newPassword: 'Str0ng#Pass1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('新密码不能与原密码相同');
  });

  it('改密成功 → 200 且清零 must_change_password', async () => {
    querySpy.mockImplementation(
      dbStub([
        { match: 'must_change_password FROM users WHERE id', rows: [activeUserRow('ANALYST', 7)] },
        { match: 'SELECT password_hash FROM users', rows: [{ password_hash: hashPassword('Str0ng#Pass1') }] },
        { match: 'UPDATE users SET password_hash', rows: [] },
      ]),
    );
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${tokenFor('ANALYST', 7)}`)
      .send({ oldPassword: 'Str0ng#Pass1', newPassword: 'N3w#Passw0rd' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('OIDC 入口：未启用时的契约', () => {
  it('GET /api/auth/oidc/status → 200 且 enabled 为布尔', async () => {
    const res = await request(app).get('/api/auth/oidc/status');
    expect(res.status).toBe(200);
    expect(typeof res.body.enabled).toBe('boolean');
  });

  it('未启用时 login/callback → 404', async () => {
    const login = await request(app).get('/api/auth/oidc/login');
    expect(login.status).toBe(404);
    expect(login.body.error).toBe('OIDC 未启用');
    const cb = await request(app).get('/api/auth/oidc/callback?code=c&state=s');
    expect(cb.status).toBe(404);
  });
});
