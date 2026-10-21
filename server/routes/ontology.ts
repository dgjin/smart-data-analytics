/**
 * v0.9.110 业务本体治理路由（M1 实体/绑定/值域 + M2 关系/层级/路径）。
 *
 * 权限：读接口登录可读（管理面板展示与调试）；写接口一律 requireRole('ADMIN')。
 * 治理语义对齐 iron_rules/metrics：创建即 ACTIVE、写入 version+1 并留快照、支持版本回滚。
 * 本体仅作问数软注入上下文，不涉及权限放开——执行层 Schema 白名单不因本体变化。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { authMiddleware, requireRole } from '../auth/auth';
import {
  listEntities,
  createEntity,
  updateEntity,
  deleteEntity,
  replaceBindings,
  listValueNotes,
  upsertValueNote,
  updateValueNote,
  deleteValueNote,
  listRelations,
  createRelation,
  updateRelation,
  deleteRelation,
  listHierarchies,
  createHierarchy,
  updateHierarchy,
  deleteHierarchy,
  listOntologyVersions,
  restoreEntityVersion,
  restoreRelationVersion,
  restoreHierarchyVersion,
  loadActiveOntology,
  findRelationPaths,
  ontologySummary,
  sanitizeEntityInput,
  sanitizeBindingsInput,
  sanitizeValueNoteInput,
  sanitizeRelationInput,
  sanitizeHierarchyInput,
} from '../query/ontology';
import { getErrorMessage } from '../infra/errorUtils';
import { logger } from '../infra/logger';

const router = Router();

/** 写接口统一 ADMIN（读接口只挂 authMiddleware，见各端点声明） */
const adminOnly = [authMiddleware, requireRole('ADMIN')] as const;

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function requireDataSourceId(req: Request, res: Response): string | null {
  const ds = String(req.query.dataSourceId || (req.body && req.body.dataSourceId) || '');
  if (!ds) {
    res.status(400).json({ error: '缺少 dataSourceId' });
    return null;
  }
  return ds;
}

// ---------- 概览 ----------

