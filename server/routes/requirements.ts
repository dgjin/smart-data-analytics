/**
 * v0.9.98 需求收集与意见反馈路由（挂载 /api/requirements）：
 * - POST   /                 提交需求/建议/缺陷（登录用户，任意角色；系统管理「需求反馈录入」
 *                            复用本接口，body 支持可选 priority P0-P3，随提交一并入库）
 * - GET    /mine             我的提交列表
 * - GET    /                 全部提交（ADMIN，?status=&kind= 过滤；条目附 revisions 评估历史）
 * - GET    /summary          统计摘要（ADMIN：按状态/类型/基线优先级计数）
 * - POST   /:id/review       ADMIN 评估分析：BASELINE 纳入基线 / REJECT 不予采纳 / PENDING 退回；
 *                            每次评估（含继续评估）追加一条 feedback_entry_revisions 留痕
 * - DELETE /:id              删除条目（ADMIN，审计留痕）
 * - GET    /ops-progress     智能运维系统处理进度代理（v0.9.105，登录用户；?ids= 逗号分隔，
 *                            非 ADMIN 仅限本人提交的条目；未配置 AIOPS_TRACK_URL /
 *                            AIOPS_TRACK_TOKEN 时 configured=false 隐藏进度展示）
 * - GET    /export           标准导出接口（requireOpsAccess 双通道：OPS_API_TOKEN 或 ADMIN JWT），
 *                            默认仅导出已纳入基线（status=BASELINED）的条目，供 AIOps 平台主动分析；
 *                            条目附 revisions（评估历史，升序；替代次评估的新内容经此被 AIOps 获取）；
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
/** 导出/列表附带的评估历史条数上限（升序截取最近 N 条，防极端历史撑大响应） */
const MAX_REVISIONS_PER_ENTRY = 20;

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

