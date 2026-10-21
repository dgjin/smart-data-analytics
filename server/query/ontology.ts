/**
 * v0.9.110 业务本体 M1+M2：实体/术语/值域 + 关系/层级（MySQL 原生轻量实现，非 OWL/RDF）。
 *
 * 设计原则（对齐 docs/本体模型引入专项评估报告20261013.md §七）：
 * - 「登记 → 命中 → 软注入 prompt」：本体只作为问数阶段一的推荐上下文，不拼 SQL、不拒答；
 * - 执行层表/列白名单仍是最终兜底，未登记路径不会放开权限；
 * - 治理模式对齐 metrics.ts：ADMIN 直建即 ACTIVE，写入 version+1 并写 ontology_versions 快照，可回滚；
 * - 无本体数据时零注入、零行为变化（loadActiveOntology 失败降级空快照，不阻断问数）。
 *
 * 关系 BFS 在内存完成（关系量级「数十条」），避免递归 CTE 的事务开销。
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { getPool } from '../infra/db';
import { logger } from '../infra/logger';
import { approxTokens } from '../llm/promptBudget';
import { callEmbedding, callEmbeddingBatch } from '../llm/llmClient';
import { bigramOverlap } from './queryFeedback';
import { ontologyEmbeddingEnabled, ontologyTokenBudget } from './ontologyConfig';

// ---------- 类型 ----------

export type OntologyEntityType = 'SUBJECT' | 'OBJECT' | 'TIME' | 'GEO';
export type OntologyStatus = 'ACTIVE' | 'DISABLED' | 'PENDING' | 'REJECTED';
export type OntologyBindingRole = 'IDENTITY' | 'ATTRIBUTE' | 'RELATION_KEY';
export type OntologyJoinType = 'INNER' | 'LEFT' | 'RIGHT';
export type OntologyCardinality = '1:1' | '1:N' | 'N:1' | 'N:N';
export type OntologyAssetType = 'entity' | 'relation' | 'hierarchy';

export interface OntologyEntity {
  id?: number;
  dataSourceId: string;
  /** 业务实体名（数据源内唯一），如「机构」 */
  name: string;
  entityType: OntologyEntityType;
  /** 业务别名，参与问数命中匹配 */
  aliases: string[];
  description: string;
  status: OntologyStatus;
  version?: number;
  createdBy?: string;
}

export interface OntologyBinding {
  id?: number;
  entityId: number;
  dataSourceId: string;
  tableName: string;
  /** 空串表示表级绑定 */
  columnName: string;
  role: OntologyBindingRole;
}

export interface OntologyValueNote {
  id?: number;
  dataSourceId: string;
  tableName: string;
  columnName: string;
  valueCode: string;
  meaning: string;
  status: 'ACTIVE' | 'DISABLED';
  createdBy?: string;
}

export interface OntologyRelation {
  id?: number;
  dataSourceId: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  joinType: OntologyJoinType;
  cardinality: OntologyCardinality;
  purpose: string;
  status: OntologyStatus;
  version?: number;
  createdBy?: string;
}

export interface OntologyHierarchy {
  id?: number;
  dataSourceId: string;
  name: string;
  /** 层级列序（由粗到细），如 [集团, 分公司, 项目] */
  levels: string[];
  status: OntologyStatus;
  version?: number;
  createdBy?: string;
}

/** 问数链路一次加载的本体快照（全部 ACTIVE） */
export interface OntologySnapshot {
  entities: OntologyEntity[];
  bindings: OntologyBinding[];
  valueNotes: OntologyValueNote[];
  relations: OntologyRelation[];
  hierarchies: OntologyHierarchy[];
}

/** 问题命中的实体及得分 */
export interface EntityHit {
  entity: OntologyEntity;
  score: number;
}

/** BFS 路径中的一条关系边（reversed=true 表示沿反向遍历） */
export interface RelationPathEdge {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  joinType: OntologyJoinType;
  cardinality: OntologyCardinality;
  purpose: string;
  reversed: boolean;
}

export interface RelationPath {
  /** 表名序列（含起止表） */
  tables: string[];
  edges: RelationPathEdge[];
  hops: number;
}

export interface OntologyVersionEntry {
  version: number;
  action: string;
  actor: string;
  createdAt: string;
  snapshot: Record<string, unknown>;
}

/** 注入上限（报告中「数十条」量级，超出按得分/顺序截断，防注入面稀释） */
export const MAX_ONTOLOGY_ENTITIES = 8;
export const MAX_ONTOLOGY_RELATIONS = 12;
export const MAX_ONTOLOGY_VALUE_NOTES = 40;
export const MAX_ONTOLOGY_HIERARCHIES = 5;

const IDENT_RE = /^[A-Za-z_]\w*$/;
const MAX_BINDINGS_PER_ENTITY = 20;
const MAX_LEVELS = 10;

// ---------- 校验 ----------

function asString(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function asAliases(v: unknown, name: string): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const a = raw.trim().slice(0, 50);
    if (!a || a === name || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
    if (out.length >= 10) break;
  }
  return out;
}

function asColumns(v: unknown): string[] {
  let source: unknown = v;
  // 兼容管理端提交 JSON 数组字符串（levels_json 原样回填场景）
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      source = JSON.parse(v);
    } catch {
      source = v;
    }
  }
  const raw = Array.isArray(source) ? source : typeof source === 'string' ? source.split(',') : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const c = item.trim();
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    out.push(c);
    if (out.length >= 10) break;
  }
  return out;
}

function normalizeEntityType(v: unknown): OntologyEntityType {
  return v === 'OBJECT' || v === 'TIME' || v === 'GEO' ? v : 'SUBJECT';
}

/** 外部（管理端）只允许 ACTIVE/DISABLED；PENDING/REJECTED 由后续 M3 治理流程驱动 */
function normalizeStatus(v: unknown): OntologyStatus {
  return v === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
}

