/**
 * v0.9.98 需求收集与意见反馈路由（挂载 /api/requirements）：
 * - POST   /                 提交需求/建议/缺陷（登录用户，任意角色）
 * - GET    /mine             我的提交列表
 * - GET    /                 全部提交（ADMIN，?status=&kind= 过滤）
 * - GET    /summary          统计摘要（ADMIN：按状态/类型/基线优先级计数）
 * - POST   /:id/review       ADMIN 评估分析：BASELINE 纳入基线 / REJECT 不予采纳 / PENDING 退回
 * - DELETE /:id              删除条目（ADMIN，审计留痕）
 * - GET    /export           标准导出接口（requireOpsAccess 双通道：OPS_API_TOKEN 或 ADMIN JWT），
 *                            默认仅导出已纳入基线（status=BASELINED）的条目，供 AIOps 平台主动分析；
 *                            接口能力自描述见 GET /.well-known/requirements.json
 */
import { Router } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { authMiddleware, requireRole, requireOpsAccess } from '../auth/auth';
import { getPool } from '../infra/db';
import { rateLimiter } from '../infra/rateLimiter';
import { writeAudit } from '../infra/auditLog';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';

const router = Router();

const VALID_KIND = new Set(['REQUIREMENT', 'SUGGESTION', 'BUG', 'OTHER']);
const VALID_STATUS = new Set(['PENDING', 'BASELINED', 'REJECTED']);
const VALID_PRIORITY = new Set(['P0', 'P1', 'P2', 'P3']);
/** 评估动作：BASELINE 纳入基线 / REJECT 不予采纳 / PENDING 退回待评估（误操作纠正） */
const VALID_REVIEW_ACTION = new Set(['BASELINE', 'REJECT', 'PENDING']);
/** 时间过滤白名单格式（原样传 DB，避免非法输入；与 opsEvents 同口径） */
const TIME_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const MAX_TITLE = 200;
const MAX_CONTENT = 5000;
const MAX_ASSESSMENT = 2000;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** DB 行 → 对外条目结构（导出接口与前端列表共用同一映射，字段命名保持稳定） */
function rowToEntry(row: RowDataPacket) {
  return {
    id: Number(row.id),
    kind: row.kind,
    title: row.title,
    content: row.content,
    status: row.status,
    priority: row.priority || '',
    baselineVersion: row.baseline_version || '',
    assessment: row.assessment || '',
    submitter: row.username,
    department: row.department || '',
    reviewer: row.reviewer || '',
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

// ---------- 用户侧：提交 / 我的列表 ----------

// POST /api/requirements { kind?, title, content }（登录用户均可提交）
router.post('/', authMiddleware, rateLimiter, async (req, res) => {
  const user = req.user!;
  const kind = String(req.body?.kind || 'REQUIREMENT').trim().toUpperCase();
  const title = String(req.body?.title || '').trim().slice(0, MAX_TITLE);
  const content = String(req.body?.content || '').trim().slice(0, MAX_CONTENT);

  if (!VALID_KIND.has(kind)) {
    return res.status(400).json({ error: '类型无效（REQUIREMENT / SUGGESTION / BUG / OTHER）' });
  }
  if (!title) return res.status(400).json({ error: '请填写标题' });
  if (!content) return res.status(400).json({ error: '请填写内容描述' });

  try {
    const [result] = await getPool().query<ResultSetHeader>(
      'INSERT INTO feedback_entries (kind, title, content, user_id, username, department) VALUES (?, ?, ?, ?, ?, ?)',
      [kind, title, content, user.id, user.username, user.department || '']
    );
    return res.status(201).json({ success: true, id: Number(result.insertId) });
  } catch (err) {
    logger.error('[Requirements] 提交失败:', getErrorMessage(err));
    return res.status(500).json({ error: '提交失败，请稍后重试' });
  }
});

// GET /api/requirements/mine
router.get('/mine', authMiddleware, async (req, res) => {
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      'SELECT * FROM feedback_entries WHERE user_id = ? ORDER BY id DESC LIMIT 100',
      [req.user!.id]
    );
    return res.json({ success: true, entries: rows.map(rowToEntry) });
  } catch (err) {
    logger.error('[Requirements] 我的列表获取失败:', getErrorMessage(err));
    return res.status(500).json({ error: '列表获取失败' });
  }
});

