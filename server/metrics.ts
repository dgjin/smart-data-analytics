/**
 * P1-1 语义指标层：管理员登记结构化业务指标定义（名称/同义词/聚合口径/归属表/固定过滤），
 * 问数阶段一按「问题命中指标名/同义词 → 模板化注入口径」生成 SQL，
 * 保证同一指标全系统口径一致，消除 LLM 每次自由发挥导致的指标漂移。
 * 指标文本仅注入 prompt（不直接拼接 SQL），生成结果仍过安全执行层校验。
 *
 * P1-8 指标层治理：提议（PENDING，分析师可发起）→ ADMIN 审批（ACTIVE/REJECTED）→ 生效版本化。
 * 未审批（PENDING/REJECTED）指标不进生产 linking（loadActiveMetrics 仅取 ACTIVE）；
 * 每次创建/审批/变更/回滚均写 metric_versions 快照，变更留历史、可回溯。
 *
 * P2-14 语义层独立资产（对齐 dbt Semantic Layer 思路）：指标定义升级为
 * 「聚合口径 expr + 归属表 + 固定过滤 + 可切分维度 dimensions」的完整语义资产，
 * 并提供统一指标查询端点（POST /api/metrics/query：按白名单维度生成 GROUP BY 查询并执行），
 * 供问数（prompt 注入）/报表（口径注入）/看板（指标卡直查）三端共享同一权威口径。
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { getPool } from './db';

/** P1-8 治理状态机：PENDING 待审批 → ACTIVE 生效 / REJECTED 驳回；DISABLED 停用 */
export type MetricStatus = 'PENDING' | 'ACTIVE' | 'REJECTED' | 'DISABLED';

export interface MetricDefinition {
  id?: number;
  dataSourceId: string;
  /** 指标名（数据源内唯一），如「有效客户数」 */
  name: string;
  /** 同义词列表，参与问数命中匹配 */
  aliases: string[];
  /** 口径说明（面向人的解释） */
  description: string;
  /** 聚合表达式，如 COUNT(DISTINCT id) / SUM(amount) */
  expr: string;
  /** 归属表名（须与 Schema 表名一致） */
  tableName: string;
  /** 固定过滤条件（WHERE 片段，可为空），如 status = 'active' */
  filters: string;
  /** P2-14 可切分维度白名单（归属表的列名）：统一指标查询允许按这些列 GROUP BY */
  dimensions: string[];
  status: MetricStatus;
  /** 生效版本号（每次审批生效/变更/回滚递增） */
  version?: number;
  approvedBy?: string;
  approvedAt?: string | null;
  createdBy?: string;
}

const MAX_METRICS_PER_DS = 200;