/** DB 行 → 评估历史条目（v0.9.102；「继续评估」的每次结论均留痕） */
function rowToRevision(row: RowDataPacket) {
  return {
    id: Number(row.id),
    entryId: Number(row.entry_id),
    action: row.action,
    priority: row.priority || '',
    baselineVersion: row.baseline_version || '',
    assessment: row.assessment || '',
    reviewer: row.reviewer || '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

type RevisionItem = ReturnType<typeof rowToRevision>;

/** 批量加载评估历史并按条目分组（时间升序；超出上限截取最近 N 条） */
async function loadRevisions(entryIds: number[]): Promise<Map<number, RevisionItem[]>> {
  const grouped = new Map<number, RevisionItem[]>();
  if (!entryIds.length) return grouped;
  const placeholders = entryIds.map(() => '?').join(',');
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT * FROM feedback_entry_revisions WHERE entry_id IN (${placeholders}) ORDER BY id ASC`,
    entryIds
  );
  for (const row of rows) {
    const rev = rowToRevision(row);
    const list = grouped.get(rev.entryId) || [];
    list.push(rev);
    grouped.set(rev.entryId, list);
  }
  for (const [entryId, list] of grouped) {
    if (list.length > MAX_REVISIONS_PER_ENTRY) grouped.set(entryId, list.slice(-MAX_REVISIONS_PER_ENTRY));
  }
  return grouped;
}

// ---------- 用户侧：提交 / 我的列表 ----------

// POST /api/requirements { kind?, title, content, priority? }（登录用户均可提交）
router.post('/', authMiddleware, rateLimiter, async (req, res) => {
  const user = req.user!;
  const kind = String(req.body?.kind || 'REQUIREMENT').trim().toUpperCase();
  const title = String(req.body?.title || '').trim().slice(0, MAX_TITLE);
  const content = String(req.body?.content || '').trim().slice(0, MAX_CONTENT);
  const priority = String(req.body?.priority || '').trim().toUpperCase();

  if (!VALID_KIND.has(kind)) {
    return res.status(400).json({ error: '类型无效（REQUIREMENT / SUGGESTION / BUG / OTHER）' });
  }
  if (!title) return res.status(400).json({ error: '请填写标题' });
  if (!content) return res.status(400).json({ error: '请填写内容描述' });
  if (priority && !VALID_PRIORITY.has(priority)) {
    return res.status(400).json({ error: '优先级无效（P0 / P1 / P2 / P3）' });
  }

  try {
    const [result] = await getPool().query<ResultSetHeader>(
      'INSERT INTO feedback_entries (kind, title, content, priority, user_id, username, department) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [kind, title, content, priority, user.id, user.username, user.department || '']
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

// ---------- 智能运维系统处理进度代理（v0.9.105） ----------

/**
 * 需求在智能运维系统（AIOps）的处理进度：「我的反馈」与「管理面板」需要看到需求
 * 经「智能分析 → 管理员批准 → 修复发布」的流转进度。本服务以服务令牌通道调用
 * AIOps 只读接口 GET /api/requirements/track（其发布状态为查询时动态解析），
 * 把 stage/timeline 按条目归集后返回，前端与本地状态合并展示。
 * - 未配置 AIOPS_TRACK_URL / AIOPS_TRACK_TOKEN → configured=false（前端隐藏进度区）；
 * - 上游失败 → ok=false + error（不缓存，下次请求立即重试）；
 * - 归属隔离：非 ADMIN 仅能查询本人提交的条目（越权 ID 静默剔除，不泄露存在性）。
 */
const OPS_TRACK_TTL_MS = 20_000;
const OPS_TRACK_TIMEOUT_MS = 5_000;
const MAX_TRACK_IDS = 100;
/** 进度缓存（key=条目 ID 串，仅成功响应入缓存；插入序淘汰超量键） */
const opsTrackCache = new Map<string, { at: number; ops: Record<string, unknown> }>();

/** 调 AIOps 只读进度接口（Bearer 服务令牌；5s 超时；按条目 ID 归集 entries） */
async function fetchOpsTrack(
  ids: number[]
): Promise<{ ok: boolean; error?: string; ops?: Record<string, unknown> }> {
  const base = String(process.env.AIOPS_TRACK_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.AIOPS_TRACK_TOKEN || '').trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPS_TRACK_TIMEOUT_MS);
  try {
    const resp = await fetch(
      `${base}/api/requirements/track?entry_ids=${encodeURIComponent(ids.join(','))}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }
    );
    if (!resp.ok) return { ok: false, error: `智能运维系统返回 HTTP ${resp.status}` };
    const data = (await resp.json()) as {
      ok?: boolean;
      error?: string;
      entries?: Array<Record<string, unknown>>;
    };
    if (data?.ok === false) {
      return { ok: false, error: String(data.error || '智能运维系统未接受请求') };
    }
    const ops: Record<string, unknown> = {};
    for (const item of data?.entries || []) {
      const entryId = String(item?.entry_id || '');
      if (entryId) ops[entryId] = item;
    }
    return { ok: true, ops };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    return { ok: false, error: aborted ? '智能运维系统响应超时' : '无法连接智能运维系统' };
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/requirements/ops-progress?ids=1,2,3
router.get('/ops-progress', authMiddleware, async (req, res) => {
  const raw = String(req.query.ids || '').trim();
  const ids: number[] = [];
  for (const part of raw.split(',')) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }
  if (!ids.length) return res.status(400).json({ error: '缺少 ids（逗号分隔的需求条目 ID 列表）' });
  if (ids.length > MAX_TRACK_IDS) return res.status(400).json({ error: `ids 最多 ${MAX_TRACK_IDS} 个` });

  const configured = Boolean(
    String(process.env.AIOPS_TRACK_URL || '').trim() && String(process.env.AIOPS_TRACK_TOKEN || '').trim()
  );
  if (!configured) return res.json({ success: true, configured: false, ops: {} });

  try {
    // 归属过滤：非 ADMIN 先回查本人提交的条目，越权 ID 静默剔除
    let allowed = ids;
    if (req.user!.role !== 'ADMIN') {
      const placeholders = ids.map(() => '?').join(',');
      const [rows] = await getPool().query<RowDataPacket[]>(
        `SELECT id FROM feedback_entries WHERE user_id = ? AND id IN (${placeholders})`,
        [req.user!.id, ...ids]
      );
      const mine = new Set(rows.map((r) => Number(r.id)));
      allowed = ids.filter((id) => mine.has(id));
    }
    if (!allowed.length) return res.json({ success: true, configured: true, ok: true, ops: {} });

    // 缓存按「排序后的 ID 串」共享（进度数据与用户无关；顺序稳定提高命中率）
    const cacheKey = [...allowed].sort((a, b) => a - b).join(',');
    const cached = opsTrackCache.get(cacheKey);
    if (cached && Date.now() - cached.at < OPS_TRACK_TTL_MS) {
      return res.json({ success: true, configured: true, ok: true, ops: cached.ops, cached: true });
    }

    const result = await fetchOpsTrack(allowed);
    if (!result.ok || !result.ops) {
      // 失败不缓存：AIOps 短暂不可用时，下一次请求立即重试
      const error = result.error || '处理进度获取失败';
      return res.json({ success: true, configured: true, ok: false, error, ops: {} });
    }
    opsTrackCache.set(cacheKey, { at: Date.now(), ops: result.ops });
    if (opsTrackCache.size > 200) {
      const oldest = opsTrackCache.keys().next().value;
      if (oldest !== undefined) opsTrackCache.delete(oldest);
    }
    return res.json({ success: true, configured: true, ok: true, ops: result.ops });
  } catch (err) {
    logger.error('[Requirements] 处理进度获取失败:', getErrorMessage(err));
    return res.json({ success: true, configured: true, ok: false, error: '处理进度获取失败，请稍后重试', ops: {} });
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
    // v0.9.102 附评估历史（管理面板展开行展示「继续评估」完整时间线）
    const entries = rows.map(rowToEntry);
    const revisions = await loadRevisions(entries.map((e) => e.id));
    return res.json({
      success: true,
      entries: entries.map((e) => ({ ...e, revisions: revisions.get(e.id) || [] })),
    });
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
    // 评估历史落库值（与主表 UPDATE 语义一致：非 BASELINE 不携带优先级/基线版本）
    let revPriority = '';
    let revVersion = '';
    if (action === 'BASELINE') {
      newStatus = 'BASELINED';
      revPriority = priority || 'P2';
      revVersion = baselineVersion;
      await getPool().query(
        `UPDATE feedback_entries
         SET status = 'BASELINED', priority = ?, baseline_version = ?, assessment = ?, reviewer = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [revPriority, baselineVersion, assessment, who, id]
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

    // v0.9.102 评估历史留痕：每次评估（含继续评估）追加一条——
    // 「继续评估」产生的新结论经导出接口 revisions 字段提供给 AIOps 同步分析基线
    await getPool().query(
      'INSERT INTO feedback_entry_revisions (entry_id, action, priority, baseline_version, assessment, reviewer) VALUES (?, ?, ?, ?, ?, ?)',
      [id, action, revPriority, revVersion, assessment, who]
    );

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
    // v0.9.102 条目附评估历史（升序）：继续评估产生的新内容随条目一并提供给 AIOps
    const entries = rows.map(rowToEntry);
    const revisions = await loadRevisions(entries.map((e) => e.id));
    return res.json({
      spec_version: '1.0',
      service: 'nl2sql',
      system: '智能问数据分析系统',
      exportedAt: new Date().toISOString(),
      filter: { status: status || 'BASELINED', kind: kind || null, since: since || null },
      returned: entries.length,
      entries: entries.map((e) => ({ ...e, revisions: revisions.get(e.id) || [] })),
    });
  } catch (err) {
    logger.error('[Requirements] 导出失败:', getErrorMessage(err));
    return res.status(500).json({ error: '导出失败' });
  }
});

export default router;
