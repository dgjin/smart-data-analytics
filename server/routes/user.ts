/**
 * v0.9.104 用户信息维护路由（挂载 /api/user，见 server.ts）：
 * - GET /personal：读取当前登录用户的个性化信息（昵称 / 头像 / 个人签名 + 偏好设置），
 *   未维护过时回退缺省值（DEFAULT_USER_PERSONAL_INFO），前端表单打开即有完整结构；
 * - PUT /personal：维护当前登录用户的个性化信息——与前端表单共用 normalizeUserPersonalInfo
 *   （src/components/flexquery/flexQueryShared.ts）做白名单校验与归一化，校验不通过返回 400。
 * 数据落 user_personal_info 表（随 initSchema 幂等建表，每用户一条）；登录用户即可用，仅本人可读写。
 */
import { Router } from 'express';
import type { RowDataPacket } from 'mysql2';
import { authMiddleware } from '../auth/auth';
import { getPool } from '../infra/db';
import { ERROR_CODES } from '../infra/errorCodes';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';
import { safeParseJson } from '../../src/utils/queryResultNormalizer';
import {
  DEFAULT_USER_PERSONAL_INFO,
  normalizeUserPersonalInfo,
} from '../../src/components/flexquery/flexQueryShared';

const router = Router();

/** 个性化信息缺省值副本（避免响应层共享可变对象） */
function defaultPersonalInfo() {
  return { ...DEFAULT_USER_PERSONAL_INFO, preferences: { ...DEFAULT_USER_PERSONAL_INFO.preferences } };
}

/** DB 行 → 个性化信息：经共用校验归一化（兼容存量脏数据），非法时整体回退缺省值 */
function rowToPersonalInfo(row: RowDataPacket) {
  const normalized = normalizeUserPersonalInfo({
    nickname: row.nickname || '',
    avatar: row.avatar || '',
    signature: row.signature || '',
    preferences: safeParseJson(String(row.preferences_json || '')) || {},
  });
  return normalized.ok ? normalized.value : defaultPersonalInfo();
}

// GET /api/user/personal —— 当前用户的个性化信息（缺省字段回退缺省值）
router.get('/personal', authMiddleware, async (req, res) => {
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      'SELECT nickname, avatar, signature, preferences_json FROM user_personal_info WHERE user_id = ? LIMIT 1',
      [req.user!.id]
    );
    return res.json(rows[0] ? rowToPersonalInfo(rows[0]) : defaultPersonalInfo());
  } catch (err) {
    logger.error(`[User] 个性化信息读取失败: ${getErrorMessage(err)}`);
    return res.status(500).json({ error: '个性化信息读取失败，请稍后重试' });
  }
});

// PUT /api/user/personal { nickname?, avatar?, signature?, preferences? } —— 维护当前用户个性化信息
router.put('/personal', authMiddleware, async (req, res) => {
  const parsed = normalizeUserPersonalInfo(req.body);
  // 注：必须显式 `=== false`——默认 tsconfig 未开 strict，`!parsed.ok` 不会窄化联合类型
  if (parsed.ok === false) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: parsed.error });
  }
  const value = parsed.value;
  try {
    await getPool().query(
      `INSERT INTO user_personal_info (user_id, nickname, avatar, signature, preferences_json)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), avatar = VALUES(avatar),
         signature = VALUES(signature), preferences_json = VALUES(preferences_json)`,
      [req.user!.id, value.nickname, value.avatar, value.signature, JSON.stringify(value.preferences)]
    );
    return res.json(value);
  } catch (err) {
    logger.error(`[User] 个性化信息保存失败: ${getErrorMessage(err)}`);
    return res.status(500).json({ error: '个性化信息保存失败，请稍后重试' });
  }
});

export default router;