/** 校验并规整指标输入；非法时返回 error 说明（路由层据此 400） */
export function sanitizeMetricInput(input: any): { ok: true; metric: Omit<MetricDefinition, 'id'> } | { ok: false; error: string } {
  const dataSourceId = typeof input?.dataSourceId === 'string' ? input.dataSourceId.trim() : '';
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const expr = typeof input?.expr === 'string' ? input.expr.trim() : '';
  const tableName = typeof input?.tableName === 'string' ? input.tableName.trim() : '';
  const filters = typeof input?.filters === 'string' ? input.filters.trim() : '';
  // P2-14 维度白名单：仅接受合法标识符（防注入），去重，上限 10 个
  const dimensions = Array.isArray(input?.dimensions)
    ? [...new Set(input.dimensions.filter((d: any) => typeof d === 'string').map((d: string) => d.trim()).filter(Boolean))] as string[]
    : [];
  const description = typeof input?.description === 'string' ? input.description.trim().slice(0, 300) : '';
  const aliases = Array.isArray(input?.aliases)
    ? input.aliases.filter((a: any) => typeof a === 'string' && a.trim()).map((a: string) => a.trim().slice(0, 50)).slice(0, 10)
    : [];

  if (!dataSourceId) return { ok: false, error: '缺少 dataSourceId' };
  if (!name || name.length > 50) return { ok: false, error: '指标名必填且不超过 50 字' };
  if (!expr || expr.length > 200) return { ok: false, error: '聚合表达式必填且不超过 200 字' };
  if (/;\s*\S/.test(expr) || /;\s*\S/.test(filters)) return { ok: false, error: '表达式/过滤条件不允许多语句' };
  if (!/^[A-Za-z_][\w]*$/.test(tableName)) return { ok: false, error: '归属表名必须是合法标识符' };
  if (filters.length > 300) return { ok: false, error: '固定过滤条件不超过 300 字' };
  if (aliases.some((a: string) => a === name)) return { ok: false, error: '同义词不能与指标名相同' };
  if (dimensions.length > 10) return { ok: false, error: '可切分维度不超过 10 个' };
  if (dimensions.some((d) => !/^[A-Za-z_][\w]*$/.test(d))) return { ok: false, error: '维度列名必须是合法标识符' };
  if (dimensions.some((d) => d.toLowerCase() === tableName.toLowerCase())) return { ok: false, error: '维度不能与归属表同名' };

  return {
    ok: true,
    // status 输入仅接受 ACTIVE/DISABLED；PENDING/REJECTED 由治理流程驱动，不接受外部直填
    metric: { dataSourceId, name, aliases, description, expr, tableName, filters, dimensions, status: input?.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE' },
  };
}

function normalizeStatus(raw: any): MetricStatus {
  return raw === 'PENDING' || raw === 'REJECTED' || raw === 'DISABLED' ? raw : 'ACTIVE';
}

/** 问题命中匹配：指标名或任一同义词作为子串出现在问题中即命中（确定性、零延迟） */
export function matchMetrics(query: string, metrics: MetricDefinition[]): MetricDefinition[] {
  const q = String(query || '');
  if (!q.trim()) return [];
  return metrics.filter((m) => {
    if (q.includes(m.name)) return true;
    return m.aliases.some((a) => a && q.includes(a));
  });
}

/** 命中指标的模板化 prompt 段：逐条给出口径，强制阶段一遵循；P2-14 列出可切分维度 */
export function buildMetricPrompt(hits: MetricDefinition[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map((m) => {
    const filter = m.filters ? `，固定过滤条件：WHERE ${m.filters}` : '';
    const alias = m.aliases.length > 0 ? `（同义词：${m.aliases.join('、')}）` : '';
    const desc = m.description ? `，口径说明：${m.description}` : '';
    const dims = m.dimensions.length > 0 ? `，可切分维度：${m.dimensions.join('、')}` : '';
    return `- ${m.name}${alias} = ${m.expr}，基于表 ${m.tableName}${filter}${dims}${desc}`;
  });
  return `【语义指标层定义】（管理员登记的权威口径，问题涉及以下指标时必须严格使用给定的聚合表达式、归属表与固定过滤条件，禁止自行变更口径；如需按维度切分，仅可使用登记的可切分维度列）:\n${lines.join('\n')}\n\n`;
}

// ---------- P2-14 统一指标查询（语义层查询接口，报表/看板/问数三端共享） ----------

/** v0.9.21 指标直查金额单位（label 供响应标注，divisor>1 时才换算；与 liveQuery AMOUNT_UNIT_OPTIONS 同源） */
export interface MetricAmountUnit {
  label: string;
  divisor: number;
}

/**
 * 金额类指标关键词（与前端 src/utils/flexQueryBuilder.ts AMOUNT_COL_RE 保持一致，改动需双侧同步）：
 * 指标名/口径说明/表达式任一命中即视为金额类指标
 */
const METRIC_AMOUNT_RE = /(金额|费用|收益|成本|利息|余额|收入|支出|价款|保费)/;

/**
 * 判定指标是否金额类且可换算：关键词命中且非 COUNT 类聚合（计数不随单位缩放，
 * 与灵活查询 v0.5.4「COUNT/COUNT_DISTINCT 不换算」同规则）。
 */
export function isAmountMetric(metric: Pick<MetricDefinition, 'name' | 'description' | 'expr'>): boolean {
  if (/^\s*COUNT\s*\(/i.test(metric.expr)) return false;
  return METRIC_AMOUNT_RE.test(`${metric.name} ${metric.description} ${metric.expr}`);
}

/**
 * 由指标定义生成「按维度切分」的查询 SQL（不执行，纯函数可单测）。
 * 安全不变式：tableName/dimensions 均为 sanitize 校验过的合法标识符；请求维度必须在指标登记的
 * dimensions 白名单内（调用方之外的维度一律拒绝）；filters 为治理审批过的固定片段。
 * v0.9.21：amountUnit 非「元」且指标为金额类时，聚合结果按除数换算（ROUND(expr/divisor, 2)），
 * 别名保持 value 不变（看板固化图表与重放依赖该别名）；unitApplied 标记是否实际换算。
 */
export function buildMetricQuerySql(
  metric: MetricDefinition,
  reqDims: string[],
  limit = 100,
  amountUnit?: MetricAmountUnit
): { ok: true; sql: string; unitApplied: boolean } | { ok: false; error: string } {
  if (metric.status !== 'ACTIVE') return { ok: false, error: '指标未生效，不可查询' };
  const dims = Array.isArray(reqDims) ? reqDims : [];
  for (const d of dims) {
    if (!metric.dimensions.includes(d)) {
      return { ok: false, error: `维度「${d}」不在指标「${metric.name}」的可切分维度白名单内` };
    }
  }
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit) || 100));
  const dimSelect = dims.length > 0 ? `${dims.join(', ')}, ` : '';
  const where = metric.filters ? ` WHERE ${metric.filters}` : '';
  const groupBy = dims.length > 0 ? ` GROUP BY ${dims.join(', ')} ORDER BY \`value\` DESC` : '';
  // 金额单位换算：divisor 来自固定白名单（1/1e4/1e6/1e8），纯数字拼接无注入风险
  const unitApplied = !!amountUnit && amountUnit.divisor > 1 && isAmountMetric(metric);
  const valueExpr = unitApplied ? `ROUND((${metric.expr})/${amountUnit!.divisor}, 2)` : metric.expr;
  const sql = `SELECT ${dimSelect}${valueExpr} AS \`value\` FROM ${metric.tableName}${where}${groupBy} LIMIT ${safeLimit}`;
  return { ok: true, sql, unitApplied };
}

