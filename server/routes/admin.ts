/**
 * 管理员用户管理路由（仅 ADMIN 角色）。
 * 保护规则：不能修改/删除自己，且必须始终保留至少一个 ACTIVE 管理员。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth/auth';
import { getPool } from '../infra/db';
import { hashPassword, validatePasswordStrength } from '../auth/passwords';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { logger } from '../infra/logger';
import { writeAudit } from '../infra/auditLog';
import { ENV_CONFIG_HIDDEN, sanitizeEnvConfigUpdates, applyEnvConfigToProcess } from '../infra/envConfigCatalog';
import { getErrorMessage, getErrorCode } from '../infra/errorUtils';
import { parseUserOrgScope, MAX_SCOPE_ITEMS } from '../query/orgScope';

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

const VALID_ROLES = ['ADMIN', 'ANALYST', 'VIEWER'] as const;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const SCOPE_LEVELS = ['ALL', 'ORG', 'TEAM', 'SELF'] as const;

/**
 * 校验并序列化用户数据范围（组织权限模型）：
 * ALL/空/null = 不限制（存 NULL）；ORG/TEAM/SELF 要求授权值非空，非法档位/空值显式拒绝，
 * 避免「配了档位却没给值」被当作不限制而静默失效（解析层同样做兜底）。
 */
function serializeOrgScopeInput(raw: unknown): { ok: true; json: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, json: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '数据范围格式无效' };
  const obj = raw as Record<string, unknown>;
  const level = String(obj.level || '').toUpperCase();
  if (!SCOPE_LEVELS.includes(level as (typeof SCOPE_LEVELS)[number])) {
    return { ok: false, error: '数据范围档位无效，可选：ALL（全辖）/ ORG（本机构）/ TEAM（本项目团队）/ SELF（仅本人）' };
  }
  if (level === 'ALL') return { ok: true, json: null };
  if (level === 'ORG' && Array.isArray(obj.orgs) && obj.orgs.length > MAX_SCOPE_ITEMS) {
    return { ok: false, error: `机构数量不能超过 ${MAX_SCOPE_ITEMS} 个` };
  }
  if (level === 'TEAM' && Array.isArray(obj.teams) && obj.teams.length > MAX_SCOPE_ITEMS) {
    return { ok: false, error: `团队数量不能超过 ${MAX_SCOPE_ITEMS} 个` };
  }
  const scope = parseUserOrgScope({ ...obj, level });
  if (!scope) {
    const hint = level === 'ORG' ? '机构档位需至少填写一个机构编号' : level === 'TEAM' ? '团队档位需至少填写一个团队名称' : '本人档位需填写经办人编号';
    return { ok: false, error: hint };
  }
  return { ok: true, json: JSON.stringify(scope) };
}

async function countActiveAdmins(excludeId?: number): Promise<number> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT COUNT(*) AS cnt FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'${excludeId ? ' AND id != ?' : ''}`,
    excludeId ? [excludeId] : []
  );
  return Number(rows[0]?.cnt || 0);
}

