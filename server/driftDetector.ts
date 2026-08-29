/**
 * P3-3 知识库漂移检测：低基数维度列（业务分类等枚举列）取值快照比对。
 * 实库新增/消失取值时产生漂移事件，管理端提醒「知识文档可能过时」（编辑保存后向量重建已自动化，本模块补上「发现机制」）。
 *
 * 设计：
 * - 观察名单 kb_drift_watch（数据源×表×列，values_json 为最近一次取值快照；NULL=尚未建基线）；
 *   名单为空时按 Schema 自动发现（字符串列且排除编号/名称/日期类，COUNT(DISTINCT) ≤ 50 判定低基数）。
 * - 扫描（手动 POST /api/ops/drift/scan 或每日定时）对每列 SELECT DISTINCT 取值与快照比对：
 *   首次仅建基线不产生事件；有差异则写 kb_drift_events 并更新快照；同列已有相同内容的 OPEN 事件不重复告警。
 * - 取值读取走安全执行层（SELECT-only/超时/链路基 scenario），仅读取枚举值元数据、不读事实行。
 */
import { getPool } from './db';
import { executeSafeSql } from './sqlExecutor';

/** 标识符安全校验（表/列名来自名单配置，拼入 SQL 前必须过此校验） */
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** 低基数判定上限：DISTINCT 取值数 ≤ 50 视为枚举维度列 */
export const MAX_ENUM_CARDINALITY = 50;

/** 单列取值快照上限（防爆量；超过则跳过本列本次比对） */
const MAX_ENUM_VALUES = 200;

/** 编号/名称/日期/备注类列名或注释模式——非枚举维度，自动发现时排除 */
const NON_ENUM_RE = /(编号|名称|日期|时间|备注|说明|账号|代码|序号|经办|负责人|电话|地址)|(^|_)(BH|MC|RQ|NR|BM|DM|XH|ID)(_|$)/i;

export interface WatchRow {
  data_source_id: string;
  table_name: string;
  column_name: string;
  values_json: string | null;
}

export interface DriftEventRow {
  id: string;
  data_source_id: string;
  table_name: string;
  column_name: string;
  added: string[];
  removed: string[];
  status: 'OPEN' | 'ACKED';
  detected_at: string;
}

export interface ScanSummary {
  dataSourceId: string;
  watched: number;
  discovered: number;
  scanned: number;
  newEvents: number;
  skippedHighCardinality: number;
  error?: string;
}

/** 取值差异比对（纯函数）：基线为 null 表示尚未建基线 → 不产生事件 */
export function diffValues(baseline: string[] | null, current: string[]): { added: string[]; removed: string[] } | null {
  if (baseline === null) return null;
  const baseSet = new Set(baseline);
  const curSet = new Set(current);
  const added = current.filter((v) => !baseSet.has(v));
  const removed = baseline.filter((v) => !curSet.has(v));
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}

interface SchemaColumnLike {
  name?: string;
  type?: string;
  description?: string;
}

interface SchemaTableLike {
  name?: string;
  columns?: SchemaColumnLike[];
}

/** 自动发现候选枚举列（纯函数）：字符串列且不属于编号/名称/日期类 */
export function discoverEnumColumns(schemaTables: SchemaTableLike[]): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = [];
  for (const t of schemaTables || []) {
    const table = String(t?.name || '');
    if (!IDENT_RE.test(table)) continue;
    for (const c of t?.columns || []) {
      const name = String(c?.name || '');
      const type = String(c?.type || '').toLowerCase();
      const desc = String(c?.description || '');
      if (!IDENT_RE.test(name)) continue;
      if (type !== 'string') continue;
      if (NON_ENUM_RE.test(name) || NON_ENUM_RE.test(desc)) continue;
      out.push({ table, column: name });
    }
  }
  return out;
}