// ---------- CRUD（routes/metrics.ts 调用） ----------

function rowToMetric(r: any): MetricDefinition {
  let aliases: string[];
  try {
    const parsed = JSON.parse(String(r.aliases_json || '[]'));
    aliases = Array.isArray(parsed) ? parsed.filter((a: any) => typeof a === 'string') : [];
  } catch {
    aliases = [];
  }
  let dimensions: string[];
  try {
    const parsed = JSON.parse(String(r.dimensions_json || '[]'));
    dimensions = Array.isArray(parsed) ? parsed.filter((d: any) => typeof d === 'string') : [];
  } catch {
    dimensions = [];
  }
  return {
    id: Number(r.id),
    dataSourceId: String(r.data_source_id),
    name: String(r.name),
    aliases,
    description: String(r.description || ''),
    expr: String(r.expr),
    tableName: String(r.table_name),
    filters: String(r.filters || ''),
    dimensions,
    status: normalizeStatus(r.status),
    version: Number(r.version || 1),
    approvedBy: String(r.approved_by || ''),
    approvedAt: r.approved_at ? String(r.approved_at) : null,
    createdBy: String(r.created_by || ''),
  };
}

export async function listMetrics(dataSourceId: string): Promise<MetricDefinition[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT * FROM metric_definitions WHERE data_source_id = ? ORDER BY created_at DESC, id DESC LIMIT 500',
    [dataSourceId]
  );
  return rows.map(rowToMetric);
}

/** 问数链路专用：仅取启用指标（上限保护，失败由调用方 catch 降级） */
export async function loadActiveMetrics(dataSourceId: string): Promise<MetricDefinition[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT * FROM metric_definitions WHERE data_source_id = ? AND status = 'ACTIVE' ORDER BY id ASC LIMIT ?",
    [dataSourceId, MAX_METRICS_PER_DS]
  );
  return rows.map(rowToMetric);
}

/** 写版本历史快照（创建/审批生效/变更/回滚均调用，变更留历史） */
async function recordVersion(
  metricId: number,
  version: number,
  snapshot: Omit<MetricDefinition, 'id' | 'version' | 'approvedBy' | 'approvedAt'>,
  action: 'CREATE' | 'APPROVE' | 'UPDATE' | 'RESTORE',
  actor: string
): Promise<void> {
  await getPool().query(
    'INSERT INTO metric_versions (metric_id, version, snapshot_json, action, actor) VALUES (?, ?, ?, ?, ?)',
    [metricId, version, JSON.stringify(snapshot), action, actor]
  );
}

