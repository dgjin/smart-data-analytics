/**
 * 认证路由：登录 / 当前用户 / 修改密码。
 * 登录接口挂限流器，防止密码爆破。
 */
import { Router } from 'express';
import { authMiddleware, signToken } from '../auth';
import { getPool } from '../db';
import { hashPassword, verifyPassword } from '../passwords';
import { rateLimiter } from '../rateLimiter';

const router = Router();

// POST /api/auth/login（公开）
router.post('/login', rateLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  try {
    const [rows] = await getPool().query(
      'SELECT id, username, password_hash, display_name, role, status FROM users WHERE username = ? LIMIT 1',
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
      role: user.role,
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
  if (newPassword.length < 6 || newPassword.length > 64) {
    return res.status(400).json({ error: '新密码长度需为 6-64 位' });
  }

  try {
    const [rows] = await getPool().query('SELECT password_hash FROM users WHERE id = ?', [req.user!.id]);
    const user = (rows as any[])[0];
    if (!user || !verifyPassword(oldPassword, user.password_hash)) {
      return res.status(400).json({ error: '原密码不正确' });
    }
    await getPool().query('UPDATE users SET password_hash = ? WHERE id = ?', [
      hashPassword(newPassword),
      req.user!.id,
    ]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Auth] change-password failed:', err);
    return res.status(500).json({ error: '密码修改失败' });
  }
});

export default router;
