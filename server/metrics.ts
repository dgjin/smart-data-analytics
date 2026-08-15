/**
 * P1-1 语义指标层：管理员登记结构化业务指标定义（名称/同义词/聚合口径/归属表/固定过滤），
 * 问数阶段一按「问题命中指标名/同义词 → 模板化注入口径」生成 SQL，
 * 保证同一指标全系统口径一致，消除 LLM 每次自由发挥导致的指标漂移。
 * 指标文本仅注入 prompt（不直接拼接 SQL），生成结果仍过安全执行层校验。
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { getPool } from './db';

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
  status: 'ACTIVE' | 'DISABLED';
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

  return {
    ok: true,
    metric: { dataSourceId, name, aliases, description, expr, tableName, filters, status: input?.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE' },
  };
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

/** 命中指标的模板化 prompt 段：逐条给出口径，强制阶段一遵循 */
export function buildMetricPrompt(hits: MetricDefinition[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map((m) => {
    const filter = m.filters ? `，固定过滤条件：WHERE ${m.filters}` : '';
    const alias = m.aliases.length > 0 ? `（同义词：${m.aliases.join('、')}）` : '';
    const desc = m.description ? `，口径说明：${m.description}` : '';
    return `- ${m.name}${alias} = ${m.expr}，基于表 ${m.tableName}${filter}${desc}`;
  });
  return `【语义指标层定义】（管理员登记的权威口径，问题涉及以下指标时必须严格使用给定的聚合表达式、归属表与固定过滤条件，禁止自行变更口径）:\n${lines.join('\n')}\n\n`;
}

// ---------- CRUD（routes/metrics.ts 调用） ----------

function rowToMetric(r: any): MetricDefinition {
  let aliases: string[] = [];
  try {
    const parsed = JSON.parse(String(r.aliases_json || '[]'));
    aliases = Array.isArray(parsed) ? parsed.filter((a: any) => typeof a === 'string') : [];
  } catch {
    aliases = [];
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
    status: r.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
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

export async function createMetric(metric: Omit<MetricDefinition, 'id'>, createdBy: string): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const pool = getPool();
  const [dup] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM metric_definitions WHERE data_source_id = ? AND name = ? LIMIT 1',
    [metric.dataSourceId, metric.name]
  );
  if (dup.length > 0) return { ok: false, error: '同名指标已存在' };
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO metric_definitions (data_source_id, name, aliases_json, description, expr, table_name, filters, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [metric.dataSourceId, metric.name, JSON.stringify(metric.aliases), metric.description, metric.expr, metric.tableName, metric.filters, metric.status, createdBy]
  );
  return { ok: true, id: result.insertId };
}

export async function updateMetric(id: number, metric: Omit<MetricDefinition, 'id' | 'dataSourceId'>): Promise<{ ok: true } | { ok: false; error: string; notFound?: boolean }> {
  const pool = getPool();
  const [existing] = await pool.query<RowDataPacket[]>('SELECT data_source_id FROM metric_definitions WHERE id = ? LIMIT 1', [id]);
  if (existing.length === 0) return { ok: false, error: '指标不存在', notFound: true };
  const dataSourceId = String(existing[0].data_source_id);
  const [dup] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM metric_definitions WHERE data_source_id = ? AND name = ? AND id <> ? LIMIT 1',
    [dataSourceId, metric.name, id]
  );
  if (dup.length > 0) return { ok: false, error: '同名指标已存在' };
  await pool.query(
    `UPDATE metric_definitions SET name = ?, aliases_json = ?, description = ?, expr = ?, table_name = ?, filters = ?, status = ? WHERE id = ?`,
    [metric.name, JSON.stringify(metric.aliases), metric.description, metric.expr, metric.tableName, metric.filters, metric.status, id]
  );
  return { ok: true };
}

export async function deleteMetric(id: number): Promise<boolean> {
  const [result] = await getPool().query<ResultSetHeader>('DELETE FROM metric_definitions WHERE id = ?', [id]);
  return result.affectedRows > 0;
}