/**
 * 创建指标。P1-8 治理：ADMIN 创建直接 ACTIVE（version=1）；
 * 非 ADMIN（分析师）创建为提议，status=PENDING，需 ADMIN 审批后才进生产 linking。
 */
export async function createMetric(
  metric: Omit<MetricDefinition, 'id'>,
  createdBy: string,
  opts?: { autoApprove?: boolean }
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const pool = getPool();
  const [dup] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM metric_definitions WHERE data_source_id = ? AND name = ? LIMIT 1',
    [metric.dataSourceId, metric.name]
  );
  if (dup.length > 0) return { ok: false, error: '同名指标已存在' };
  const autoApprove = opts?.autoApprove === true;
  const status: MetricStatus = autoApprove ? metric.status : 'PENDING';
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO metric_definitions (data_source_id, name, aliases_json, description, expr, table_name, filters, dimensions_json, status, version, approved_by, approved_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      metric.dataSourceId, metric.name, JSON.stringify(metric.aliases), metric.description,
      metric.expr, metric.tableName, metric.filters, JSON.stringify(metric.dimensions || []), status,
      autoApprove ? createdBy : '', autoApprove ? new Date() : null, createdBy,
    ]
  );
  await recordVersion(result.insertId, 1, { ...metric, status }, 'CREATE', createdBy);
  return { ok: true, id: result.insertId };
}

/** 更新指标（ADMIN）。生效口径变更留历史：version+1 并写快照。仅允许更新非待审批指标。 */
export async function updateMetric(id: number, metric: Omit<MetricDefinition, 'id' | 'dataSourceId'>, actor = ''): Promise<{ ok: true } | { ok: false; error: string; notFound?: boolean }> {
  const pool = getPool();
  const [existing] = await pool.query<RowDataPacket[]>('SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', [id]);
  if (existing.length === 0) return { ok: false, error: '指标不存在', notFound: true };
  const cur = rowToMetric(existing[0]);
  if (cur.status === 'PENDING') return { ok: false, error: '待审批指标请先审批或驳回' };
  const [dup] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM metric_definitions WHERE data_source_id = ? AND name = ? AND id <> ? LIMIT 1',
    [cur.dataSourceId, metric.name, id]
  );
  if (dup.length > 0) return { ok: false, error: '同名指标已存在' };
  const nextVersion = (cur.version || 1) + 1;
  await pool.query(
    `UPDATE metric_definitions SET name = ?, aliases_json = ?, description = ?, expr = ?, table_name = ?, filters = ?, dimensions_json = ?, status = ?, version = ? WHERE id = ?`,
    [metric.name, JSON.stringify(metric.aliases), metric.description, metric.expr, metric.tableName, metric.filters, JSON.stringify(metric.dimensions || []), metric.status, nextVersion, id]
  );
  await recordVersion(id, nextVersion, { ...metric, dataSourceId: cur.dataSourceId }, 'UPDATE', actor);
  return { ok: true };
}

