/**
 * v0.9.93 自动运维 API（P1-7）：事件流查询/确认/关闭 + 服务日志尾读，面向自动运维智能体。
 *
 * - GET  /api/ops/events              事件列表（status/severity/category/source/since/until/cursor/limit）
 * - GET  /api/ops/events/summary      态势摘要（状态计数 + 近 24h 分类分布）
 * - POST /api/ops/events/:id/ack      确认受理（NEW → ACK；幂等）
 * - POST /api/ops/events/:id/resolve  处置关闭（→ RESOLVED；幂等；动作留痕进审计）
 * - GET  /api/ops/logs                JSONL 日志尾读（文件取 LOG_FILE 环境变量，按 level/时间/关键字/链路过滤）
 *
 * 权限：requireOpsAccess 双通道——OPS_API_TOKEN Bearer（智能体）或 ADMIN JWT（管理面板复用）。
 * 智能体闭环约定：拉取 NEW → ack（受理）→ 执行动作 → resolve（body.note 记录处置摘要）。
 */
import { Router } from 'express';
import fs from 'node:fs';
import type mysql from 'mysql2/promise';
import { requireOpsAccess } from '../auth/auth';
import { getPool } from '../infra/db';
import { writeAudit } from '../infra/auditLog';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';

const router = Router();
router.use(requireOpsAccess);

const VALID_STATUS = new Set(['NEW', 'ACK', 'RESOLVED']);
const VALID_SEVERITY = new Set(['CRITICAL', 'ERROR', 'WARN', 'INFO']);
const VALID_SOURCE = new Set(['audit', 'task', 'patrol', 'drift', 'fatal', 'client']);
/** 时间过滤白名单格式（原样传 DB，避免非法输入） */
const TIME_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;

interface OpsEventListRow extends mysql.RowDataPacket {
  id: number;
  severity: string;
  source: string;
  category: string;
  entity_type: string;
  entity_id: string;
  message: string;
  detail: unknown;
  trace_id: string;
  status: string;
  dedup_count: number;
  handled_by: string;
  handled_at: Date | null;
  created_at: Date;
  last_seen_at: Date;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// ---------- 事件列表（游标分页，倒序） ----------

router.get('/events', async (req, res) => {
  const status = String(req.query.status || '').trim().toUpperCase();
  const severity = String(req.query.severity || '').trim().toUpperCase();
  const category = String(req.query.category || '').trim();
  const source = String(req.query.source || '').trim().toLowerCase();
  const since = String(req.query.since || '').trim();
  const until = String(req.query.until || '').trim();
  const cursor = Number(req.query.cursor);
  const limit = clampInt(req.query.limit, 1, 200, 50);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status && VALID_STATUS.has(status)) { clauses.push('status = ?'); params.push(status); }
  if (severity && VALID_SEVERITY.has(severity)) { clauses.push('severity = ?'); params.push(severity); }
  if (category) { clauses.push('category = ?'); params.push(category.slice(0, 24)); }
  if (source && VALID_SOURCE.has(source)) { clauses.push('source = ?'); params.push(source); }
  if (since && TIME_RE.test(since)) { clauses.push('created_at >= ?'); params.push(since); }
  if (until && TIME_RE.test(until)) { clauses.push('created_at <= ?'); params.push(until); }
  if (Number.isInteger(cursor) && cursor > 0) { clauses.push('id < ?'); params.push(cursor); }

  try {
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await getPool().query<OpsEventListRow[]>(
      `SELECT id, severity, source, category, entity_type, entity_id, message, detail, trace_id,
              status, dedup_count, handled_by, handled_at, created_at, last_seen_at
       FROM ops_events ${where} ORDER BY id DESC LIMIT ?`,
      [...params, limit]
    );
    const last = rows[rows.length - 1];
    return res.json({
      success: true,
      events: rows,
      nextCursor: rows.length === limit && last ? last.id : null,
    });
  } catch (err) {
    logger.error('[OpsEvents] 列表失败:', getErrorMessage(err));
    return res.status(500).json({ error: '运维事件获取失败' });
  }
});

// ---------- 态势摘要（智能体快速感知） ----------

router.get('/events/summary', async (_req, res) => {
  try {
    const pool = getPool();
    const [[statusRows], [recentRows]] = await Promise.all([
      pool.query<mysql.RowDataPacket[]>(
        'SELECT status, COUNT(*) AS cnt FROM ops_events GROUP BY status'
      ),
      pool.query<mysql.RowDataPacket[]>(
        `SELECT category, severity, COUNT(*) AS cnt FROM ops_events
         WHERE created_at >= NOW() - INTERVAL 24 HOUR
         GROUP BY category, severity ORDER BY cnt DESC LIMIT 50`
      ),
    ]);
    return res.json({ success: true, byStatus: statusRows, last24h: recentRows });
  } catch (err) {
    logger.error('[OpsEvents] 摘要失败:', getErrorMessage(err));
    return res.status(500).json({ error: '运维事件摘要获取失败' });
  }
});

// ---------- 受理 / 关闭（幂等；动作留痕审计） ----------

