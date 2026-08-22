/**
 * P2-11 OIDC 单点登录单元测试：配置解析/state 一次性票据/discovery 缓存/
 * token 交换/userinfo 规整/JIT 建号同步（fetch 与 DB 均 mock，不触网不触库）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  oidcConfig,
  isOidcEnabled,
  createState,
  consumeState,
  sanitizeOidcUsername,
  discoverEndpoints,
  exchangeCode,
  fetchUserInfo,
  findOrCreateOidcUser,
  resetOidcStateForTest,
} from './oidc';
import { getPool } from './db';

vi.mock('./db', () => ({ getPool: vi.fn() }));

const ENV_KEYS = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI', 'OIDC_DEFAULT_ROLE'];

function setOidcEnv() {
  process.env.OIDC_ISSUER = 'https://idp.example.com/realms/main/';
  process.env.OIDC_CLIENT_ID = 'smart-analytics';
  process.env.OIDC_CLIENT_SECRET = 's3cret';
  process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/oidc/callback';
}

function mockFetchSequence(steps: Array<{ ok: boolean; status?: number; json: any }>) {
  const fn = vi.fn();
  for (const s of steps) {
    fn.mockResolvedValueOnce({ ok: s.ok, status: s.status ?? (s.ok ? 200 : 500), json: async () => s.json });
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

const DISCOVERY = {
  authorization_endpoint: 'https://idp.example.com/auth',
  token_endpoint: 'https://idp.example.com/token',
  userinfo_endpoint: 'https://idp.example.com/userinfo',
};

beforeEach(() => {
  resetOidcStateForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('oidcConfig / isOidcEnabled: 配置解析', () => {
  it('缺 OIDC_ISSUER 或 OIDC_CLIENT_ID → 未启用', () => {
    expect(isOidcEnabled()).toBe(false);
    process.env.OIDC_ISSUER = 'https://idp.example.com';
    expect(isOidcEnabled()).toBe(false);
    process.env.OIDC_CLIENT_ID = 'app';
    expect(isOidcEnabled()).toBe(true);
  });

  it('issuer 去尾斜杠；默认角色白名单外回退 VIEWER', () => {
    setOidcEnv();
    process.env.OIDC_DEFAULT_ROLE = 'ROOT';
    const cfg = oidcConfig()!;
    expect(cfg.issuer).toBe('https://idp.example.com/realms/main');
    expect(cfg.defaultRole).toBe('VIEWER');
    process.env.OIDC_DEFAULT_ROLE = 'ANALYST';
    expect(oidcConfig()!.defaultRole).toBe('ANALYST');
  });
});

describe('state 一次性票据', () => {
  it('创建后可消费一次，二次消费失败', async () => {
    const s = await createState();
    expect(await consumeState(s)).toBe(true);
    expect(await consumeState(s)).toBe(false);
  });

  it('未知 state 与过期 state 均拒绝；创建时清理过期项', async () => {
    expect(await consumeState('nonexistent')).toBe(false);
    const now = Date.now();
    const expired = await createState(now - 700_000);
    expect(await consumeState(expired, now)).toBe(false);
  });

  it('P2-13 Redis 模式：state 经 StateStore 外置且一次性消费（模拟多实例共享）', async () => {
    const { setStateStoreForTest, MemoryStateStore } = await import('./stateStore');
    const shared = new MemoryStateStore(); // 两个“实例”共享同一存储
    setStateStoreForTest(shared);
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    try {
      const s = await createState(); // 实例 A 发起登录
      expect(await shared.get(`oidc:st:${s}`)).toBe('1');
      expect(await consumeState(s)).toBe(true); // 实例 B 回调消费
      expect(await consumeState(s)).toBe(false); // 一次性
    } finally {
      delete process.env.REDIS_URL;
      setStateStoreForTest(null);
    }
  });
});

describe('sanitizeOidcUsername: 用户名规整', () => {
  it('转小写/非法字符替换/长度截断', () => {
    expect(sanitizeOidcUsername('Zhang.San@Corp')).toBe('zhang.san_corp');
    expect(sanitizeOidcUsername('  李四  ')).toBe('sso_'); // 中文全部替换后过短
    expect(sanitizeOidcUsername('ab')).toBe('sso_ab');
    expect(sanitizeOidcUsername('A'.repeat(60))).toHaveLength(44);
  });
});

describe('discovery / token / userinfo（mock fetch）', () => {
  it('discoverEndpoints 解析并缓存（1 小时内第二次不重复请求）', async () => {
    setOidcEnv();
    const fn = mockFetchSequence([{ ok: true, json: DISCOVERY }]);
    const ep1 = await discoverEndpoints();
    const ep2 = await discoverEndpoints();
    expect(ep1.authorizationEndpoint).toBe('https://idp.example.com/auth');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(ep2).toBe(ep1);
  });

  it('discoverEndpoints：HTTP 失败与文档缺字段均抛错', async () => {
    setOidcEnv();
    mockFetchSequence([{ ok: false, status: 503, json: {} }]);
    await expect(discoverEndpoints()).rejects.toThrow('HTTP 503');
    mockFetchSequence([{ ok: true, json: { authorization_endpoint: 'x' } }]);
    await expect(discoverEndpoints()).rejects.toThrow('不完整');
  });

  it('exchangeCode 携带 secret 交换 access_token；失败抛错', async () => {
    setOidcEnv();
    const fn = mockFetchSequence([
      { ok: true, json: DISCOVERY },
      { ok: true, json: { access_token: 'at-123' } },
    ]);
    const token = await exchangeCode('code-abc');
    expect(token).toBe('at-123');
    const tokenCall = fn.mock.calls[1];
    expect(tokenCall[0]).toBe('https://idp.example.com/token');
    expect(String(tokenCall[1].body)).toContain('client_secret=s3cret');

    resetOidcStateForTest();
    mockFetchSequence([{ ok: true, json: DISCOVERY }, { ok: false, status: 400, json: {} }]);
    await expect(exchangeCode('bad')).rejects.toThrow('HTTP 400');
  });

  it('fetchUserInfo 规整 profile（username/displayName/department 兜底链）', async () => {
    setOidcEnv();
    mockFetchSequence([
      { ok: true, json: DISCOVERY },
      { ok: true, json: { sub: 'u-1', preferred_username: 'zhangsan', name: '张三', department: '财务部' } },
    ]);
    const p = await fetchUserInfo('at-123');
    expect(p).toEqual({ sub: 'u-1', username: 'zhangsan', displayName: '张三', department: '财务部' });

    resetOidcStateForTest();
    mockFetchSequence([
      { ok: true, json: DISCOVERY },
      { ok: true, json: { sub: 'u-2', email: 'a@b.c' } },
    ]);
    const p2 = await fetchUserInfo('at-123');
    expect(p2.username).toBe('a@b.c');
    expect(p2.department).toBe('');

    resetOidcStateForTest();
    mockFetchSequence([{ ok: true, json: DISCOVERY }, { ok: true, json: { name: '无 sub' } }]);
    await expect(fetchUserInfo('at')).rejects.toThrow('缺少 sub');
  });
});

describe('findOrCreateOidcUser: JIT 建号/同步（mock pool）', () => {
  const profile = { sub: 'u-1', username: 'zhangsan', displayName: '张三', department: '财务部' };

  it('已存在用户：同步 displayName/department 并刷新登录时间', async () => {
    setOidcEnv();
    const query = vi.fn()
      .mockResolvedValueOnce([[{ id: 7, username: 'zhangsan', display_name: '旧名', department: '', role: 'ANALYST', status: 'ACTIVE', must_change_password: 0 }]])
      .mockResolvedValueOnce([{}]) // UPDATE profile
      .mockResolvedValueOnce([{}]); // UPDATE last_login_at
    (getPool as any).mockReturnValue({ query });

    const user = await findOrCreateOidcUser(profile);
    expect(user).toMatchObject({ id: 7, username: 'zhangsan', displayName: '张三', department: '财务部', role: 'ANALYST' });
    expect(query).toHaveBeenNthCalledWith(2, 'UPDATE users SET display_name = ?, department = ? WHERE id = ?', ['张三', '财务部', 7]);
  });

  it('已存在但禁用 → 拒绝登录', async () => {
    setOidcEnv();
    const query = vi.fn().mockResolvedValueOnce([[{ id: 7, username: 'zhangsan', display_name: '张三', department: '财务部', role: 'VIEWER', status: 'DISABLED', must_change_password: 0 }]]);
    (getPool as any).mockReturnValue({ query });
    await expect(findOrCreateOidcUser(profile)).rejects.toThrow('禁用');
  });

  it('不存在 → 按 OIDC_DEFAULT_ROLE 建号（随机密码占位）', async () => {
    setOidcEnv();
    process.env.OIDC_DEFAULT_ROLE = 'ANALYST';
    const query = vi.fn()
      .mockResolvedValueOnce([[]]) // 未命中
      .mockResolvedValueOnce([{ insertId: 42 }]); // INSERT
    (getPool as any).mockReturnValue({ query });

    const user = await findOrCreateOidcUser(profile);
    expect(user).toMatchObject({ id: 42, username: 'zhangsan', displayName: '张三', department: '财务部', role: 'ANALYST' });
    const insertArgs = query.mock.calls[1][1];
    expect(insertArgs[0]).toBe('zhangsan');
    expect(insertArgs[3]).toBe('财务部');
    expect(insertArgs[4]).toBe('ANALYST');
  });
});