export function sanitizeEntityInput(
  input: unknown
): { ok: true; entity: Omit<OntologyEntity, 'id' | 'version' | 'createdBy'> } | { ok: false; error: string } {
  const obj = (input ?? {}) as Record<string, unknown>;
  const dataSourceId = asString(obj.dataSourceId, 64);
  const name = asString(obj.name, 50);
  const description = asString(obj.description, 300);
  const aliases = asAliases(obj.aliases, name);
  if (!dataSourceId) return { ok: false, error: '缺少 dataSourceId' };
  if (!name) return { ok: false, error: '实体名必填且不超过 50 字' };
  if (aliases.length > 10) return { ok: false, error: '别名不超过 10 个' };
  return {
    ok: true,
    entity: { dataSourceId, name, entityType: normalizeEntityType(obj.entityType), aliases, description, status: normalizeStatus(obj.status) },
  };
}

export function sanitizeBindingsInput(
  entityId: number,
  dataSourceId: string,
  raw: unknown
): { ok: true; bindings: Omit<OntologyBinding, 'id'>[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'bindings 必须是数组' };
  if (raw.length > MAX_BINDINGS_PER_ENTITY) return { ok: false, error: `单个实体绑定不超过 ${MAX_BINDINGS_PER_ENTITY} 条` };
  const seen = new Set<string>();
  const bindings: Omit<OntologyBinding, 'id'>[] = [];
  for (const item of raw) {
    const obj = (item ?? {}) as Record<string, unknown>;
    const tableName = asString(obj.tableName, 64);
    const columnName = asString(obj.columnName, 64);
    const role: OntologyBindingRole =
      obj.role === 'ATTRIBUTE' || obj.role === 'RELATION_KEY' ? obj.role : 'IDENTITY';
    if (!IDENT_RE.test(tableName)) return { ok: false, error: `绑定表名必须是合法标识符：${tableName || '(空)'}` };
    if (columnName && !IDENT_RE.test(columnName)) return { ok: false, error: `绑定列名必须是合法标识符：${columnName}` };
    const key = `${tableName.toLowerCase()}.${columnName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({ entityId, dataSourceId, tableName, columnName, role });
  }
  return { ok: true, bindings };
}

export function sanitizeValueNoteInput(
  input: unknown
): { ok: true; note: Omit<OntologyValueNote, 'id' | 'createdBy'> } | { ok: false; error: string } {
  const obj = (input ?? {}) as Record<string, unknown>;
  const dataSourceId = asString(obj.dataSourceId, 64);
  const tableName = asString(obj.tableName, 64);
  const columnName = asString(obj.columnName, 64);
  const valueCode = asString(obj.valueCode, 100);
  const meaning = asString(obj.meaning, 200);
  if (!dataSourceId) return { ok: false, error: '缺少 dataSourceId' };
  if (!IDENT_RE.test(tableName)) return { ok: false, error: '表名必须是合法标识符' };
  if (!IDENT_RE.test(columnName)) return { ok: false, error: '列名必须是合法标识符' };
  if (!valueCode) return { ok: false, error: '值编码必填且不超过 100 字' };
  if (!meaning) return { ok: false, error: '含义必填且不超过 200 字' };
  return { ok: true, note: { dataSourceId, tableName, columnName, valueCode, meaning, status: obj.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE' } };
}

export function sanitizeRelationInput(
  input: unknown
): { ok: true; relation: Omit<OntologyRelation, 'id' | 'version' | 'createdBy'> } | { ok: false; error: string } {
  const obj = (input ?? {}) as Record<string, unknown>;
  const dataSourceId = asString(obj.dataSourceId, 64);
  const fromTable = asString(obj.fromTable, 64);
  const toTable = asString(obj.toTable, 64);
  const fromColumns = asColumns(obj.fromColumns);
  const toColumns = asColumns(obj.toColumns);
  const purpose = asString(obj.purpose, 300);
  if (!dataSourceId) return { ok: false, error: '缺少 dataSourceId' };
  if (!IDENT_RE.test(fromTable) || !IDENT_RE.test(toTable)) return { ok: false, error: '关联表名必须是合法标识符' };
  if (fromColumns.length === 0 || toColumns.length === 0) return { ok: false, error: '关联列必填（逗号分隔或数组）' };
  if (fromColumns.length !== toColumns.length) return { ok: false, error: '两侧关联列数量必须一致' };
  if (fromColumns.some((c) => !IDENT_RE.test(c)) || toColumns.some((c) => !IDENT_RE.test(c))) {
    return { ok: false, error: '关联列名必须是合法标识符' };
  }
  if (fromColumns.join(',').length > 300 || toColumns.join(',').length > 300) return { ok: false, error: '关联列拼接后不超过 300 字' };
  const joinType: OntologyJoinType = obj.joinType === 'INNER' || obj.joinType === 'RIGHT' ? obj.joinType : 'LEFT';
  const cardinality: OntologyCardinality =
    obj.cardinality === '1:1' || obj.cardinality === '1:N' || obj.cardinality === 'N:N' ? obj.cardinality : 'N:1';
  return { ok: true, relation: { dataSourceId, fromTable, fromColumns, toTable, toColumns, joinType, cardinality, purpose, status: normalizeStatus(obj.status) } };
}

export function sanitizeHierarchyInput(
  input: unknown
): { ok: true; hierarchy: Omit<OntologyHierarchy, 'id' | 'version' | 'createdBy'> } | { ok: false; error: string } {
  const obj = (input ?? {}) as Record<string, unknown>;
  const dataSourceId = asString(obj.dataSourceId, 64);
  const name = asString(obj.name, 50);
  const levels = asColumns(obj.levels ?? obj.levelsJson);
  if (!dataSourceId) return { ok: false, error: '缺少 dataSourceId' };
  if (!name) return { ok: false, error: '层级名称必填且不超过 50 字' };
  if (levels.length < 2) return { ok: false, error: '层级至少 2 级' };
  if (levels.length > MAX_LEVELS) return { ok: false, error: `层级不超过 ${MAX_LEVELS} 级` };
  if (levels.some((l) => !IDENT_RE.test(l))) return { ok: false, error: '层级列名必须是合法标识符' };
  return { ok: true, hierarchy: { dataSourceId, name, levels, status: normalizeStatus(obj.status) } };
}

// ---------- 读取 ----------

function parseJsonArray(raw: unknown): string[] {
  try {
    const arr = JSON.parse(String(raw || '[]'));
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToEntity(r: RowDataPacket): OntologyEntity {
  return {
    id: Number(r.id),
    dataSourceId: String(r.data_source_id || ''),
    name: String(r.name || ''),
    entityType: normalizeEntityType(r.entity_type),
    aliases: parseJsonArray(r.aliases_json),
    description: String(r.description || ''),
    status: (['DISABLED', 'PENDING', 'REJECTED'].includes(String(r.status)) ? String(r.status) : 'ACTIVE') as OntologyStatus,
    version: Number(r.version) || 1,
    createdBy: String(r.created_by || ''),
  };
}

function rowToBinding(r: RowDataPacket): OntologyBinding {
  return {
    id: Number(r.id),
    entityId: Number(r.entity_id),
    dataSourceId: String(r.data_source_id || ''),
    tableName: String(r.table_name || ''),
    columnName: String(r.column_name || ''),
    role: (['ATTRIBUTE', 'RELATION_KEY'].includes(String(r.role)) ? String(r.role) : 'IDENTITY') as OntologyBindingRole,
  };
}

function rowToValueNote(r: RowDataPacket): OntologyValueNote {
  return {
    id: Number(r.id),
    dataSourceId: String(r.data_source_id || ''),
    tableName: String(r.table_name || ''),
    columnName: String(r.column_name || ''),
    valueCode: String(r.value_code || ''),
    meaning: String(r.meaning || ''),
    status: r.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
    createdBy: String(r.created_by || ''),
  };
}

function rowToRelation(r: RowDataPacket): OntologyRelation {
  const joinType = String(r.join_type);
  const cardinality = String(r.cardinality);
  return {
    id: Number(r.id),
    dataSourceId: String(r.data_source_id || ''),
    fromTable: String(r.from_table || ''),
    fromColumns: String(r.from_columns || '').split(',').map((c) => c.trim()).filter(Boolean),
    toTable: String(r.to_table || ''),
    toColumns: String(r.to_columns || '').split(',').map((c) => c.trim()).filter(Boolean),
    joinType: (joinType === 'INNER' || joinType === 'RIGHT' ? joinType : 'LEFT') as OntologyJoinType,
    cardinality: (['1:1', '1:N', 'N:N'].includes(cardinality) ? cardinality : 'N:1') as OntologyCardinality,
    purpose: String(r.purpose || ''),
    status: (['DISABLED', 'PENDING', 'REJECTED'].includes(String(r.status)) ? String(r.status) : 'ACTIVE') as OntologyStatus,
    version: Number(r.version) || 1,
    createdBy: String(r.created_by || ''),
  };
}

function rowToHierarchy(r: RowDataPacket): OntologyHierarchy {
  return {
    id: Number(r.id),
    dataSourceId: String(r.data_source_id || ''),
    name: String(r.name || ''),
    levels: parseJsonArray(r.levels_json),
    status: (['DISABLED', 'PENDING', 'REJECTED'].includes(String(r.status)) ? String(r.status) : 'ACTIVE') as OntologyStatus,
    version: Number(r.version) || 1,
    createdBy: String(r.created_by || ''),
  };
}

/** 空快照（无本体数据 / 加载失败 / 开关关闭时的统一降级值） */
export function emptyOntologySnapshot(): OntologySnapshot {
  return { entities: [], bindings: [], valueNotes: [], relations: [], hierarchies: [] };
}

/**
 * 问数链路一次并行加载 5 类 ACTIVE 资产；失败仅记 logger.warn 并返回空快照（问数不阻断）。
 * 实体/绑定/值域/关系/层级量级为「数十条」，5 条小表查询开销可忽略。
 */
export async function loadActiveOntology(dataSourceId: string): Promise<OntologySnapshot> {
  try {
    const pool = getPool();
    const [entities, bindings, valueNotes, relations, hierarchies] = await Promise.all([
      pool.query<RowDataPacket[]>("SELECT * FROM ontology_entities WHERE data_source_id = ? AND status = 'ACTIVE' ORDER BY id ASC LIMIT 200", [dataSourceId]),
      pool.query<RowDataPacket[]>('SELECT * FROM ontology_bindings WHERE data_source_id = ? ORDER BY id ASC LIMIT 1000', [dataSourceId]),
      pool.query<RowDataPacket[]>("SELECT * FROM ontology_value_notes WHERE data_source_id = ? AND status = 'ACTIVE' ORDER BY table_name ASC, column_name ASC, id ASC LIMIT 1000", [dataSourceId]),
      pool.query<RowDataPacket[]>("SELECT * FROM ontology_relations WHERE data_source_id = ? AND status = 'ACTIVE' ORDER BY id ASC LIMIT 300", [dataSourceId]),
      pool.query<RowDataPacket[]>("SELECT * FROM ontology_hierarchies WHERE data_source_id = ? AND status = 'ACTIVE' ORDER BY id ASC LIMIT 50", [dataSourceId]),
    ]);
    return {
      entities: entities[0].map(rowToEntity),
      bindings: bindings[0].map(rowToBinding),
      valueNotes: valueNotes[0].map(rowToValueNote),
      relations: relations[0].map(rowToRelation),
      hierarchies: hierarchies[0].map(rowToHierarchy),
    };
  } catch (err) {
    logger.warn('[Ontology] 本体快照加载失败，按零注入降级:', err);
    return emptyOntologySnapshot();
  }
}

/** 实体列表（管理端用，含停用/待审；附绑定），供面板一次渲染 */
export async function listEntities(dataSourceId: string): Promise<(OntologyEntity & { bindings: OntologyBinding[] })[]> {
  const pool = getPool();
  const [entityRows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM ontology_entities WHERE data_source_id = ? ORDER BY created_at DESC, id DESC LIMIT 500',
    [dataSourceId]
  );
  const entities = entityRows.map(rowToEntity);
  if (entities.length === 0) return [];
  const [bindingRows] = await pool.query<RowDataPacket[]>(
    'SELECT * FROM ontology_bindings WHERE data_source_id = ? ORDER BY id ASC LIMIT 2000',
    [dataSourceId]
  );
  const byEntity = new Map<number, OntologyBinding[]>();
  for (const b of bindingRows.map(rowToBinding)) {
    const list = byEntity.get(b.entityId) || [];
    list.push(b);
    byEntity.set(b.entityId, list);
  }
  return entities.map((e) => ({ ...e, bindings: byEntity.get(Number(e.id)) || [] }));
}

export async function listValueNotes(dataSourceId: string, tableName?: string): Promise<OntologyValueNote[]> {
  const sql = tableName
    ? 'SELECT * FROM ontology_value_notes WHERE data_source_id = ? AND table_name = ? ORDER BY table_name ASC, column_name ASC, id ASC LIMIT 1000'
    : 'SELECT * FROM ontology_value_notes WHERE data_source_id = ? ORDER BY table_name ASC, column_name ASC, id ASC LIMIT 1000';
  const params = tableName ? [dataSourceId, tableName] : [dataSourceId];
  const [rows] = await getPool().query<RowDataPacket[]>(sql, params);
  return rows.map(rowToValueNote);
}

export async function listRelations(dataSourceId: string): Promise<OntologyRelation[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT * FROM ontology_relations WHERE data_source_id = ? ORDER BY created_at DESC, id DESC LIMIT 500',
    [dataSourceId]
  );
  return rows.map(rowToRelation);
}

export async function listHierarchies(dataSourceId: string): Promise<OntologyHierarchy[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT * FROM ontology_hierarchies WHERE data_source_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
    [dataSourceId]
  );
  return rows.map(rowToHierarchy);
}

// ---------- 匹配与打分 ----------

/**
 * 问数问题 → 命中实体（确定性、零延迟）：
 * 名称/别名子串命中 weight 10（别名与名称同等，命中即计一次）；描述 bigram 重合率 × 2 作为弱信号。
 */
export function matchEntities(question: string, entities: OntologyEntity[]): EntityHit[] {
  const q = String(question || '');
  if (!q.trim() || !Array.isArray(entities)) return [];
  const hits: EntityHit[] = [];
  for (const e of entities) {
    if (!e || !e.name) continue;
    let score = 0;
    if (q.includes(e.name)) score += 10;
    if (e.aliases.some((a) => a && q.includes(a))) score += 10;
    if (e.description) {
      const grams = Math.max(1, e.description.length - 1);
      const ratio = Math.min(1, bigramOverlap(q, e.description) / grams);
      if (ratio > 0) score += ratio * 2;
    }
    if (score > 0) hits.push({ entity: e, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}

function cosine(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * embedding 精排（可选）：在关键词得分上叠加余弦 × 10，提高同义表述召回。
 * 任何一步失败（无 embedding 模型/网络异常）自动降级返回原关键词排序，不阻断问数。
 */
export async function rerankEntitiesAsync(question: string, hits: EntityHit[]): Promise<EntityHit[]> {
  if (!ontologyEmbeddingEnabled() || hits.length <= 1) return hits;
  try {
    const qv = await callEmbedding(question, 'query');
    const docs = hits.map((h) => `${h.entity.name} ${h.entity.aliases.join(' ')} ${h.entity.description}`.trim());
    const vecs = await callEmbeddingBatch(docs, 'document');
    const reranked = hits.map((h, i) => {
      const v = vecs[i];
      return v ? { entity: h.entity, score: h.score + cosine(qv, v) * 10 } : h;
    });
    return reranked.sort((a, b) => b.score - a.score);
  } catch {
    return hits;
  }
}

/** 命中实体的绑定表加权：IDENTITY +8 / RELATION_KEY +4 / ATTRIBUTE +3，单表封顶 +15 */
export function tableBoostsFromBindings(hits: EntityHit[], bindings: OntologyBinding[]): Map<string, number> {
  const hitIds = new Set(hits.map((h) => Number(h.entity.id)).filter((id) => Number.isFinite(id) && id > 0));
  const boosts = new Map<string, number>();
  if (hitIds.size === 0 || !Array.isArray(bindings)) return boosts;
  const roleBoost: Record<OntologyBindingRole, number> = { IDENTITY: 8, RELATION_KEY: 4, ATTRIBUTE: 3 };
  for (const b of bindings) {
    if (!hitIds.has(Number(b.entityId)) || !b.tableName) continue;
    boosts.set(b.tableName, (boosts.get(b.tableName) || 0) + (roleBoost[b.role] || 0));
  }
  for (const [table, value] of boosts) boosts.set(table, Math.min(value, 15));
  return boosts;
}

// ---------- 关系路径（BFS） ----------

function relationNeighbors(relations: OntologyRelation[]): Map<string, { edge: RelationPathEdge; next: string }[]> {
  const adj = new Map<string, { edge: RelationPathEdge; next: string }[]>();
  // 邻接表 key 用小写（表名大小写不敏感），边内保留 Schema 原表名供 prompt 展示
  const push = (from: string, next: string, edge: RelationPathEdge) => {
    const key = from.toLowerCase();
    const list = adj.get(key) || [];
    list.push({ edge, next: next.toLowerCase() });
    adj.set(key, list);
  };
  for (const r of relations) {
    if (!r || !r.fromTable || !r.toTable) continue;
    // 正向
    push(r.fromTable, r.toTable, {
      fromTable: r.fromTable,
      fromColumns: r.fromColumns,
      toTable: r.toTable,
      toColumns: r.toColumns,
      joinType: r.joinType,
      cardinality: r.cardinality,
      purpose: r.purpose,
      reversed: false,
    });
    // 反向（JOIN 可双向推导，base 表可互换）
    if (r.fromTable !== r.toTable) {
      push(r.toTable, r.fromTable, {
        fromTable: r.toTable,
        fromColumns: r.toColumns,
        toTable: r.fromTable,
        toColumns: r.fromColumns,
        joinType: r.joinType,
        cardinality: r.cardinality,
        purpose: r.purpose,
        reversed: true,
      });
    }
  }
  return adj;
}

/**
 * 已登记 JOIN 路径检索（内存 BFS，最多 maxDepth 跳、最多 3 条最短路）。
 * 关系量级小，避免递归 CTE；返回空数组表示未登记路径（提示词据此给候选提示）。
 */
export function findRelationPaths(
  fromTable: string,
  toTable: string,
  relations: OntologyRelation[],
  maxDepth = 3
): RelationPath[] {
  const from = String(fromTable || '').toLowerCase();
  const to = String(toTable || '').toLowerCase();
  if (!from || !to || from === to) return [];
  const adj = relationNeighbors(Array.isArray(relations) ? relations.filter((r) => !r.status || r.status === 'ACTIVE') : []);
  const results: RelationPath[] = [];
  const queue: { table: string; tables: string[]; edges: RelationPathEdge[]; visited: Set<string> }[] = [
    { table: from, tables: [from], edges: [], visited: new Set([from]) },
  ];
  while (queue.length > 0 && results.length < 3) {
    const cur = queue.shift() as (typeof queue)[number];
    if (cur.edges.length >= maxDepth) continue;
    for (const { edge, next } of adj.get(cur.table) || []) {
      if (cur.visited.has(next)) continue;
      const tables = [...cur.tables, next];
      const edges = [...cur.edges, edge];
      if (next === to) {
        results.push({ tables, edges, hops: edges.length });
        if (results.length >= 3) break;
        continue;
      }
      queue.push({ table: next, tables, edges, visited: new Set([...cur.visited, next]) });
    }
  }
  return results;
}

// ---------- 提示词 ----------

export interface OntologyPromptInput {
  entityHits: EntityHit[];
  bindings: OntologyBinding[];
  valueNotes: OntologyValueNote[];
  relations: OntologyRelation[];
  hierarchies: OntologyHierarchy[];
  /** 本轮圈定的提示词表（值域/关系按此过滤，避免无关表信息稀释注意力） */
  promptTables: string[];
  /** 注入预算（近似 token），缺省 ontologyTokenBudget() */
  budgetTokens?: number;
}

/** 提示词内部按预算逐行追加（段头后零内容时撤销段头，不留空段） */
function createSectionWriter(budget: number) {
  const parts: string[] = [];
  let used = 0;
  const push = (text: string): boolean => {
    const cost = approxTokens(text);
    if (used + cost > budget) return false;
    parts.push(text);
    used += cost;
    return true;
  };
  const section = (header: string, lines: string[]): void => {
    if (lines.length === 0) return;
    if (!push(header)) return;
    let emitted = 0;
    for (const line of lines) {
      if (!push(line)) break;
      emitted++;
    }
    if (emitted === 0) parts.pop();
  };
  return { parts, section, used: () => used };
}

/**
 * 本体提示词四段（实体/值域释义/关联路径/业务层级）+ 优先级声明。
 * 顺序与 buildStage1SystemV2 一致（本体位于铁律、指标之后，业务口径、知识库之前）；
 * 路径只作推荐，最终仍受 Schema 表白名单约束（软注入，不拼 SQL、不拒答）。
 */
export function buildOntologyPrompt(input: OntologyPromptInput): string {
  const hits = (Array.isArray(input.entityHits) ? input.entityHits : []).slice(0, MAX_ONTOLOGY_ENTITIES);
  const bindings = Array.isArray(input.bindings) ? input.bindings : [];
  const relations = Array.isArray(input.relations) ? input.relations : [];
  const hierarchies = Array.isArray(input.hierarchies) ? input.hierarchies : [];
  const promptTables = (input.promptTables || []).map((t) => String(t || '')).filter(Boolean);
  const promptTableSet = new Set(promptTables.map((t) => t.toLowerCase()));
  const hitTableSet = new Set<string>(promptTableSet);
  const bindingsByEntity = new Map<number, OntologyBinding[]>();
  for (const b of bindings) {
    const list = bindingsByEntity.get(Number(b.entityId)) || [];
    list.push(b);
    bindingsByEntity.set(Number(b.entityId), list);
  }
  for (const h of hits) {
    for (const b of bindingsByEntity.get(Number(h.entity.id)) || []) hitTableSet.add(b.tableName.toLowerCase());
  }

  const writer = createSectionWriter(input.budgetTokens ?? ontologyTokenBudget());

  // 1) 业务实体
  const entityLines = hits.map((h) => {
    const e = h.entity;
    const alias = e.aliases.length > 0 ? `别名：${e.aliases.join('、')}；` : '';
    const bs = bindingsByEntity.get(Number(e.id)) || [];
    const bindText = bs.length > 0
      ? bs.map((b) => `${b.tableName}${b.columnName ? `.${b.columnName}` : ''}[${b.role}]`).join('、')
      : '（未维护绑定）';
    const desc = e.description ? `；说明：${e.description}` : '';
    return `- ${e.name}（${e.entityType}；${alias}绑定：${bindText}${desc}）\n`;
  });
  writer.section('【业务实体】（管理员登记的业务实体与绑定，问题涉及这些实体时必须使用其绑定表/列）\n', entityLines);

  // 2) 值域释义（仅命中相关表）
  const valueLines = input.valueNotes
    .filter((n) => n && n.status !== 'DISABLED' && hitTableSet.has(String(n.tableName || '').toLowerCase()))
    .slice(0, MAX_ONTOLOGY_VALUE_NOTES)
    .map((n) => `- ${n.tableName}.${n.columnName} = ${n.valueCode} → ${n.meaning}\n`);
  writer.section('【值域释义】（枚举/编码列的权威取值含义，过滤条件必须按此写法）\n', valueLines);

  // 3) 关联路径（命中表之间的已登记路径；无路径时给候选提示）
  const relevant = new Set<string>(hitTableSet);
  const relationLines: string[] = [];
  for (const r of relations) {
    if (!r || r.status === 'DISABLED') continue;
    const a = String(r.fromTable || '').toLowerCase();
    const b = String(r.toTable || '').toLowerCase();
    if (!relevant.has(a) || !relevant.has(b)) continue;
    relationLines.push(`- ${r.fromTable}(${r.fromColumns.join(',')}) -[${r.joinType}, ${r.cardinality}]-> ${r.toTable}(${r.toColumns.join(',')})${r.purpose ? `（${r.purpose}）` : ''}\n`);
    if (relationLines.length >= MAX_ONTOLOGY_RELATIONS) break;
  }
  if (relationLines.length === 0 && relevant.size >= 2) {
    relationLines.push('- （未登记关联路径）多表查询须按 Schema 中的同名列/外键语义推导 JOIN，并在 thoughtProcess 说明关联依据\n');
  }
  writer.section('【关联路径】（管理员登记的 JOIN 路径，涉及多表关联时优先按此写法）\n', relationLines);

  // 4) 业务层级
  const hierarchyLines = hierarchies
    .filter((h) => h && h.status !== 'DISABLED' && h.levels.length > 0)
    .slice(0, MAX_ONTOLOGY_HIERARCHIES)
    .map((h) => `- ${h.name}：${h.levels.join(' > ')}\n`);
  writer.section('【业务层级】（下钻/分组时按层级列序由粗到细）\n', hierarchyLines);

  const body = writer.parts.join('');
  if (!body.trim()) return '';
  return (
    body +
    '【本体使用约束】以上本体信息仅作推荐与释义：优先级 铁律 > 语义指标 > 业务本体 > 业务口径 > 知识库；' +
    '关联路径未经登记时不得臆造 JOIN 条件，最终表/列仍须严格取自 Schema 白名单。\n\n'
  );
}

// ---------- 版本与写入 ----------

async function recordVersion(
  assetType: OntologyAssetType,
  assetId: number,
  version: number,
  snapshot: Record<string, unknown>,
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE',
  actor: string
): Promise<void> {
  await getPool().query(
    'INSERT INTO ontology_versions (asset_type, asset_id, version, snapshot_json, action, actor) VALUES (?, ?, ?, ?, ?, ?)',
    [assetType, assetId, version, JSON.stringify(snapshot), action, actor]
  );
}

export async function listOntologyVersions(assetType: OntologyAssetType, assetId: number): Promise<OntologyVersionEntry[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT * FROM ontology_versions WHERE asset_type = ? AND asset_id = ? ORDER BY version DESC, id DESC LIMIT 100',
    [assetType, assetId]
  );
  return rows.map((r) => {
    let snapshot: Record<string, unknown> = {};
    try {
      snapshot = JSON.parse(String(r.snapshot_json || '{}'));
    } catch {
      /* 忽略坏快照 */
    }
    return { version: Number(r.version), action: String(r.action || ''), actor: String(r.actor || ''), createdAt: String(r.created_at || ''), snapshot };
  });
}

async function findById(table: 'ontology_entities' | 'ontology_relations' | 'ontology_hierarchies', id: number): Promise<RowDataPacket | null> {
  const [rows] = await getPool().query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [id]);
  return rows.length > 0 ? rows[0] : null;
}

// ----- 实体 -----

export async function createEntity(
  entity: Omit<OntologyEntity, 'id' | 'version' | 'createdBy'>,
  actor: string
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const pool = getPool();
  const [dup] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM ontology_entities WHERE data_source_id = ? AND name = ? LIMIT 1',
    [entity.dataSourceId, entity.name]
  );
  if (dup.length > 0) return { ok: false, error: '同名业务实体已存在' };
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO ontology_entities (data_source_id, name, entity_type, aliases_json, description, status, version, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    [entity.dataSourceId, entity.name, entity.entityType, JSON.stringify(entity.aliases), entity.description, entity.status, actor]
  );
  await recordVersion('entity', result.insertId, 1, { ...entity }, 'CREATE', actor);
  return { ok: true, id: result.insertId };
}

export async function updateEntity(
  id: number,
  entity: Omit<OntologyEntity, 'id' | 'dataSourceId' | 'version' | 'createdBy'>,
  actor = '',
  action: 'UPDATE' | 'RESTORE' = 'UPDATE'
): Promise<{ ok: true } | { ok: false; error: string; notFound?: boolean }> {
  const row = await findById('ontology_entities', id);
  if (!row) return { ok: false, error: '业务实体不存在', notFound: true };
  const cur = rowToEntity(row);
  const pool = getPool();
  const [dup] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM ontology_entities WHERE data_source_id = ? AND name = ? AND id <> ? LIMIT 1',
    [cur.dataSourceId, entity.name, id]
  );
  if (dup.length > 0) return { ok: false, error: '同名业务实体已存在' };
  const nextVersion = (cur.version || 1) + 1;
  await pool.query(
    'UPDATE ontology_entities SET name = ?, entity_type = ?, aliases_json = ?, description = ?, status = ?, version = ? WHERE id = ?',
    [entity.name, entity.entityType, JSON.stringify(entity.aliases), entity.description, entity.status, nextVersion, id]
  );
  await recordVersion('entity', id, nextVersion, { ...entity, dataSourceId: cur.dataSourceId }, action, actor);
  return { ok: true };
}

export async function deleteEntity(id: number, actor = ''): Promise<boolean> {
  const row = await findById('ontology_entities', id);
  if (!row) return false;
  const cur = rowToEntity(row);
  const pool = getPool();
  await pool.query('DELETE FROM ontology_bindings WHERE entity_id = ?', [id]);
  const [result] = await pool.query<ResultSetHeader>('DELETE FROM ontology_entities WHERE id = ?', [id]);
  if (result.affectedRows > 0) await recordVersion('entity', id, (cur.version || 1) + 1, { ...cur }, 'DELETE', actor);
  return result.affectedRows > 0;
}

/** 绑定整组替换（先删后插）；绑定不单独版本化，实体快照保留定义部分 */
export async function replaceBindings(
  entityId: number,
  bindings: Omit<OntologyBinding, 'id'>[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await findById('ontology_entities', entityId);
  if (!row) return { ok: false, error: '业务实体不存在' };
  const pool = getPool();
  await pool.query('DELETE FROM ontology_bindings WHERE entity_id = ?', [entityId]);
  for (const b of bindings) {
    await pool.query(
      'INSERT INTO ontology_bindings (entity_id, data_source_id, table_name, column_name, role) VALUES (?, ?, ?, ?, ?)',
      [b.entityId, b.dataSourceId, b.tableName, b.columnName, b.role]
    );
  }
  return { ok: true };
}

export async function restoreEntityVersion(
  id: number,
  version: number,
  actor: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const row = await findById('ontology_entities', id);
  if (!row) return { ok: false, status: 404, error: '业务实体不存在' };
  const cur = rowToEntity(row);
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT * FROM ontology_versions WHERE asset_type = 'entity' AND asset_id = ? AND version = ? ORDER BY id DESC LIMIT 1",
    [id, version]
  );
  if (rows.length === 0) return { ok: false, status: 404, error: '版本不存在' };
  let snap: Record<string, unknown>;
  try {
    snap = JSON.parse(String(rows[0].snapshot_json || '{}'));
  } catch {
    return { ok: false, status: 500, error: '版本快照损坏' };
  }
  const cleaned = sanitizeEntityInput({ ...snap, dataSourceId: cur.dataSourceId });
  if (cleaned.ok !== true) return { ok: false, status: 500, error: `版本快照校验失败：${cleaned.error}` };
  const { dataSourceId: _ds, ...rest } = cleaned.entity;
  const r = await updateEntity(id, { ...rest, status: cur.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED' }, actor, 'RESTORE');
  if (r.ok !== true) return { ok: false, status: r.notFound ? 404 : 409, error: r.error };
  return { ok: true };
}

// ----- 值域释义 -----

/** 值域 upsert：同 (数据源, 表, 列, 值) 唯一键存在则更新含义/状态，否则新增 */
export async function upsertValueNote(
  note: Omit<OntologyValueNote, 'id' | 'createdBy'>,
  actor: string
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM ontology_value_notes WHERE data_source_id = ? AND table_name = ? AND column_name = ? AND value_code = ? LIMIT 1',
    [note.dataSourceId, note.tableName, note.columnName, note.valueCode]
  );
  if (rows.length > 0) {
    const id = Number(rows[0].id);
    await pool.query('UPDATE ontology_value_notes SET meaning = ?, status = ? WHERE id = ?', [note.meaning, note.status, id]);
    return { ok: true, id };
  }
  const [result] = await pool.query<ResultSetHeader>(
    'INSERT INTO ontology_value_notes (data_source_id, table_name, column_name, value_code, meaning, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [note.dataSourceId, note.tableName, note.columnName, note.valueCode, note.meaning, note.status, actor]
  );
  return { ok: true, id: result.insertId };
}

export async function deleteValueNote(id: number): Promise<boolean> {
  const [result] = await getPool().query<ResultSetHeader>('DELETE FROM ontology_value_notes WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

/** 按 ID 更新含义/状态（管理端行内编辑；唯一键四元组不随编辑变化） */
export async function updateValueNote(
  id: number,
  patch: unknown
): Promise<{ ok: true } | { ok: false; error: string; notFound?: boolean }> {
  const obj = (patch ?? {}) as Record<string, unknown>;
  const meaning = asString(obj.meaning, 200);
  if (!meaning) return { ok: false, error: '含义必填且不超过 200 字' };
  const status = obj.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
  const [result] = await getPool().query<ResultSetHeader>(
    'UPDATE ontology_value_notes SET meaning = ?, status = ? WHERE id = ?',
    [meaning, status, id]
  );
  if (result.affectedRows === 0) return { ok: false, error: '值域释义不存在', notFound: true };
  return { ok: true };
}

// ----- 关系 -----

export async function createRelation(
  relation: Omit<OntologyRelation, 'id' | 'version' | 'createdBy'>,
  actor: string
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const pool = getPool();
  const [dup] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM ontology_relations WHERE data_source_id = ? AND from_table = ? AND from_columns = ? AND to_table = ? AND to_columns = ? LIMIT 1',
    [relation.dataSourceId, relation.fromTable, relation.fromColumns.join(','), relation.toTable, relation.toColumns.join(',')]
  );
  if (dup.length > 0) return { ok: false, error: '同一方向的关联路径已登记' };
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO ontology_relations (data_source_id, from_table, from_columns, to_table, to_columns, join_type, cardinality, purpose, status, version, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [relation.dataSourceId, relation.fromTable, relation.fromColumns.join(','), relation.toTable, relation.toColumns.join(','), relation.joinType, relation.cardinality, relation.purpose, relation.status, actor]
  );
  await recordVersion('relation', result.insertId, 1, { ...relation }, 'CREATE', actor);
  return { ok: true, id: result.insertId };
}

export async function updateRelation(
  id: number,
  relation: Omit<OntologyRelation, 'id' | 'dataSourceId' | 'version' | 'createdBy'>,
  actor = '',
  action: 'UPDATE' | 'RESTORE' = 'UPDATE'
): Promise<{ ok: true } | { ok: false; error: string; notFound?: boolean }> {
  const row = await findById('ontology_relations', id);
  if (!row) return { ok: false, error: '关联路径不存在', notFound: true };
  const cur = rowToRelation(row);
  const nextVersion = (cur.version || 1) + 1;
  await getPool().query(
    'UPDATE ontology_relations SET from_table = ?, from_columns = ?, to_table = ?, to_columns = ?, join_type = ?, cardinality = ?, purpose = ?, status = ?, version = ? WHERE id = ?',
    [relation.fromTable, relation.fromColumns.join(','), relation.toTable, relation.toColumns.join(','), relation.joinType, relation.cardinality, relation.purpose, relation.status, nextVersion, id]
  );
  await recordVersion('relation', id, nextVersion, { ...relation, dataSourceId: cur.dataSourceId }, action, actor);
  return { ok: true };
}

export async function deleteRelation(id: number, actor = ''): Promise<boolean> {
  const row = await findById('ontology_relations', id);
  if (!row) return false;
  const cur = rowToRelation(row);
  const [result] = await getPool().query<ResultSetHeader>('DELETE FROM ontology_relations WHERE id = ?', [id]);
  if (result.affectedRows > 0) await recordVersion('relation', id, (cur.version || 1) + 1, { ...cur }, 'DELETE', actor);
  return result.affectedRows > 0;
}

export async function restoreRelationVersion(
  id: number,
  version: number,
  actor: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const row = await findById('ontology_relations', id);
  if (!row) return { ok: false, status: 404, error: '关联路径不存在' };
  const cur = rowToRelation(row);
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT * FROM ontology_versions WHERE asset_type = 'relation' AND asset_id = ? AND version = ? ORDER BY id DESC LIMIT 1",
    [id, version]
  );
  if (rows.length === 0) return { ok: false, status: 404, error: '版本不存在' };
  let snap: Record<string, unknown>;
  try {
    snap = JSON.parse(String(rows[0].snapshot_json || '{}'));
  } catch {
    return { ok: false, status: 500, error: '版本快照损坏' };
  }
  const cleaned = sanitizeRelationInput({ ...snap, dataSourceId: cur.dataSourceId });
  if (cleaned.ok !== true) return { ok: false, status: 500, error: `版本快照校验失败：${cleaned.error}` };
  const { dataSourceId: _ds, ...rest } = cleaned.relation;
  const r = await updateRelation(id, { ...rest, status: cur.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED' }, actor, 'RESTORE');
  if (r.ok !== true) return { ok: false, status: r.notFound ? 404 : 409, error: r.error };
  return { ok: true };
}

// ----- 层级 -----

export async function createHierarchy(
  hierarchy: Omit<OntologyHierarchy, 'id' | 'version' | 'createdBy'>,
  actor: string
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const pool = getPool();
  const [dup] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM ontology_hierarchies WHERE data_source_id = ? AND name = ? LIMIT 1',
    [hierarchy.dataSourceId, hierarchy.name]
  );
  if (dup.length > 0) return { ok: false, error: '同名业务层级已存在' };
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO ontology_hierarchies (data_source_id, name, levels_json, status, version, created_by)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [hierarchy.dataSourceId, hierarchy.name, JSON.stringify(hierarchy.levels), hierarchy.status, actor]
  );
  await recordVersion('hierarchy', result.insertId, 1, { ...hierarchy }, 'CREATE', actor);
  return { ok: true, id: result.insertId };
}

export async function updateHierarchy(
  id: number,
  hierarchy: Omit<OntologyHierarchy, 'id' | 'dataSourceId' | 'version' | 'createdBy'>,
  actor = '',
  action: 'UPDATE' | 'RESTORE' = 'UPDATE'
): Promise<{ ok: true } | { ok: false; error: string; notFound?: boolean }> {
  const row = await findById('ontology_hierarchies', id);
  if (!row) return { ok: false, error: '业务层级不存在', notFound: true };
  const cur = rowToHierarchy(row);
  const pool = getPool();
  const [dup] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM ontology_hierarchies WHERE data_source_id = ? AND name = ? AND id <> ? LIMIT 1',
    [cur.dataSourceId, hierarchy.name, id]
  );
  if (dup.length > 0) return { ok: false, error: '同名业务层级已存在' };
  const nextVersion = (cur.version || 1) + 1;
  await pool.query(
    'UPDATE ontology_hierarchies SET name = ?, levels_json = ?, status = ?, version = ? WHERE id = ?',
    [hierarchy.name, JSON.stringify(hierarchy.levels), hierarchy.status, nextVersion, id]
  );
  await recordVersion('hierarchy', id, nextVersion, { ...hierarchy, dataSourceId: cur.dataSourceId }, action, actor);
  return { ok: true };
}

export async function deleteHierarchy(id: number, actor = ''): Promise<boolean> {
  const row = await findById('ontology_hierarchies', id);
  if (!row) return false;
  const cur = rowToHierarchy(row);
  const [result] = await getPool().query<ResultSetHeader>('DELETE FROM ontology_hierarchies WHERE id = ?', [id]);
  if (result.affectedRows > 0) await recordVersion('hierarchy', id, (cur.version || 1) + 1, { ...cur }, 'DELETE', actor);
  return result.affectedRows > 0;
}

export async function restoreHierarchyVersion(
  id: number,
  version: number,
  actor: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const row = await findById('ontology_hierarchies', id);
  if (!row) return { ok: false, status: 404, error: '业务层级不存在' };
  const cur = rowToHierarchy(row);
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT * FROM ontology_versions WHERE asset_type = 'hierarchy' AND asset_id = ? AND version = ? ORDER BY id DESC LIMIT 1",
    [id, version]
  );
  if (rows.length === 0) return { ok: false, status: 404, error: '版本不存在' };
  let snap: Record<string, unknown>;
  try {
    snap = JSON.parse(String(rows[0].snapshot_json || '{}'));
  } catch {
    return { ok: false, status: 500, error: '版本快照损坏' };
  }
  const cleaned = sanitizeHierarchyInput({ ...snap, dataSourceId: cur.dataSourceId });
  if (cleaned.ok !== true) return { ok: false, status: 500, error: `版本快照校验失败：${cleaned.error}` };
  const { dataSourceId: _ds, ...rest } = cleaned.hierarchy;
  const r = await updateHierarchy(id, { ...rest, status: cur.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED' }, actor, 'RESTORE');
  if (r.ok !== true) return { ok: false, status: r.notFound ? 404 : 409, error: r.error };
  return { ok: true };
}

// ---------- 概览 ----------

export interface OntologySummary {
  entities: number;
  valueNotes: number;
  relations: number;
  hierarchies: number;
  bindings: number;
}

/** 管理端概览计数（仅 ACTIVE，供面板顶部计数条） */
export async function ontologySummary(dataSourceId: string): Promise<OntologySummary> {
  const pool = getPool();
  const [e, v, r, h, b] = await Promise.all([
    pool.query<RowDataPacket[]>("SELECT COUNT(*) AS cnt FROM ontology_entities WHERE data_source_id = ? AND status = 'ACTIVE'", [dataSourceId]),
    pool.query<RowDataPacket[]>("SELECT COUNT(*) AS cnt FROM ontology_value_notes WHERE data_source_id = ? AND status = 'ACTIVE'", [dataSourceId]),
    pool.query<RowDataPacket[]>("SELECT COUNT(*) AS cnt FROM ontology_relations WHERE data_source_id = ? AND status = 'ACTIVE'", [dataSourceId]),
    pool.query<RowDataPacket[]>("SELECT COUNT(*) AS cnt FROM ontology_hierarchies WHERE data_source_id = ? AND status = 'ACTIVE'", [dataSourceId]),
    pool.query<RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM ontology_bindings WHERE data_source_id = ?', [dataSourceId]),
  ]);
  return {
    entities: Number(e[0][0]?.cnt || 0),
    valueNotes: Number(v[0][0]?.cnt || 0),
    relations: Number(r[0][0]?.cnt || 0),
    hierarchies: Number(h[0][0]?.cnt || 0),
    bindings: Number(b[0][0]?.cnt || 0),
  };
}