/** 读取某列的全部取值（经安全执行层；超过上限返回 null 表示跳过） */
async function readDistinctValues(dataSourceId: string, table: string, column: string): Promise<string[] | null> {
  const sql = `SELECT DISTINCT \`${column}\` AS v FROM \`${table}\` WHERE \`${column}\` IS NOT NULL LIMIT ${MAX_ENUM_VALUES + 1}`;
  const res = await executeSafeSql(dataSourceId, sql, [{ name: table }], [], undefined, {}, 'chain');
  if (res.ok === false) throw new Error(res.reason);
  const rows = res.result.rows as Array<{ v: unknown }>;
  if (rows.length > MAX_ENUM_VALUES) return null;
  return rows.map((r) => String(r.v));
}

async function countDistinct(dataSourceId: string, table: string, column: string): Promise<number> {
  const sql = `SELECT COUNT(DISTINCT \`${column}\`) AS c FROM \`${table}\``;
  const res = await executeSafeSql(dataSourceId, sql, [{ name: table }], [], undefined, {}, 'chain');
  if (res.ok === false) throw new Error(res.reason);
  return Number((res.result.rows as Array<{ c: unknown }>)[0]?.c || 0);
}

async function loadSchemaTables(dataSourceId: string): Promise<SchemaTableLike[]> {
  const pool = getPool();
  const [rows] = await pool.query(`SELECT schema_json FROM data_sources WHERE id = ?`, [dataSourceId]);
  const raw = (rows as any[])[0]?.schema_json;
  if (!raw) return [];
  const schema = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(schema) ? schema : (schema?.tables || []);
}

/** 登记观察列（幂等）；标识符非法时抛错 */
export async function addWatch(dataSourceId: string, table: string, column: string): Promise<void> {
  if (!IDENT_RE.test(table) || !IDENT_RE.test(column)) throw new Error('表名/列名非法（仅允许字母数字下划线）');
  const pool = getPool();
  await pool.query(
    `INSERT IGNORE INTO kb_drift_watch (data_source_id, table_name, column_name, values_json) VALUES (?, ?, ?, NULL)`,
    [dataSourceId, table, column]
  );
}

export async function removeWatch(dataSourceId: string, table: string, column: string): Promise<number> {
  const pool = getPool();
  const [r] = await pool.query(
    `DELETE FROM kb_drift_watch WHERE data_source_id = ? AND table_name = ? AND column_name = ?`,
    [dataSourceId, table, column]
  );
  return Number((r as any).affectedRows || 0);
}

