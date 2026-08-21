/**
 * 管理员用户管理路由（仅 ADMIN 角色）。
 * 保护规则：不能修改/删除自己，且必须始终保留至少一个 ACTIVE 管理员。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import { getPool } from '../db';
import { hashPassword, validatePasswordStrength } from '../passwords';

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

const VALID_ROLES = ['ADMIN', 'ANALYST', 'VIEWER'] as const;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

async function countActiveAdmins(excludeId?: number): Promise<number> {
  const [rows] = await getPool().query(
    `SELECT COUNT(*) AS cnt FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'${excludeId ? ' AND id != ?' : ''}`,
    excludeId ? [excludeId] : []
  );
  return Number((rows as any[])[0]?.cnt || 0);
}

// GET /api/admin/users
router.get('/users', async (_req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, username, display_name AS displayName, department, role, status, must_change_password AS mustChangePassword,
              created_at AS createdAt, last_login_at AS lastLoginAt
       FROM users ORDER BY id ASC`
    );
    return res.json({ success: true, users: rows });
  } catch (err) {
    console.error('[Admin] list users failed:', err);
    return res.status(500).json({ error: '用户列表获取失败' });
  }
});

// POST /api/admin/users { username, password, displayName, role, department? }
router.post('/users', async (req, res) => {
  const { username, password, displayName, role, department } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    return res.status(400).json({ error: '用户名需为 3-20 位字母、数字或下划线' });
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
    return res.status(400).json({ error: '密码长度需为 6-64 位' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: '角色无效，可选：ADMIN / ANALYST / VIEWER' });
  }
  // P0-1 统一密码强度校验；初始密码强制用户首次登录修改
  const strength = validatePasswordStrength(password, username);
  if (!strength.ok) {
    return res.status(400).json({ error: strength.error });
  }

  try {
    const [result] = await getPool().query(
      'INSERT INTO users (username, password_hash, display_name, department, role, must_change_password) VALUES (?, ?, ?, ?, ?, 1)',
      [username, hashPassword(password), String(displayName || username).slice(0, 50), String(department || '').trim().slice(0, 100), role]
    );
    const insertId = (result as any).insertId;
    return res.status(201).json({
      success: true,
      user: { id: insertId, username, displayName: displayName || username, department: String(department || '').trim(), role, status: 'ACTIVE' },
    });
  } catch (err: any) {
    if (err?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '用户名已存在' });
    }
    console.error('[Admin] create user failed:', err);
    return res.status(500).json({ error: '用户创建失败' });
  }
});

// PUT /api/admin/users/:id { displayName?, role?, status?, department? }
router.put('/users/:id', async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId)) {
    return res.status(400).json({ error: '用户 ID 无效' });
  }

  const { displayName, role, status, department } = req.body || {};
  const updates: string[] = [];
  const params: any[] = [];

  if (displayName !== undefined) {
    updates.push('display_name = ?');
    params.push(String(displayName).slice(0, 50));
  }
  if (department !== undefined) {
    // P2-11 组织维度：部门是数据源授权的匹配键，仅管理员可改（防止用户自助改部门越权）
    updates.push('department = ?');
    params.push(String(department).trim().slice(0, 100));
  }
  if (role !== undefined) {
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: '角色无效' });
    }
    updates.push('role = ?');
    params.push(role);
  }
  if (status !== undefined) {
    if (!['ACTIVE', 'DISABLED'].includes(status)) {
      return res.status(400).json({ error: '状态无效' });
    }
    updates.push('status = ?');
    params.push(status);
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: '没有需要更新的字段' });
  }

  // 自我保护：不允许降级/禁用自己
  if (targetId === req.user!.id && (role !== undefined || status !== undefined)) {
    return res.status(400).json({ error: '不能修改自己的角色或状态' });
  }

  // 保证至少保留一个 ACTIVE 管理员
  const demotingAdmin = role !== undefined && role !== 'ADMIN';
  const disabling = status === 'DISABLED';
  if (demotingAdmin || disabling) {
    const [rows] = await getPool().query('SELECT role, status FROM users WHERE id = ?', [targetId]);
    const target = (rows as any[])[0];
    if (target?.role === 'ADMIN' && target?.status === 'ACTIVE') {
      const remaining = await countActiveAdmins(targetId);
      if (remaining < 1) {
        return res.status(400).json({ error: '系统至少需要保留一个可用管理员' });
      }
    }
  }

  try {
    params.push(targetId);
    const [result] = await getPool().query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    if ((result as any).affectedRows === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[Admin] update user failed:', err);
    return res.status(500).json({ error: '用户更新失败' });
  }
});

// POST /api/admin/users/:id/reset-password { newPassword }
router.post('/users/:id/reset-password', async (req, res) => {
  const targetId = Number(req.params.id);
  const { newPassword } = req.body || {};
  if (!Number.isInteger(targetId)) {
    return res.status(400).json({ error: '用户 ID 无效' });
  }
  // P0-1 统一密码强度校验；重置后强制目标用户下次登录改密
  const strength = validatePasswordStrength(newPassword);
  if (!strength.ok) {
    return res.status(400).json({ error: strength.error });
  }

  try {
    const [result] = await getPool().query(
      'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?',
      [hashPassword(newPassword), targetId]
    );
    if ((result as any).affectedRows === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[Admin] reset password failed:', err);
    return res.status(500).json({ error: '密码重置失败' });
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId)) {
    return res.status(400).json({ error: '用户 ID 无效' });
  }
  if (targetId === req.user!.id) {
    return res.status(400).json({ error: '不能删除当前登录的管理员账号' });
  }

  try {
    const [rows] = await getPool().query('SELECT role, status FROM users WHERE id = ?', [targetId]);
    const target = (rows as any[])[0];
    if (!target) {
      return res.status(404).json({ error: '用户不存在' });
    }
    if (target.role === 'ADMIN' && target.status === 'ACTIVE') {
      const remaining = await countActiveAdmins(targetId);
      if (remaining < 1) {
        return res.status(400).json({ error: '系统至少需要保留一个可用管理员' });
      }
    }

    await getPool().query('DELETE FROM users WHERE id = ?', [targetId]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Admin] delete user failed:', err);
    return res.status(500).json({ error: '用户删除失败' });
  }
});

export default router;