// GET /api/ontology/summary?dataSourceId=xxx —— 各资产 ACTIVE 计数（面板概览）
router.get('/summary', authMiddleware, async (req, res) => {
  const ds = requireDataSourceId(req, res);
  if (!ds) return;
  try {
    res.json({ summary: await ontologySummary(ds) });
  } catch (err) {
    res.status(500).json({ error: `本体概览查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// ---------- 实体与绑定（M1） ----------

// GET /api/ontology/entities?dataSourceId=xxx —— 实体列表（含绑定，登录可读）
router.get('/entities', authMiddleware, async (req, res) => {
  const ds = requireDataSourceId(req, res);
  if (!ds) return;
  try {
    res.json({ entities: await listEntities(ds) });
  } catch (err) {
    res.status(500).json({ error: `实体查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// POST /api/ontology/entities —— 新建业务实体（ADMIN，创建即 ACTIVE）
router.post('/entities', ...adminOnly, async (req, res) => {
  const cleaned = sanitizeEntityInput(req.body);
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const r = await createEntity(cleaned.entity, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(409).json({ error: r.error });
    res.json({ ok: true, id: r.id });
  } catch (err) {
    res.status(500).json({ error: `创建失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// PUT /api/ontology/entities/:id —— 更新实体（数据源归属不可变，version+1 留快照）
router.put('/entities/:id', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法实体 ID' });
  const cleaned = sanitizeEntityInput({ ...(req.body || {}), dataSourceId: 'placeholder' });
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const { dataSourceId: _ignored, ...rest } = cleaned.entity;
    const r = await updateEntity(id, rest, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(r.notFound ? 404 : 409).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `更新失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// DELETE /api/ontology/entities/:id —— 删除实体（连带绑定，留 DELETE 快照）
router.delete('/entities/:id', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法实体 ID' });
  try {
    if (!(await deleteEntity(id, String(req.user?.username || 'unknown')))) {
      return res.status(404).json({ error: '业务实体不存在' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `删除失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// PUT /api/ontology/entities/:id/bindings —— 绑定整组替换（ADMIN）
router.put('/entities/:id/bindings', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法实体 ID' });
  const dataSourceId = requireDataSourceId(req, res);
  if (!dataSourceId) return;
  const cleaned = sanitizeBindingsInput(id, dataSourceId, req.body?.bindings);
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const r = await replaceBindings(id, cleaned.bindings);
    if (r.ok !== true) return res.status(404).json({ error: r.error });
    res.json({ ok: true, count: cleaned.bindings.length });
  } catch (err) {
    res.status(500).json({ error: `绑定保存失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// GET /api/ontology/entities/:id/versions —— 实体版本历史（ADMIN）
router.get('/entities/:id/versions', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法实体 ID' });
  try {
    res.json({ versions: await listOntologyVersions('entity', id) });
  } catch (err) {
    res.status(500).json({ error: `版本查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// POST /api/ontology/entities/:id/restore —— 回滚到指定版本（ADMIN）
router.post('/entities/:id/restore', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法实体 ID' });
  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version <= 0) return res.status(400).json({ error: '缺少合法版本号 version' });
  try {
    const r = await restoreEntityVersion(id, version, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `回滚失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// ---------- 值域释义（M1） ----------

// GET /api/ontology/value-notes?dataSourceId=&tableName= —— 值域释义列表（登录可读）
router.get('/value-notes', authMiddleware, async (req, res) => {
  const ds = requireDataSourceId(req, res);
  if (!ds) return;
  const tableName = req.query.tableName ? String(req.query.tableName) : undefined;
  try {
    res.json({ valueNotes: await listValueNotes(ds, tableName) });
  } catch (err) {
    res.status(500).json({ error: `值域释义查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// POST /api/ontology/value-notes —— 新增或按唯一键更新（ADMIN）
router.post('/value-notes', ...adminOnly, async (req, res) => {
  const cleaned = sanitizeValueNoteInput(req.body);
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const r = await upsertValueNote(cleaned.note, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(409).json({ error: r.error });
    res.json({ ok: true, id: r.id });
  } catch (err) {
    res.status(500).json({ error: `值域释义保存失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// PUT /api/ontology/value-notes/:id —— 行内编辑含义/状态（ADMIN）
router.put('/value-notes/:id', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法值域释义 ID' });
  try {
    const r = await updateValueNote(id, req.body);
    if (r.ok !== true) return res.status(r.notFound ? 404 : 400).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `更新失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// DELETE /api/ontology/value-notes/:id
router.delete('/value-notes/:id', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法值域释义 ID' });
  try {
    if (!(await deleteValueNote(id))) return res.status(404).json({ error: '值域释义不存在' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `删除失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// ---------- 关联路径（M2） ----------

// GET /api/ontology/relations?dataSourceId= —— 已登记 JOIN 路径（登录可读）
router.get('/relations', authMiddleware, async (req, res) => {
  const ds = requireDataSourceId(req, res);
  if (!ds) return;
  try {
    res.json({ relations: await listRelations(ds) });
  } catch (err) {
    res.status(500).json({ error: `关联路径查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// POST /api/ontology/relations
router.post('/relations', ...adminOnly, async (req, res) => {
  const cleaned = sanitizeRelationInput(req.body);
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const r = await createRelation(cleaned.relation, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(409).json({ error: r.error });
    res.json({ ok: true, id: r.id });
  } catch (err) {
    res.status(500).json({ error: `创建失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// PUT /api/ontology/relations/:id
router.put('/relations/:id', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法关联路径 ID' });
  const cleaned = sanitizeRelationInput({ ...(req.body || {}), dataSourceId: 'placeholder' });
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const { dataSourceId: _ignored, ...rest } = cleaned.relation;
    const r = await updateRelation(id, rest, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(r.notFound ? 404 : 409).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `更新失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// DELETE /api/ontology/relations/:id
router.delete('/relations/:id', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法关联路径 ID' });
  try {
    if (!(await deleteRelation(id, String(req.user?.username || 'unknown')))) {
      return res.status(404).json({ error: '关联路径不存在' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `删除失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// GET /api/ontology/relations/:id/versions（ADMIN）
router.get('/relations/:id/versions', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法关联路径 ID' });
  try {
    res.json({ versions: await listOntologyVersions('relation', id) });
  } catch (err) {
    res.status(500).json({ error: `版本查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// POST /api/ontology/relations/:id/restore（ADMIN）
router.post('/relations/:id/restore', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法关联路径 ID' });
  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version <= 0) return res.status(400).json({ error: '缺少合法版本号 version' });
  try {
    const r = await restoreRelationVersion(id, version, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `回滚失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// ---------- 业务层级（M2） ----------

// GET /api/ontology/hierarchies?dataSourceId= —— 层级列表（登录可读）
router.get('/hierarchies', authMiddleware, async (req, res) => {
  const ds = requireDataSourceId(req, res);
  if (!ds) return;
  try {
    res.json({ hierarchies: await listHierarchies(ds) });
  } catch (err) {
    res.status(500).json({ error: `业务层级查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// POST /api/ontology/hierarchies
router.post('/hierarchies', ...adminOnly, async (req, res) => {
  const cleaned = sanitizeHierarchyInput(req.body);
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const r = await createHierarchy(cleaned.hierarchy, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(409).json({ error: r.error });
    res.json({ ok: true, id: r.id });
  } catch (err) {
    res.status(500).json({ error: `创建失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// PUT /api/ontology/hierarchies/:id
router.put('/hierarchies/:id', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法业务层级 ID' });
  const cleaned = sanitizeHierarchyInput({ ...(req.body || {}), dataSourceId: 'placeholder' });
  if (cleaned.ok !== true) return res.status(400).json({ error: cleaned.error });
  try {
    const { dataSourceId: _ignored, ...rest } = cleaned.hierarchy;
    const r = await updateHierarchy(id, rest, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(r.notFound ? 404 : 409).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `更新失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// DELETE /api/ontology/hierarchies/:id
router.delete('/hierarchies/:id', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法业务层级 ID' });
  try {
    if (!(await deleteHierarchy(id, String(req.user?.username || 'unknown')))) {
      return res.status(404).json({ error: '业务层级不存在' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `删除失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// GET /api/ontology/hierarchies/:id/versions（ADMIN）
router.get('/hierarchies/:id/versions', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法业务层级 ID' });
  try {
    res.json({ versions: await listOntologyVersions('hierarchy', id) });
  } catch (err) {
    res.status(500).json({ error: `版本查询失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// POST /api/ontology/hierarchies/:id/restore（ADMIN）
router.post('/hierarchies/:id/restore', ...adminOnly, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: '非法业务层级 ID' });
  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version <= 0) return res.status(400).json({ error: '缺少合法版本号 version' });
  try {
    const r = await restoreHierarchyVersion(id, version, String(req.user?.username || 'unknown'));
    if (r.ok !== true) return res.status(r.status).json({ error: r.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `回滚失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

// ---------- 路径调试（M2） ----------

// GET /api/ontology/path?dataSourceId=&from=&to= —— 已登记 JOIN 最短路（登录可读，供面板预览）
router.get('/path', authMiddleware, async (req, res) => {
  const ds = requireDataSourceId(req, res);
  if (!ds) return;
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!from || !to) return res.status(400).json({ error: '缺少 from/to 表名' });
  try {
    const snap = await loadActiveOntology(ds);
    const paths = findRelationPaths(from, to, snap.relations);
    res.json({ from, to, paths });
  } catch (err) {
    logger.error('[Ontology Path Error]', err);
    res.status(500).json({ error: `路径检索失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

export default router;