/** 扫描单个数据源的观察列；名单为空时先自动发现低基数列。 */
export async function scanDataSource(dataSourceId: string): Promise<ScanSummary> {
  const pool = getPool();
  const summary: ScanSummary = { dataSourceId, watched: 0, discovered: 0, scanned: 0, newEvents: 0, skippedHighCardinality: 0 };
  try {
    let [watchRows] = await pool.query(`SELECT * FROM kb_drift_watch WHERE data_source_id = ?`, [dataSourceId]);
    // 名单为空 → 自动发现（仅首次；低基数判定后才入名单）
    if ((watchRows as any[]).length === 0) {
      const candidates = discoverEnumColumns(await loadSchemaTables(dataSourceId));
      for (const c of candidates) {
        try {
          const n = await countDistinct(dataSourceId, c.table, c.column);
          if (n >= 1 && n <= MAX_ENUM_CARDINALITY) {
            await addWatch(dataSourceId, c.table, c.column);
            summary.discovered += 1;
          }
        } catch {
          // 单列探测失败跳过（不阻断其他列）
        }
      }
      [watchRows] = await pool.query(`SELECT * FROM kb_drift_watch WHERE data_source_id = ?`, [dataSourceId]);
    }
    const watches = watchRows as any as WatchRow[];
    summary.watched = watches.length;

    for (const w of watches) {
      let current: string[] | null;
      try {
        current = await readDistinctValues(w.data_source_id, w.table_name, w.column_name);
      } catch {
        continue; // 单列读取失败跳过
      }
      if (current === null) {
        summary.skippedHighCardinality += 1;
        continue;
      }
      const baseline: string[] | null = w.values_json ? (JSON.parse(w.values_json) as string[]) : null;
      const diff = diffValues(baseline, current);
      // 快照落库（含首次建基线）
      await pool.query(
        `UPDATE kb_drift_watch SET values_json = ?, snapshot_at = NOW() WHERE data_source_id = ? AND table_name = ? AND column_name = ?`,
        [JSON.stringify(current), w.data_source_id, w.table_name, w.column_name]
      );
      if (!diff) continue;
      // 同列已有相同内容的 OPEN 事件 → 不重复告警
      const [dup] = await pool.query(
        `SELECT id FROM kb_drift_events
         WHERE data_source_id = ? AND table_name = ? AND column_name = ? AND status = 'OPEN'
           AND added_json <=> ? AND removed_json <=> ? LIMIT 1`,
        [w.data_source_id, w.table_name, w.column_name, JSON.stringify(diff.added), JSON.stringify(diff.removed)]
      );
      if ((dup as any[]).length > 0) continue;
      const id = `drift_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      await pool.query(
        `INSERT INTO kb_drift_events (id, data_source_id, table_name, column_name, added_json, removed_json, status)
         VALUES (?, ?, ?, ?, ?, ?, 'OPEN')`,
        [id, w.data_source_id, w.table_name, w.column_name, JSON.stringify(diff.added), JSON.stringify(diff.removed)]
      );
      summary.newEvents += 1;
    }
  } catch (err: any) {
    summary.error = err?.message || String(err);
  }
  return summary;
}

/** 全量扫描：所有数据库型数据源（逐个容错，单源失败不影响其他） */
export async function scanAllDataSources(): Promise<ScanSummary[]> {
  const pool = getPool();
  const [rows] = await pool.query(`SELECT id FROM data_sources WHERE type IN ('mysql', 'postgres', 'greenplum')`);
  const out: ScanSummary[] = [];
  for (const r of rows as any[]) {
    out.push(await scanDataSource(String(r.id)));
  }
  return out;
}

/** 事件列表（OPEN 优先、按时间倒序） */
export async function listDriftEvents(limit = 100): Promise<{ events: DriftEventRow[]; watched: number }> {
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, data_source_id, table_name, column_name, added_json, removed_json, status,
            DATE_FORMAT(detected_at, '%Y-%m-%d %H:%i:%s') AS detected_at
     FROM kb_drift_events ORDER BY (status = 'OPEN') DESC, detected_at DESC LIMIT ?`,
    [Math.min(500, Math.max(1, limit))]
  );
  const [watchCnt] = await pool.query(`SELECT COUNT(*) AS c FROM kb_drift_watch`);
  const events: DriftEventRow[] = (rows as any[]).map((r) => ({
    id: String(r.id),
    data_source_id: String(r.data_source_id),
    table_name: String(r.table_name),
    column_name: String(r.column_name),
    added: r.added_json ? JSON.parse(r.added_json) : [],
    removed: r.removed_json ? JSON.parse(r.removed_json) : [],
    status: r.status === 'ACKED' ? 'ACKED' : 'OPEN',
    detected_at: String(r.detected_at),
  }));
  return { events, watched: Number((watchCnt as any[])[0]?.c || 0) };
}

export async function ackDriftEvent(id: string): Promise<boolean> {
  if (!/^drift_[A-Za-z0-9_]{6,40}$/.test(id)) return false;
  const pool = getPool();
  const [r] = await pool.query(`UPDATE kb_drift_events SET status = 'ACKED' WHERE id = ? AND status = 'OPEN'`, [id]);
  return Number((r as any).affectedRows || 0) > 0;
}

/** 每日定时扫描（unref 不阻塞进程退出）；启动即不立即跑，等首个周期 */
export function startDriftSweeper(intervalMs: number = Number(process.env.DRIFT_SCAN_INTERVAL_MS) || 24 * 3600 * 1000): void {
  const timer = setInterval(() => {
    void scanAllDataSources().then((summaries) => {
      const total = summaries.reduce((acc, s) => acc + s.newEvents, 0);
      if (total > 0) console.log(`[Drift] 周期扫描发现 ${total} 条新漂移事件`);
    }).catch((e) => console.error('[Drift] 周期扫描失败:', e?.message || e));
  }, intervalMs);
  timer.unref();
}