// ---------- 管理侧：列表 / 摘要 / 评估 / 删除 ----------

// GET /api/requirements?status=&kind=（ADMIN；默认待评估优先排序）
router.get('/', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  const status = String(req.query.status || '').trim().toUpperCase();
  const kind = String(req.query.kind || '').trim().toUpperCase();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status && VALID_STATUS.has(status)) { clauses.push('status = ?'); params.push(status); }
  if (kind && VALID_KIND.has(kind)) { clauses.push('kind = ?'); params.push(kind); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT * FROM feedback_entries ${where} ORDER BY status = 'PENDING' DESC, id DESC LIMIT 500`,
      params
    );
    return res.json({ success: true, entries: rows.map(rowToEntry) });
  } catch (err) {
    logger.error('[Requirements] 管理列表获取失败:', getErrorMessage(err));
    return res.status(500).json({ error: '列表获取失败' });
  }
});

// GET /api/requirements/summary（ADMIN；供管理面板统计卡）
router.get('/summary', authMiddleware, requireRole('ADMIN'), async (_req, res) => {
  try {
    const pool = getPool();
    const [[statusRows], [kindRows], [priorityRows]] = await Promise.all([
      pool.query<RowDataPacket[]>('SELECT status, COUNT(*) AS cnt FROM feedback_entries GROUP BY status'),
      pool.query<RowDataPacket[]>('SELECT kind, COUNT(*) AS cnt FROM feedback_entries GROUP BY kind'),
      pool.query<RowDataPacket[]>(
        "SELECT priority, COUNT(*) AS cnt FROM feedback_entries WHERE status = 'BASELINED' GROUP BY priority"
      ),
    ]);
    return res.json({ success: true, byStatus: statusRows, byKind: kindRows, byPriority: priorityRows });
  } catch (err) {
    logger.error('[Requirements] 摘要获取失败:', getErrorMessage(err));
    return res.status(500).json({ error: '摘要获取失败' });
  }
});

// POST /api/requirements/:id/review（ADMIN）{ action, priority?, baselineVersion?, assessment? }
router.post('/:id/review', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '条目 ID 无效' });

  const action = String(req.body?.action || '').trim().toUpperCase();
  if (!VALID_REVIEW_ACTION.has(action)) {
    return res.status(400).json({ error: 'action 无效（BASELINE / REJECT / PENDING）' });
  }
  const assessment = String(req.body?.assessment || '').trim().slice(0, MAX_ASSESSMENT);
  const priority = String(req.body?.priority || '').trim().toUpperCase();
  const baselineVersion = String(req.body?.baselineVersion || '').trim().slice(0, 50);

  if (action === 'BASELINE') {
    if (!assessment) return res.status(400).json({ error: '纳入基线前须填写评估分析意见' });
    if (priority && !VALID_PRIORITY.has(priority)) {
      return res.status(400).json({ error: 'priority 无效（P0 / P1 / P2 / P3）' });
    }
  }

  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      'SELECT id, title, status FROM feedback_entries WHERE id = ? LIMIT 1',
      [id]
    );
    const entry = rows[0];
    if (!entry) return res.status(404).json({ error: '条目不存在' });

    const who = req.user!.username;
    let newStatus: string;
    if (action === 'BASELINE') {
      newStatus = 'BASELINED';
      await getPool().query(
        `UPDATE feedback_entries
         SET status = 'BASELINED', priority = ?, baseline_version = ?, assessment = ?, reviewer = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [priority || 'P2', baselineVersion, assessment, who, id]
      );
    } else if (action === 'REJECT') {
      newStatus = 'REJECTED';
      await getPool().query(
        `UPDATE feedback_entries
         SET status = 'REJECTED', priority = '', baseline_version = '', assessment = ?, reviewer = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [assessment, who, id]
      );
    } else {
      // 退回待评估：清空决策字段，保留 assessment（评估笔记不丢，便于后续再评估）
      newStatus = 'PENDING';
      await getPool().query(
        `UPDATE feedback_entries
         SET status = 'PENDING', priority = '', baseline_version = '', reviewer = '', reviewed_at = NULL
         WHERE id = ?`,
        [id]
      );
    }

    const actionLabel =
      action === 'BASELINE'
        ? `纳入基线${baselineVersion ? `（${baselineVersion}）` : ''}`
        : action === 'REJECT'
          ? '不予采纳'
          : '退回待评估';
    writeAudit({
      userId: req.user!.id,
      username: who,
      endpoint: 'admin',
      status: 'SUCCESS',
      detail: `需求反馈 #${id}「${String(entry.title).slice(0, 60)}」${actionLabel}${assessment ? `：${assessment.slice(0, 100)}` : ''}`,
    });

    return res.json({ success: true, id, status: newStatus });
  } catch (err) {
    logger.error('[Requirements] 评估失败:', getErrorMessage(err));
    return res.status(500).json({ error: '评估操作失败' });
  }
});

