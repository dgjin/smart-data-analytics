/**
 * v0.9.110 业务本体治理路由（M1 实体/绑定/值域 + M2 关系/层级/路径）。
 *
 * 权限：读接口登录可读（管理面板展示与调试）；写接口一律 requireRole('ADMIN')。
 * 治理语义对齐 iron_rules/metrics：创建即 ACTIVE、写入 version+1 并留快照、支持版本回滚。
 * 本体仅作问数软注入上下文，不涉及权限放开——执行层 Schema 白名单不因本体变化。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { RowDataPacket } from 'mysql2';
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
import { getPool } from '../infra/db';
import { buildOntologyDraft, type AutoBuildTable } from '../query/ontologyAutoBuild';

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

// POST /api/ontology/value-notes/bulk —— 批量 upsert（ADMIN，单次 ≤200 条；逐条校验并返回失败明细）
router.post('/value-notes/bulk', ...adminOnly, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const dataSourceId = String(body.dataSourceId || '');
  if (!dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return res.status(400).json({ error: 'items 不能为空' });
  if (items.length > 200) return res.status(400).json({ error: '单次最多批量保存 200 条' });

  const actor = String(req.user?.username || 'unknown');
  const failures: { index: number; valueCode: string; error: string }[] = [];
  let saved = 0;
  for (let i = 0; i < items.length; i += 1) {
    const raw = (items[i] ?? {}) as Record<string, unknown>;
    const cleaned = sanitizeValueNoteInput({
      dataSourceId,
      tableName: body.tableName,
      columnName: body.columnName,
      valueCode: raw.valueCode,
      meaning: raw.meaning,
    });
    if (cleaned.ok !== true) {
      failures.push({ index: i, valueCode: String(raw.valueCode ?? ''), error: cleaned.error });
      continue;
    }
    try {
      const r = await upsertValueNote(cleaned.note, actor);
      if (r.ok === true) saved += 1;
      else failures.push({ index: i, valueCode: cleaned.note.valueCode, error: r.error });
    } catch (err) {
      failures.push({ index: i, valueCode: cleaned.note.valueCode, error: getErrorMessage(err) || '写入失败' });
    }
  }
  // 部分失败仍返回 200：由前端汇总展示成功/失败条数与首条原因
  res.json({ ok: failures.length === 0, saved, failed: failures.length, failures: failures.slice(0, 20) });
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

// ---------- 自动搭建（v0.9.112） ----------

/**
 * POST /api/ontology/auto-build —— 基于数据源 Schema 生成本体草案（ADMIN）。
 * body: { dataSourceId, apply?, overwrite? }
 * - 默认 dryRun，仅返回草案供预览；
 * - apply=true 时落库：实体 / 值域 / 关联 / 层级均按业务键幂等，已存在默认跳过；
 * - overwrite=true 时覆盖同名实体（定义 + 绑定）与同键值域，谨慎使用。
 */