export async function deleteMetric(id: number): Promise<boolean> {
  const [result] = await getPool().query<ResultSetHeader>('DELETE FROM metric_definitions WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

// ---------- P1-8 治理：审批 / 驳回 / 版本历史 / 回溯 ----------

/** 按 ID 取指标定义（P2-14 统一查询端点与治理流程共用） */
export async function findMetricById(id: number): Promise<MetricDefinition | null> {
  const [rows] = await getPool().query<RowDataPacket[]>('SELECT * FROM metric_definitions WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0 ? rowToMetric(rows[0]) : null;
}

/** ADMIN 审批通过：PENDING → ACTIVE，记录审批人与时间，版本快照入历史 */
export async function approveMetric(id: number, actor: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const cur = await findMetricById(id);
  if (!cur) return { ok: false, status: 404, error: '指标不存在' };
  if (cur.status !== 'PENDING') return { ok: false, status: 400, error: '该指标不在待审批状态' };
  await getPool().query(
    "UPDATE metric_definitions SET status = 'ACTIVE', approved_by = ?, approved_at = NOW() WHERE id = ?",
    [actor, id]
  );
  const snapshot = { ...cur, status: 'ACTIVE' as MetricStatus };
  delete (snapshot as any).id; delete (snapshot as any).version; delete (snapshot as any).approvedBy; delete (snapshot as any).approvedAt;
  await recordVersion(id, cur.version || 1, snapshot, 'APPROVE', actor);
  return { ok: true };
}

/** ADMIN 驳回：PENDING → REJECTED（不进生产 linking，提议人可修改后重新提议） */
export async function rejectMetric(id: number, actor: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const cur = await findMetricById(id);
  if (!cur) return { ok: false, status: 404, error: '指标不存在' };
  if (cur.status !== 'PENDING') return { ok: false, status: 400, error: '该指标不在待审批状态' };
  await getPool().query("UPDATE metric_definitions SET status = 'REJECTED' WHERE id = ?", [id]);
  return { ok: true };
}

/** 被驳回指标重新提议：REJECTED → PENDING（由提议人修改后再次进入审批） */
export async function reproposeMetric(id: number, actor: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const cur = await findMetricById(id);
  if (!cur) return { ok: false, status: 404, error: '指标不存在' };
  if (cur.status !== 'REJECTED') return { ok: false, status: 400, error: '仅被驳回的指标可重新提议' };
  await getPool().query("UPDATE metric_definitions SET status = 'PENDING' WHERE id = ?", [id]);
  return { ok: true };
}

export interface MetricVersionEntry {
  version: number;
  action: string;
  actor: string;
  createdAt: string;
  snapshot: Partial<MetricDefinition>;
}

/** 版本历史列表（新→旧） */
export async function listMetricVersions(id: number): Promise<MetricVersionEntry[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT * FROM metric_versions WHERE metric_id = ? ORDER BY version DESC, id DESC LIMIT 100',
    [id]
  );
  return rows.map((r: any) => {
    let snapshot: Partial<MetricDefinition> = {};
    try { snapshot = JSON.parse(String(r.snapshot_json || '{}')); } catch { /* 忽略坏快照 */ }
    return {
      version: Number(r.version),
      action: String(r.action || ''),
      actor: String(r.actor || ''),
      createdAt: String(r.created_at || ''),
      snapshot,
    };
  });
}

/** 版本回溯：将指定版本快照应用回指标定义，version+1 并记 RESTORE 历史（历史本身不可变） */
export async function restoreMetricVersion(id: number, version: number, actor: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const cur = await findMetricById(id);
  if (!cur) return { ok: false, status: 404, error: '指标不存在' };
  if (cur.status === 'PENDING') return { ok: false, status: 400, error: '待审批指标不可回溯' };
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT * FROM metric_versions WHERE metric_id = ? AND version = ? ORDER BY id DESC LIMIT 1',
    [id, version]
  );
  if (rows.length === 0) return { ok: false, status: 404, error: '版本不存在' };
  let snap: any;
  try { snap = JSON.parse(String(rows[0].snapshot_json || '{}')); } catch { return { ok: false, status: 500, error: '版本快照损坏' }; }
  const cleaned = sanitizeMetricInput({ ...snap, dataSourceId: cur.dataSourceId });
  if (cleaned.ok !== true) return { ok: false, status: 500, error: `版本快照校验失败：${cleaned.error}` };
  // 回溯后若原指标为 ACTIVE 则保持生效；DISABLED 保持停用
  const status: MetricStatus = cur.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED';
  const nextVersion = (cur.version || 1) + 1;
  await getPool().query(
    `UPDATE metric_definitions SET name = ?, aliases_json = ?, description = ?, expr = ?, table_name = ?, filters = ?, dimensions_json = ?, status = ?, version = ? WHERE id = ?`,
    [cleaned.metric.name, JSON.stringify(cleaned.metric.aliases), cleaned.metric.description, cleaned.metric.expr, cleaned.metric.tableName, cleaned.metric.filters, JSON.stringify(cleaned.metric.dimensions || []), status, nextVersion, id]
  );
  await recordVersion(id, nextVersion, { ...cleaned.metric, status }, 'RESTORE', actor);
  return { ok: true };
}