// GET /api/admin/users
router.get('/users', async (_req, res) => {
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT id, username, display_name AS displayName, department, role, status, must_change_password AS mustChangePassword,
              org_scope_json AS orgScopeJson,
              created_at AS createdAt, last_login_at AS lastLoginAt
       FROM users ORDER BY id ASC`
    );
    // 数据范围以解析后的对象返回（存储为 JSON 文本，前端直接用于编辑表单）
    const users = rows.map((row) => {
      const { orgScopeJson, ...rest } = row as RowDataPacket & { orgScopeJson: string | null };
      return { ...rest, orgScope: parseUserOrgScope(orgScopeJson) };
    });
    return res.json({ success: true, users });
  } catch (err) {
    logger.error('[Admin] list users failed:', err);
    return res.status(500).json({ error: '用户列表获取失败' });
  }
});

// POST /api/admin/users { username, password, displayName, role, department?, orgScope? }
router.post('/users', async (req, res) => {
  const { username, password, displayName, role, department, orgScope } = req.body || {};
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
  // 组织权限模型：可选的数据范围（未传/ALL = 不限制）
  const scopeInput = serializeOrgScopeInput(orgScope);
  if (scopeInput.ok === false) {
    return res.status(400).json({ error: scopeInput.error });
  }

  try {
    const [result] = await getPool().query<ResultSetHeader>(
      'INSERT INTO users (username, password_hash, display_name, department, role, org_scope_json, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1)',
      [username, hashPassword(password), String(displayName || username).slice(0, 50), String(department || '').trim().slice(0, 100), role, scopeInput.json]
    );
    const insertId = result.insertId;
    return res.status(201).json({
      success: true,
      user: { id: insertId, username, displayName: displayName || username, department: String(department || '').trim(), role, status: 'ACTIVE', orgScope: parseUserOrgScope(scopeInput.json) },
    });
  } catch (err) {
    if (getErrorCode(err) === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '用户名已存在' });
    }
    logger.error('[Admin] create user failed:', err);
    return res.status(500).json({ error: '用户创建失败' });
  }
});

// PUT /api/admin/users/:id { displayName?, role?, status?, department?, orgScope? }
router.put('/users/:id', async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId)) {
    return res.status(400).json({ error: '用户 ID 无效' });
  }

  const { displayName, role, status, department, orgScope } = req.body || {};
  const updates: string[] = [];
  const params: unknown[] = [];

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
  if (orgScope !== undefined) {
    // 组织权限模型：用户数据范围（null/ALL 存 NULL = 不限制）；仅管理员可改
    const serialized = serializeOrgScopeInput(orgScope);
    if (serialized.ok === false) {
      return res.status(400).json({ error: serialized.error });
    }
    updates.push('org_scope_json = ?');
    params.push(serialized.json);
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
    const [rows] = await getPool().query<RowDataPacket[]>('SELECT role, status FROM users WHERE id = ?', [targetId]);
    const target = rows[0];
    if (target?.role === 'ADMIN' && target?.status === 'ACTIVE') {
      const remaining = await countActiveAdmins(targetId);
      if (remaining < 1) {
        return res.status(400).json({ error: '系统至少需要保留一个可用管理员' });
      }
    }
  }

  try {
    params.push(targetId);
    const [result] = await getPool().query<ResultSetHeader>(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    return res.json({ success: true });
  } catch (err) {
    logger.error('[Admin] update user failed:', err);
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
    const [result] = await getPool().query<ResultSetHeader>(
      'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?',
      [hashPassword(newPassword), targetId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    return res.json({ success: true });
  } catch (err) {
    logger.error('[Admin] reset password failed:', err);
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
    const [rows] = await getPool().query<RowDataPacket[]>('SELECT role, status FROM users WHERE id = ?', [targetId]);
    const target = rows[0];
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
    logger.error('[Admin] delete user failed:', err);
    return res.status(500).json({ error: '用户删除失败' });
  }
});

// ============ v0.5.0 Environment Config Management ============

// GET /api/admin/env-config
router.get('/env-config', async (req, res) => {
  try {
    // 权限校验：仅 ADMIN 可查看
    if (!req.user || req.user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // 注意：必须查 updated_at，前端「更新时间」列依赖该字段（漏查会显示 Invalid Date）
    const [rows] = await getPool().query<RowDataPacket[]>('SELECT `key`, `value`, category, description, is_sensitive, updated_at FROM env_config');

    // 脱敏敏感字段 + v0.9.61 运行时对账（面板保存值 vs process.env 实际生效值；敏感项仅暴露已配置布尔）
    const sanitizedData = rows.map((row) => ({
      ...row,
      value: row.is_sensitive ? ENV_CONFIG_HIDDEN : (row.value || ''),
      runtime_configured: Boolean(process.env[row.key]),
      runtime_value: row.is_sensitive ? '' : (process.env[row.key] || '')
    }));

    res.json({ success: true, data: sanitizedData });
  } catch (error) {
    logger.error('[EnvConfig] GET failed:', getErrorMessage(error));
    res.status(500).json({ success: false, error: getErrorMessage(error) || 'Internal server error' });
  }
});

// PUT /api/admin/env-config
router.put('/env-config', async (req, res) => {
  try {
    // 权限校验
    if (!req.user || req.user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // v0.9.61 校验与过滤：结构/白名单校验 + 脱敏哨兵按「未修改」跳过（防 ***hidden*** 回写覆盖真实值）
    const parsed = sanitizeEnvConfigUpdates((req.body || {}).updates);
    if (!parsed.ok) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    if (parsed.accepted.length === 0) {
      return res.json({ success: true, message: 'No changes (sensitive fields unmodified)', applied: [], skippedUnchanged: parsed.skippedUnchanged });
    }
    const updates = parsed.accepted;

    // 批量更新（ON DUPLICATE KEY UPDATE 须显式刷新 updated_at，该列无 ON UPDATE 属性）
    for (const upd of updates) {
      await getPool().query(
        'INSERT INTO env_config (`key`, `value`, updated_by, updated_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE `value`=?, updated_by=?, updated_at=NOW()',
        [upd.key, upd.value, req.user.id, upd.value, req.user.id]
      );
    }

    // v0.9.61 即时热更：保存值立即合并进 process.env（LLM 引擎/限流/缓存等无需重启生效；
    // MYSQL_* 连接配置不参与——自举悖论，见 envConfigCatalog 说明）
    const applied = applyEnvConfigToProcess(updates);

    // 审计日志（统一走 writeAudit 写入 query_audit_log，fail-open 不阻塞主流程；敏感值一律脱敏）
    writeAudit({
      userId: req.user.id,
      username: req.user.username,
      endpoint: 'admin',
      status: 'SUCCESS',
      detail: `环境配置更新 ${updates.length} 项（即时生效 ${applied.length} 项）：${updates.map(u => `${u.key}=***`).join(', ')}`,
    });

    res.json({
      success: true,
      message: `Updated ${updates.length} config items (hot-applied ${applied.length})`,
      applied,
      skippedUnchanged: parsed.skippedUnchanged,
      audit_log: {
        user_id: req.user.id,
        username: req.user.username,
        timestamp: new Date().toISOString(),
        changes: updates.map(u => u.key)
      }
    });
  } catch (error) {
    logger.error('[EnvConfig] PUT failed:', getErrorMessage(error));
    res.status(500).json({ success: false, error: getErrorMessage(error) || 'Internal server error' });
  }
});

export default router;
