/**
 * P1-1 语义指标层管理路由。
 * 读取对所有登录用户开放。
 * P1-8 指标层治理：分析师可提议（PENDING）；创建直接生效 / 审批 / 驳回 / 编辑 / 删除 / 版本回溯仅 ADMIN。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import {
  listMetrics,
  createMetric,
  updateMetric,
  deleteMetric,
  sanitizeMetricInput,
  approveMetric,
  rejectMetric,
  reproposeMetric,
  listMetricVersions,
  restoreMetricVersion,
  findMetricById,
  buildMetricQuerySql,
} from '../metrics';
import { checkDataSourceAccess } from '../accessControl';
import { checkUserQueryLimit } from '../userQueryLimit';
import { loadSchemaContext } from '../schemaContext';
import { executeSafeSql } from '../sqlExecutor';
import { maskRows } from '../dlp';
import { writeAudit } from '../auditLog';
import { AMOUNT_UNIT_OPTIONS, normalizeAmountUnit } from '../liveQuery';

const router = Router();
router.use(authMiddleware);

// GET /api/metrics?dataSourceId=xxx —— 列出某数据源的全部指标定义
router.get('/', async (req, res) => {
  const dataSourceId = String(req.query.dataSourceId || '');
  if (!dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  try {
    res.json({ metrics: await listMetrics(dataSourceId) });
  } catch (err: any) {
    res.status(500).json({ error: `查询指标失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/metrics —— 新建指标。ADMIN 直接生效（ACTIVE）；分析师提交为提议（PENDING）待审批
router.post('/', async (req, res) => {
  const cleaned = sanitizeMetricInput(req.body);
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  const user = (req as any).user || {};
  const username = String(user.username || 'unknown');
  const isAdmin = user.role === 'ADMIN';
  try {
    const r = await createMetric(cleaned.metric, username, { autoApprove: isAdmin });
    if (r.ok !== true) return res.status(409).json({ error: r.error });
    res.json({ ok: true, id: r.id, status: isAdmin ? 'ACTIVE' : 'PENDING' });
  } catch (err: any) {
    res.status(500).json({ error: `创建失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/metrics/query —— P2-14 统一指标查询（语义层查询接口，报表/看板/问数三端共享）：
// 按指标登记的可切分维度白名单生成 GROUP BY 查询，复用 SELECT-only 安全执行层执行，结果按角色 DLP 脱敏
router.post('/query', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const startedAt = Date.now();
  const user = (req as any).user || {};
  const metricId = Number(req.body?.metricId);
  const dimensions = Array.isArray(req.body?.dimensions)
    ? req.body.dimensions.filter((d: any) => typeof d === 'string').map((d: string) => d.trim()).filter(Boolean)
    : [];
  const limit = typeof req.body?.limit === 'number' ? req.body.limit : undefined;
  // v0.9.21 金额单位：看板直查跟随全局/模块单位选择传入；白名单归一，非法值按不传处理（原值口径）
  const unitKey = normalizeAmountUnit(req.body?.amountUnit);
  const amountUnit = unitKey ? { label: unitKey, divisor: AMOUNT_UNIT_OPTIONS[unitKey].divisor } : undefined;
  const auditBase = {
    userId: Number(user.id || 0),
    username: String(user.username || 'unknown'),
    endpoint: 'query' as const,
  };
  if (!Number.isInteger(metricId) || metricId <= 0) return res.status(400).json({ error: '非法指标 ID' });

  try {
    const metric = await findMetricById(metricId);
    if (!metric) return res.status(404).json({ error: '指标不存在' });

    // P2-11 数据源访问控制：无授权用户不可经语义层绕过 ACL 取数
    if (!(await checkDataSourceAccess(user, metric.dataSourceId))) {
      writeAudit({ ...auditBase, dataSourceId: metric.dataSourceId, question: `metric:${metric.name}`, status: 'DENIED_AUTH', detail: '无数据源访问权限（ACL）', durationMs: Date.now() - startedAt });
      return res.status(403).json({ error: '没有该数据源的访问权限，可向管理员申请开通' });
    }

    const built = buildMetricQuerySql(metric, dimensions, limit, amountUnit);
    if (built.ok !== true) return res.status(400).json({ error: built.error });

    const qLimit = await checkUserQueryLimit(user.id);
    if (!qLimit.ok) {
      writeAudit({ ...auditBase, dataSourceId: metric.dataSourceId, question: `metric:${metric.name}`, status: 'DENIED_RATE', detail: qLimit.reason, durationMs: Date.now() - startedAt });
      return res.status(429).json({ error: qLimit.reason });
    }

    const ctx = await loadSchemaContext(metric.dataSourceId, undefined);
    if (ctx.status === 'disconnected') {
      return res.status(403).json({ error: '该数据源已被管理员停用' });
    }

    // 复用 SELECT-only 安全执行层：表白名单 / 敏感列剔除 / 部门行级过滤全部生效
    const outcome = await executeSafeSql(metric.dataSourceId, built.sql, ctx.schema, ctx.sensitiveRemoved, undefined, ctx.rowFilters);
    if (outcome.ok !== true) {
      return res.status(outcome.reason === 'UNSUPPORTED_DS_TYPE' ? 400 : 422).json({ error: outcome.reason === 'UNSUPPORTED_DS_TYPE' ? '仅 MySQL / PostgreSQL / Greenplum 数据源支持指标查询' : outcome.reason });
    }

    // P2-12 DLP：维度切分值可能含敏感数据，按角色脱敏（ADMIN 豁免）
    const dlpOut = maskRows(outcome.result.rows, user);
    writeAudit({ ...auditBase, dataSourceId: metric.dataSourceId, question: `metric:${metric.name}`, status: 'SUCCESS', executedSql: outcome.result.finalSql, rowCount: outcome.result.rowCount, durationMs: Date.now() - startedAt });
    res.json({
      ok: true,
      metric: { id: metric.id, name: metric.name, expr: metric.expr, tableName: metric.tableName, dimensions: metric.dimensions },
      groupBy: dimensions,
      sql: outcome.result.finalSql,
      rows: dlpOut.rows,
      rowCount: outcome.result.rowCount,
      truncated: outcome.result.truncated,
      // v0.9.21：单位标注——applied=true 表示 SQL 已按该单位换算（前端据此标注口径）；false=原值口径（非金额类/「元」/未传单位）
      amountUnit: amountUnit ? { label: amountUnit.label, applied: built.unitApplied } : { label: '元', applied: false },
      executionTimeMs: Date.now() - startedAt,
      ...(dlpOut.maskedColumns.length > 0 ? { dlp: { maskedColumns: dlpOut.maskedColumns, maskedLabels: dlpOut.maskedLabels } } : {}),
    });
  } catch (err: any) {
    res.status(500).json({ error: `指标查询失败：${err?.message || '未知错误'}` });
  }
});

// PUT /api/metrics/:id（ADMIN）—— 更新指标（数据源归属不可变）
router.put('/:id', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  const cleaned = sanitizeMetricInput({ ...(req.body || {}), dataSourceId: 'placeholder' });
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const { dataSourceId: _ignored, ...rest } = cleaned.metric;
    const r = await updateMetric(id, rest, String((req as any).user?.username || ''));
    if (r.ok !== true) return res.status(r.notFound ? 404 : 409).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `更新失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/metrics/:id/approve（ADMIN）—— 审批通过：PENDING → ACTIVE
router.post('/:id/approve', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  try {
    const r = await approveMetric(id, String((req as any).user?.username || ''));
    if (r.ok !== true) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `审批失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/metrics/:id/reject（ADMIN）—— 驳回：PENDING → REJECTED
router.post('/:id/reject', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  try {
    const r = await rejectMetric(id, String((req as any).user?.username || ''));
    if (r.ok !== true) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `驳回失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/metrics/:id/repropose —— 被驳回指标重新提议：REJECTED → PENDING（提议人本人或 ADMIN）
router.post('/:id/repropose', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  try {
    const r = await reproposeMetric(id, String((req as any).user?.username || ''));
    if (r.ok !== true) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `重新提议失败：${err?.message || '未知错误'}` });
  }
});

// GET /api/metrics/:id/versions —— 版本历史（新→旧）
router.get('/:id/versions', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  try {
    res.json({ versions: await listMetricVersions(id) });
  } catch (err: any) {
    res.status(500).json({ error: `查询版本历史失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/metrics/:id/restore（ADMIN）—— 回溯到指定版本 {version}
router.post('/:id/restore', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  const version = Number(req.body?.version);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  if (!Number.isInteger(version) || version <= 0) return res.status(400).json({ error: '非法版本号' });
  try {
    const r = await restoreMetricVersion(id, version, String((req as any).user?.username || ''));
    if (r.ok !== true) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `回溯失败：${err?.message || '未知错误'}` });
  }
});

// DELETE /api/metrics/:id（ADMIN）
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法指标 ID' });
  try {
    if (!(await deleteMetric(id))) return res.status(404).json({ error: '指标不存在' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `删除失败：${err?.message || '未知错误'}` });
  }
});

export default router;
