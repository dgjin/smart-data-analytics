/**
 * 认证路由：登录 / 当前用户 / 修改密码。
 * 登录接口挂限流器，防止密码爆破。
 */
import { Router } from 'express';
import { authMiddleware, signToken } from '../auth';
import { getPool } from '../db';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../passwords';
import { rateLimiter } from '../rateLimiter';
import {
  isOidcEnabled,
  buildAuthorizeUrl,
  consumeState,
  exchangeCode,
  fetchUserInfo,
  findOrCreateOidcUser,
} from '../oidc';

const router = Router();

// POST /api/auth/login（公开）
router.post('/login', rateLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  try {
    const [rows] = await getPool().query(
      'SELECT id, username, password_hash, display_name, department, role, status, must_change_password FROM users WHERE username = ? LIMIT 1',
      [username.trim()]
    );
    const user = (rows as any[])[0];
    // 统一错误文案，避免泄露账号是否存在
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: '账号已被禁用，请联系管理员' });
    }

    await getPool().query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    const authUser = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      department: user.department || '',
      role: user.role,
      mustChangePassword: !!user.must_change_password,
    };
    return res.json({ success: true, token: signToken(authUser), user: authUser });
  } catch (err) {
    console.error('[Auth] login failed:', err);
    return res.status(500).json({ error: '登录服务异常' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  return res.json({ success: true, user: req.user });
});

// POST /api/auth/change-password { oldPassword, newPassword }
router.post('/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: '参数格式不正确' });
  }
  // P0-1 统一密码强度校验（8-64位 + 字母数字 + 非弱口令 + 不含用户名）
  const strength = validatePasswordStrength(newPassword, req.user?.username);
  if (!strength.ok) {
    return res.status(400).json({ error: strength.error });
  }

  try {
    const [rows] = await getPool().query('SELECT password_hash FROM users WHERE id = ?', [req.user!.id]);
    const user = (rows as any[])[0];
    if (!user || !verifyPassword(oldPassword, user.password_hash)) {
      return res.status(400).json({ error: '原密码不正确' });
    }
    if (verifyPassword(newPassword, user.password_hash)) {
      return res.status(400).json({ error: '新密码不能与原密码相同' });
    }
    await getPool().query(
      'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
      [hashPassword(newPassword), req.user!.id]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error('[Auth] change-password failed:', err);
    return res.status(500).json({ error: '密码修改失败' });
  }
});

// GET /api/auth/oidc/status（公开）：登录页据此决定是否展示「企业统一登录」入口
router.get('/oidc/status', (_req, res) => {
  return res.json({ enabled: isOidcEnabled() });
});

// GET /api/auth/oidc/login（公开）：302 重定向到 IdP 授权页（授权码流程）
router.get('/oidc/login', rateLimiter, async (_req, res) => {
  if (!isOidcEnabled()) return res.status(404).json({ error: 'OIDC 未启用' });
  try {
    return res.redirect(await buildAuthorizeUrl());
  } catch (err) {
    console.error('[OIDC] login redirect failed:', err);
    return res.redirect('/?sso_error=OIDC%20服务暂不可用');
  }
});

// GET /api/auth/oidc/callback?code=&state=（公开）：
// 校验 state → 换 token → 拉 userinfo → JIT 建号/同步 → 签本地 JWT → 重定向回前端完成登录
router.get('/oidc/callback', rateLimiter, async (req, res) => {
  if (!isOidcEnabled()) return res.status(404).json({ error: 'OIDC 未启用' });
  const fail = (msg: string) => res.redirect(`/?sso_error=${encodeURIComponent(msg)}`);

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!code || !state) return fail('OIDC 回调参数缺失');
  if (!consumeState(state)) return fail('OIDC state 无效或已过期，请重新登录');

  try {
    const accessToken = await exchangeCode(code);
    const profile = await fetchUserInfo(accessToken);
    const user = await findOrCreateOidcUser(profile);
    const token = signToken(user);
    return res.redirect(`/?sso_token=${encodeURIComponent(token)}`);
  } catch (err: any) {
    console.error('[OIDC] callback failed:', err);
    return fail(err?.message || 'OIDC 登录失败');
  }
});

export default router;