async function transitionEvent(
  id: number,
  fromStatuses: string[],
  toStatus: string,
  who: string
): Promise<{ ok: true; status: string; already?: boolean } | { ok: false; notFound: boolean }> {
  const pool = getPool();
  const placeholders = fromStatuses.map(() => '?').join(', ');
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `UPDATE ops_events SET status = ?, handled_by = ?, handled_at = NOW()
     WHERE id = ? AND status IN (${placeholders})`,
    [toStatus, who, id, ...fromStatuses]
  );
  if (result.affectedRows === 0) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT status FROM ops_events WHERE id = ? LIMIT 1', [id]);
    const row = rows[0];
    if (!row) return { ok: false, notFound: true };
    // 幂等语义：已处于目标态或更后态时不重复变更，回当前态
    return { ok: true, status: String(row.status), already: true };
  }
  return { ok: true, status: toStatus };
}

/**
 * 动作留痕：v0.9.94 起按操作通道归属审计域——智能体（OPS_API_TOKEN，requireOpsAccess
 * 注入 id=0）的 ack/resolve 记 endpoint=ops_agent，与人工管理面板操作（endpoint=admin）
 * 可区分检索；这是「发现→决策→执行→验证」证据链中执行环节的落账点。
 */
function auditTransition(action: string, id: number, who: string, note: string, userId: number): void {
  writeAudit({
    userId,
    username: who,
    endpoint: userId === 0 ? 'ops_agent' : 'admin',
    status: 'SUCCESS',
    detail: `运维事件 #${id} ${action}${note ? `：${note}` : ''}`,
  });
}

router.post('/events/:id/ack', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的事件 id' });
  const who = req.user?.username || 'ops-agent';
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : '';
  try {
    const out = await transitionEvent(id, ['NEW'], 'ACK', who);
    if (!out.ok) return res.status(404).json({ error: 'event not found' });
    if (!out.already) auditTransition('已受理', id, who, note, req.user?.id ?? 0);
    return res.json({ success: true, id, status: out.status, ...(out.already ? { already: true } : {}) });
  } catch (err) {
    logger.error('[OpsEvents] ack 失败:', getErrorMessage(err));
    return res.status(500).json({ error: '事件确认失败' });
  }
});

router.post('/events/:id/resolve', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的事件 id' });
  const who = req.user?.username || 'ops-agent';
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : '';
  try {
    const out = await transitionEvent(id, ['NEW', 'ACK'], 'RESOLVED', who);
    if (!out.ok) return res.status(404).json({ error: 'event not found' });
    if (!out.already) auditTransition('已处置关闭', id, who, note, req.user?.id ?? 0);
    return res.json({ success: true, id, status: out.status, ...(out.already ? { already: true } : {}) });
  } catch (err) {
    logger.error('[OpsEvents] resolve 失败:', getErrorMessage(err));
    return res.status(500).json({ error: '事件关闭失败' });
  }
});

// ---------- 日志尾读（JSONL） ----------

/**
 * 从文件尾读取至多 maxBytes 的文本。start>0（截断）时丢弃首个不完整行，
 * 避免把截断处破损的多字节字符/半行返回给消费方。
 */
function readTailText(filePath: string, maxBytes: number): { text: string; truncated: boolean } {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return { text: '', truncated: false };
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { text, truncated: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 日志查询：文件路径仅取 LOG_FILE 环境变量（启动脚本注入），不接受请求参数——
 * 从机制上杜绝任意文件读取。返回窗口内尾部 N 行，按时间正序（tail 语义：最新在底部）；
 * 非 JSON 行（旧格式/第三方输出）以 { raw } 原样返回（仍参与关键字过滤）。
 */
router.get('/logs', async (req, res) => {
  const filePath = (process.env.LOG_FILE || '').trim();
  if (!filePath) {
    return res.status(501).json({
      error: '服务未配置 LOG_FILE（日志文件路径），无法提供日志查询；请由启动脚本注入该环境变量后重启',
    });
  }
  const level = String(req.query.level || '').trim().toLowerCase();
  const q = String(req.query.q || '').trim();
  const requestId = String(req.query.requestId || '').trim();
  const taskId = String(req.query.taskId || '').trim();
  const limit = clampInt(req.query.limit, 1, 1000, 200);
  const maxBytes = clampInt(req.query.maxBytes, 64 * 1024, 16 * 1024 * 1024, 2 * 1024 * 1024);

  let text: string;
  let truncated: boolean;
  try {
    ({ text, truncated } = readTailText(filePath, maxBytes));
  } catch (err) {
    logger.warn('[OpsEvents] 日志文件读取失败:', getErrorMessage(err));
    return res.status(404).json({ error: '日志文件不存在或不可读' });
  }

  const lines = text.split('\n');
  const out: unknown[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const raw = lines[i];
    if (!raw || raw.trim() === '') continue;
    let record: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') record = parsed as Record<string, unknown>;
    } catch {
      /* 非 JSON 行：按纯文本参与过滤 */
    }
    if (level && String(record?.level || '').toLowerCase() !== level) continue;
    if (q && !raw.includes(q)) continue;
    if (requestId && record?.requestId !== requestId) continue;
    if (taskId && record?.taskId !== taskId) continue;
    out.push(record ?? { raw });
  }
  out.reverse();
  return res.json({
    success: true,
    file: filePath,
    windowTruncated: truncated,
    returned: out.length,
    lines: out,
  });
});

export default router;