// DELETE /api/requirements/:id（ADMIN）
router.delete('/:id', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '条目 ID 无效' });
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      'SELECT title FROM feedback_entries WHERE id = ? LIMIT 1',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: '条目不存在' });
    await getPool().query('DELETE FROM feedback_entries WHERE id = ?', [id]);
    writeAudit({
      userId: req.user!.id,
      username: req.user!.username,
      endpoint: 'admin',
      status: 'SUCCESS',
      detail: `需求反馈 #${id}「${String(rows[0].title).slice(0, 60)}」已删除`,
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error('[Requirements] 删除失败:', getErrorMessage(err));
    return res.status(500).json({ error: '删除失败' });
  }
});

// ---------- 标准导出接口（供 AIOps 平台拉取做主动需求分析） ----------

/**
 * GET /api/requirements/export?status=&kind=&since=&limit=
 * 默认仅导出已纳入基线（BASELINED）的条目；`since` 按 updated_at 增量拉取；
 * 响应自带 spec_version/service 便于消费方做版本协商（能力自描述见 well-known）。
 */
router.get('/export', requireOpsAccess, async (req, res) => {
  const status = String(req.query.status || 'BASELINED').trim().toUpperCase();
  const kind = String(req.query.kind || '').trim().toUpperCase();
  const since = String(req.query.since || '').trim();
  const limit = clampInt(req.query.limit, 1, 500, 200);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status && status !== 'ALL') {
    if (!VALID_STATUS.has(status)) {
      return res.status(400).json({ error: 'status 无效（BASELINED / PENDING / REJECTED / ALL）' });
    }
    clauses.push('status = ?');
    params.push(status);
  }
  if (kind) {
    if (!VALID_KIND.has(kind)) {
      return res.status(400).json({ error: 'kind 无效（REQUIREMENT / SUGGESTION / BUG / OTHER）' });
    }
    clauses.push('kind = ?');
    params.push(kind);
  }
  if (since) {
    if (!TIME_RE.test(since)) {
      return res.status(400).json({ error: 'since 格式无效（YYYY-MM-DD[ HH:MM[:SS]]）' });
    }
    clauses.push('updated_at >= ?');
    params.push(since);
  }

  try {
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT * FROM feedback_entries ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      [...params, limit]
    );
    const entries = rows.map(rowToEntry);
    return res.json({
      spec_version: '1.0',
      service: 'nl2sql',
      system: '智能问数据分析系统',
      exportedAt: new Date().toISOString(),
      filter: { status: status || 'BASELINED', kind: kind || null, since: since || null },
      returned: entries.length,
      entries,
    });
  } catch (err) {
    logger.error('[Requirements] 导出失败:', getErrorMessage(err));
    return res.status(500).json({ error: '导出失败' });
  }
});

export default router;