router.post('/auto-build', ...adminOnly, async (req, res) => {
  const dataSourceId = String(req.body?.dataSourceId || '').trim();
  if (!dataSourceId) return res.status(400).json({ error: '缺少 dataSourceId' });
  const apply = req.body?.apply === true;
  const overwrite = req.body?.overwrite === true;
  const actor = String(req.user?.username || 'unknown');

  try {
    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT name, schema_json FROM data_sources WHERE id = ? LIMIT 1',
      [dataSourceId]
    );
    if (rows.length === 0) return res.status(404).json({ error: '数据源不存在' });

    let parsed: unknown;
    try {
      parsed = JSON.parse(String(rows[0].schema_json || '[]'));
    } catch {
      return res.status(400).json({ error: '数据源 Schema 解析失败，请重新提取 Schema 后再试' });
    }
    const rawTables = Array.isArray(parsed)
      ? parsed
      : parsed && Array.isArray((parsed as { tables?: unknown[] }).tables)
        ? (parsed as { tables: unknown[] }).tables
        : [];
    if (rawTables.length === 0) {
      return res.status(400).json({ error: '数据源尚未提取 Schema，无法自动搭建' });
    }

    const draft = buildOntologyDraft(rawTables as AutoBuildTable[]);
    const dataSourceName = String(rows[0].name || '');
    if (!apply) {
      return res.json({ ok: true, mode: 'preview', dataSourceId, dataSourceName, draft });
    }

    const applied = {
      entitiesCreated: 0,
      entitiesUpdated: 0,
      bindingsWritten: 0,
      valueNotesWritten: 0,
      relationsCreated: 0,
      hierarchiesCreated: 0,
      skippedExisting: 0,
      errors: [] as string[],
    };
    const pushError = (text: string) => {
      if (applied.errors.length < 20) applied.errors.push(text);
    };

    // 实体 + 绑定：已存在默认跳过（保护人工维护），overwrite 时更新定义并覆盖绑定
    const existingEntities = await listEntities(dataSourceId);
    const entityByName = new Map(existingEntities.map((e) => [e.name, e]));
    for (const e of draft.entities) {
      const existing = entityByName.get(e.name);
      let entityId: number | null = existing?.id ?? null;
      if (existing) {
        if (!overwrite) {
          applied.skippedExisting += 1;
          continue;
        }
        const r = await updateEntity(
          existing.id as number,
          { name: e.name, entityType: e.entityType, aliases: e.aliases, description: e.description, status: existing.status },
          actor
        );
        if (r.ok !== true) {
          pushError(`实体「${e.name}」更新失败：${r.error}`);
          continue;
        }
        applied.entitiesUpdated += 1;
      } else {
        const r = await createEntity(
          { dataSourceId, name: e.name, entityType: e.entityType, aliases: e.aliases, description: e.description, status: 'ACTIVE' },
          actor
        );
        if (r.ok !== true) {
          pushError(`实体「${e.name}」创建失败：${r.error}`);
          continue;
        }
        entityId = r.id;
        applied.entitiesCreated += 1;
      }
      if (entityId === null) continue;
      if (!existing || overwrite) {
        const rb = await replaceBindings(
          entityId,
          e.bindings.map((b) => ({ entityId: entityId as number, dataSourceId, ...b }))
        );
        if (rb.ok === true) applied.bindingsWritten += e.bindings.length;
        else pushError(`实体「${e.name}」绑定写入失败：${rb.error}`);
      }
    }

    // 值域释义：同 (表, 列, 值) 默认跳过，overwrite 时更新含义
    const noteKey = (t: string, c: string, v: string) => `${t}.${c}.${v}`.toLowerCase();
    const existingNotes = await listValueNotes(dataSourceId);
    const noteSet = new Set(existingNotes.map((n) => noteKey(n.tableName, n.columnName, n.valueCode)));
    for (const n of draft.valueNotes) {
      if (noteSet.has(noteKey(n.tableName, n.columnName, n.valueCode)) && !overwrite) {
        applied.skippedExisting += 1;
        continue;
      }
      const r = await upsertValueNote(
        { dataSourceId, tableName: n.tableName, columnName: n.columnName, valueCode: n.valueCode, meaning: n.meaning, status: 'ACTIVE' },
        actor
      );
      if (r.ok === true) applied.valueNotesWritten += 1;
      else pushError(`值域 ${n.tableName}.${n.columnName}=${n.valueCode} 写入失败：${r.error}`);
    }

    // 关联路径：同方向唯一键默认跳过
    const relKey = (r: { fromTable: string; fromColumns: string[]; toTable: string; toColumns: string[] }) =>
      `${r.fromTable}.${r.fromColumns.join(',')}->${r.toTable}.${r.toColumns.join(',')}`.toLowerCase();
    const existingRelations = await listRelations(dataSourceId);
    const relSet = new Set(existingRelations.map(relKey));
    for (const r of draft.relations) {
      if (relSet.has(relKey(r))) {
        applied.skippedExisting += 1;
        continue;
      }
      const cr = await createRelation(
        {
          dataSourceId,
          fromTable: r.fromTable,
          fromColumns: r.fromColumns,
          toTable: r.toTable,
          toColumns: r.toColumns,
          joinType: r.joinType,
          cardinality: r.cardinality,
          purpose: r.purpose,
          status: 'ACTIVE',
        },
        actor
      );
      if (cr.ok === true) applied.relationsCreated += 1;
      else pushError(`关联路径 ${r.fromTable}→${r.toTable} 写入失败：${cr.error}`);
    }

    // 业务层级：同名默认跳过，overwrite 时更新层级列序
    const existingHierarchies = await listHierarchies(dataSourceId);
    const hierarchyByName = new Map(existingHierarchies.map((h) => [h.name, h]));
    for (const h of draft.hierarchies) {
      const existing = hierarchyByName.get(h.name);
      if (existing) {
        if (!overwrite) {
          applied.skippedExisting += 1;
          continue;
        }
        const r = await updateHierarchy(existing.id as number, { name: h.name, levels: h.levels, status: existing.status }, actor);
        if (r.ok !== true) pushError(`业务层级「${h.name}」更新失败：${r.error}`);
        continue;
      }
      const r = await createHierarchy({ dataSourceId, name: h.name, levels: h.levels, status: 'ACTIVE' }, actor);
      if (r.ok === true) applied.hierarchiesCreated += 1;
      else pushError(`业务层级「${h.name}」创建失败：${r.error}`);
    }

    res.json({ ok: applied.errors.length === 0, mode: 'apply', dataSourceId, dataSourceName, draft, applied });
  } catch (err) {
    logger.error('[Ontology AutoBuild Error]', err);
    res.status(500).json({ error: `自动搭建失败：${getErrorMessage(err) || '未知错误'}` });
  }
});

export default router;
