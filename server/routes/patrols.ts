/**
 * P0-1 异常巡检订阅路由（挂载于 /api/patrols 前缀下）：
 * - GET    /                 巡检计划列表（所有登录用户可见，团队共享巡检结果；可按数据源过滤）
 * - POST   /                 新建巡检计划（ADMIN/ANALYST；绑定数据源 + 巡检间隔）
 * - PUT    /:patrolId        更新计划（名称/间隔/启停；仅创建人或 ADMIN）
 * - DELETE /:patrolId        删除计划及其运行历史（仅创建人或 ADMIN）
 * - POST   /:patrolId/run    立即执行一次巡检（仅创建人或 ADMIN，返回本次结果）
 * - GET    /:patrolId/runs   运行历史（新→旧，含异常明细 Top10）
 */
import { Router } from 'express';
import type { RowDataPacket } from 'mysql2';
import { authMiddleware, requireRole } from '../auth/auth';
import { rateLimiter } from '../infra/rateLimiter';
import { writeAudit } from '../infra/auditLog';
import { ERROR_CODES } from '../infra/errorCodes';
import { getPool } from '../infra/db';
import { logger } from '../infra/logger';
import {
  listPatrols,
  findPatrol,
  createPatrol,
  updatePatrol,
  deletePatrol,
  listPatrolRuns,
  executePatrol,
  toPatrolPlan,
  normalizePatrolInterval,
  PATROL_MIN_INTERVAL_MINUTES,
  PATROL_MAX_INTERVAL_MINUTES,
  type PatrolStatus,
} from '../anomalyPatrol';

const router = Router();
router.use(authMiddleware);

/** 越权统一 404 防探测（与 saved-reports 口径一致） */
async function loadOwnedPatrol(patrolId: string, user: { id: number; role: string }) {
  const row = await findPatrol(patrolId);
  if (!row) return { ok: false as const, status: 404, error: '巡检计划不存在' };
  if (row.user_id !== user.id && user.role !== 'ADMIN') {
    return { ok: false as const, status: 404, error: '巡检计划不存在' };
  }
  return { ok: true as const, row };
}

// GET /api/patrols?dataSourceId=xxx
router.get('/', async (req, res) => {
  const dataSourceId = typeof req.query.dataSourceId === 'string' ? req.query.dataSourceId : '';
  try {
    res.json({ ok: true, patrols: await listPatrols(dataSourceId || undefined) });
  } catch (err: any) {
    logger.error('GET /api/patrols error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '获取巡检计划失败' });
  }
});

// POST /api/patrols —— 新建巡检计划
router.post('/', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const dataSourceId = typeof req.body?.dataSourceId === 'string' ? req.body.dataSourceId.trim() : '';
  const intervalMinutes = normalizePatrolInterval(req.body?.intervalMinutes);
  if (!dataSourceId) return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '缺少 dataSourceId' });
  if (intervalMinutes === null) {
    return res.status(400).json({
      code: ERROR_CODES.INVALID_INPUT,
      error: `巡检间隔需为 ${PATROL_MIN_INTERVAL_MINUTES}~${PATROL_MAX_INTERVAL_MINUTES} 之间的整数分钟`,
    });
  }

  try {
    const pool = getPool();
    const [dsRows] = await pool.query<RowDataPacket[]>('SELECT id, name FROM data_sources WHERE id = ?', [dataSourceId]);
    if (dsRows.length === 0) return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: `数据源不存在：${dataSourceId}` });
    const dsName = String(dsRows[0].name || dataSourceId);

    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
    const name = rawName || `${dsName} 巡检`;
    const plan = await createPatrol({ name, dataSourceId, intervalMinutes, user: { id: user.id, username: user.username } });
    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'patrol',
      dataSourceId,
      question: `patrol-create:${name}`,
      status: 'SUCCESS',
      detail: `新建巡检计划 ${plan.patrolId}（每 ${intervalMinutes} 分钟）`,
    });
    res.status(201).json({ ok: true, patrol: plan });
  } catch (err: any) {
    logger.error('POST /api/patrols error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '创建巡检计划失败' });
  }
});

