/**
 * 铁律规则库管理路由（v0.9.35）。
 * 全部端点仅 ADMIN：铁律是数据源级强制规则资产，创建即生效、无治理审批流，
 * 全部 ACTIVE 规则恒注入问数/报表阶段一 prompt，生成 SQL 必须逐条遵守。
 */
import { Router } from 'express';
import type { RowDataPacket } from 'mysql2';
import { authMiddleware, requireRole } from '../auth/auth';
import {
  listIronRules,
  createIronRule,
  updateIronRule,
  deleteIronRule,
  sanitizeIronRuleInput,
  buildIronRulesExport,
  importIronRules,
} from '../query/ironRules';
import { getPool } from '../infra/db';
import { logger } from '../infra/logger';

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

// GET /api/iron-rules?dataSourceId=xxx —— 列出某数据源的全部铁律（按创建顺序，与注入顺序一致）
router.get('/', async (req, res) => {
  const dataSourceId = String(req.query.dataSourceId || '');
  if (!dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  try {
    res.json({ rules: await listIronRules(dataSourceId) });
  } catch (err: any) {
    res.status(500).json({ error: `查询铁律失败：${err?.message || '未知错误'}` });
  }
});

// POST /api/iron-rules —— 新建铁律（直接生效）
router.post('/', async (req, res) => {
  const cleaned = sanitizeIronRuleInput(req.body);
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const r = await createIronRule(cleaned.rule, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(409).json({ error: r.error });
    res.json({ ok: true, id: r.id });
  } catch (err: any) {
    res.status(500).json({ error: `创建失败：${err?.message || '未知错误'}` });
  }
});

// GET /api/iron-rules/export?dataSourceId=xxx —— 导出指定数据源的全部铁律为 JSON 备份文件
router.get('/export', async (req, res) => {
  const dataSourceId = String(req.query.dataSourceId || '');
  if (!dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  try {
    const [dsRows] = await getPool().query<RowDataPacket[]>('SELECT name FROM data_sources WHERE id = ?', [dataSourceId]);
    if (dsRows.length === 0) return res.status(404).json({ error: `数据源不存在：${dataSourceId}` });
    const dsName = String(dsRows[0].name || dataSourceId);
    const rules = await listIronRules(dataSourceId);
    const exportData = buildIronRulesExport(dataSourceId, dsName, rules, String(req.user?.username || 'unknown'));
    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = `铁律规则库-${dsName}-${dateStr}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="iron-rules-${dataSourceId}-${dateStr}.json"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    res.send(JSON.stringify(exportData, null, 2));
  } catch (err: any) {
    logger.error('[IronRules Export Error]', err);
    res.status(500).json({ error: `导出失败：${err?.message || '未知错误'}` });
  }
});

/**
 * POST /api/iron-rules/import —— 从 JSON 备份文件恢复铁律到指定数据源。
 * body: {
 *   fileData: object,                             // 导出文件的完整 JSON 内容（必填，type='iron-rules'）
 *   dataSourceId?: string,                        // 目标数据源（缺省用文件中的来源数据源）
 *   mergeStrategy?: 'skip' | 'overwrite',         // 同标题冲突处理（默认 skip）
 *   dryRun?: boolean                              // 仅预检不写库（默认 false）
 * }
 */
router.post('/import', async (req, res) => {
  try {
    const { fileData, mergeStrategy = 'skip', dryRun = false } = req.body || {};
    if (!fileData || typeof fileData !== 'object') {
      return res.status(400).json({ error: '缺少 fileData（备份文件的 JSON 内容）' });
    }
    if (mergeStrategy !== 'skip' && mergeStrategy !== 'overwrite') {
      return res.status(400).json({ error: 'mergeStrategy 必须是 skip / overwrite' });
    }
    if (fileData.type !== 'iron-rules' || !Array.isArray(fileData.rules)) {
      return res.status(400).json({ error: '无法识别的文件格式：应为铁律规则库导出文件（type=iron-rules）' });
    }
    if (fileData.rules.length === 0) {
      return res.status(400).json({ error: '文件中没有可导入的铁律' });
    }
    const dataSourceId = String(req.body.dataSourceId || fileData.dataSourceId || '');
    if (!dataSourceId) return res.status(400).json({ error: '缺少目标数据源 dataSourceId（文件中也没有来源信息）' });

    const [dsRows] = await getPool().query<RowDataPacket[]>('SELECT id, name FROM data_sources WHERE id = ?', [dataSourceId]);
    if (dsRows.length === 0) return res.status(404).json({ error: `目标数据源不存在：${dataSourceId}` });

    const username = String(req.user?.username || 'admin');
    const result = await importIronRules(dataSourceId, fileData.rules, mergeStrategy, !!dryRun, username);
    logger.info('[IronRules Import]', {
      dryRun: result.dryRun,
      strategy: mergeStrategy,
      dataSourceId,
      imported: result.importedCount,
      updated: result.updatedCount,
      skipped: result.skippedCount,
      errors: result.errorCount,
    });
    res.json({ ...result, dataSourceId, dataSourceName: String(dsRows[0].name || dataSourceId) });
  } catch (err: any) {
    logger.error('[IronRules Import Error]', err);
    res.status(500).json({ error: `导入失败：${err?.message || '未知错误'}` });
  }
});

// PUT /api/iron-rules/:id —— 更新铁律（数据源归属不可变）
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法铁律 ID' });
  const cleaned = sanitizeIronRuleInput({ ...(req.body || {}), dataSourceId: 'placeholder' });
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const { dataSourceId: _ignored, ...rest } = cleaned.rule;
    const r = await updateIronRule(id, rest);
    if (r.ok !== true) return res.status(r.notFound ? 404 : 409).json({ error: r.error });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `更新失败：${err?.message || '未知错误'}` });
  }
});

// DELETE /api/iron-rules/:id
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '非法铁律 ID' });
  try {
    if (!(await deleteIronRule(id))) return res.status(404).json({ error: '铁律不存在' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: `删除失败：${err?.message || '未知错误'}` });
  }
});

export default router;