// PUT /api/patrols/:patrolId —— 更新（名称/间隔/启停）
router.put('/:patrolId', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const { patrolId } = req.params;
  const patch: { name?: string; intervalMinutes?: number; status?: PatrolStatus } = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim().slice(0, 100);
  if (req.body?.intervalMinutes !== undefined) {
    const iv = normalizePatrolInterval(req.body.intervalMinutes);
    if (iv === null) {
      return res.status(400).json({
        code: ERROR_CODES.INVALID_INPUT,
        error: `巡检间隔需为 ${PATROL_MIN_INTERVAL_MINUTES}~${PATROL_MAX_INTERVAL_MINUTES} 之间的整数分钟`,
      });
    }
    patch.intervalMinutes = iv;
  }
  if (req.body?.status !== undefined) {
    if (req.body.status !== 'ACTIVE' && req.body.status !== 'PAUSED') {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'status 仅支持 ACTIVE / PAUSED' });
    }
    patch.status = req.body.status;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '没有可更新的字段' });
  }

  try {
    const owned = await loadOwnedPatrol(patrolId, user);
    if (owned.ok === false) return res.status(owned.status).json({ code: ERROR_CODES.NOT_FOUND, error: owned.error });
    const ok = await updatePatrol(patrolId, patch);
    if (!ok) return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '巡检计划不存在' });
    const row = await findPatrol(patrolId);
    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'patrol',
      dataSourceId: String(owned.row.data_source_id || ''),
      question: `patrol-update:${patrolId}`,
      status: 'SUCCESS',
      detail: `更新巡检计划字段：${Object.keys(patch).join('/')}`,
    });
    res.json({ ok: true, patrol: row ? toPatrolPlan(row) : null });
  } catch (err: any) {
    logger.error('PUT /api/patrols/:patrolId error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '更新巡检计划失败' });
  }
});

// DELETE /api/patrols/:patrolId
router.delete('/:patrolId', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const { patrolId } = req.params;
  try {
    const owned = await loadOwnedPatrol(patrolId, user);
    if (owned.ok === false) return res.status(owned.status).json({ code: ERROR_CODES.NOT_FOUND, error: owned.error });
    const ok = await deletePatrol(patrolId);
    if (!ok) return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '巡检计划不存在' });
    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'patrol',
      dataSourceId: String(owned.row.data_source_id || ''),
      question: `patrol-delete:${patrolId}`,
      status: 'SUCCESS',
      detail: `删除巡检计划：${owned.row.name}`,
    });
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('DELETE /api/patrols/:patrolId error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '删除巡检计划失败' });
  }
});

// POST /api/patrols/:patrolId/run —— 立即执行一次（不改变既有排期）
router.post('/:patrolId/run', rateLimiter, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const user = req.user!;
  const { patrolId } = req.params;
  const startedAt = Date.now();
  try {
    const owned = await loadOwnedPatrol(patrolId, user);
    if (owned.ok === false) return res.status(owned.status).json({ code: ERROR_CODES.NOT_FOUND, error: owned.error });
    const outcome = await executePatrol(patrolId);
    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'patrol',
      dataSourceId: String(owned.row.data_source_id || ''),
      question: `patrol-run:${patrolId}`,
      status: outcome.status === 'ERROR' ? 'ERROR' : 'SUCCESS',
      detail: `手动巡检完成：${outcome.status}（异常 ${outcome.anomalyCount} 项）${outcome.error ? ` - ${outcome.error}` : ''}`,
      rowCount: outcome.anomalyCount,
      durationMs: Date.now() - startedAt,
    });
    res.json({ ok: true, result: outcome });
  } catch (err: any) {
    logger.error('POST /api/patrols/:patrolId/run error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '执行巡检失败' });
  }
});

// GET /api/patrols/:patrolId/runs?limit=20
router.get('/:patrolId/runs', async (req, res) => {
  const { patrolId } = req.params;
  const limit = Number(req.query.limit) || 20;
  try {
    const row = await findPatrol(patrolId);
    if (!row) return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '巡检计划不存在' });
    res.json({ ok: true, runs: await listPatrolRuns(patrolId, limit) });
  } catch (err: any) {
    logger.error('GET /api/patrols/:patrolId/runs error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '获取运行历史失败' });
  }
});

export default router;
