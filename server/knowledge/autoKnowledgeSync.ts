/**
 * 数据源自动化知识同步（v0.9.83 开箱即用闭环）：
 * 修复「自动初始化的资产」与「问数链路真正消费的资产」之间的割裂，三个闭环：
 *
 * 1) 断点 1 —— 两表割裂：autoConfig 生成的结构化知识条目（knowledge_base_entries）
 *    同步切块 embedding 写入 RAG 检索表（knowledge_base），让自动生成的知识真正被问数检索到；
 * 2) 断点 2 —— Schema 元数据（表名/注释/列名/列注释/角色）按表为单位切块 embedding 入库，
 *    新数据源接入即被语义检索，无需等待管理员手工补录知识；
 * 3) 断点 3 —— 基于真实 Schema 生成 few-shot 样例种子（趋势/排名/快照最新期/版本过滤/
 *    去重计数等语法范式），保障冷启动问数准确率。
 *    （说明：样例库检索 loadFewShotExamples 严格按 data_source_id 过滤，纯通用样例无法被
 *    检索到；故种子按目标数据源的真实表/列生成，接入即可命中。）
 *
 * 全部操作幂等：doc_id 由「前缀 + 数据源 + 标题/表名短哈希」确定性生成，重复执行覆盖更新，
 * 并按前缀清理已不存在的残留文档；样例按（数据源, 问题, 归一化 SQL）去重跳过。
 * embedding 引擎不可用时块照常入库（向量为 NULL），检索自动降级 bigram 词法，不阻断。
 */
import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { getPool } from '../infra/db';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';
import { saveKnowledgeDoc } from './knowledgeBase';
import { analyzeSchema } from '../datasource/schemaAnalyzer';
import { createSqlExample, normalizeSql } from '../query/queryFeedback';
import type { SchemaTable, SchemaColumn } from '../query/schemaTypes';
import type { KnowledgeEntryTemplate } from '../datasource/autoConfig';

/** 确定性 8 位短哈希：同输入恒定，支撑 doc_id 幂等覆盖 */
export function stableHash8(text: string): string {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 8);
}

/** 自动知识条目 → RAG doc_id（前缀固定，供识别与清理；总长 ≤ 64） */
export function autoEntryDocId(dataSourceId: string, title: string): string {
  return `autokb_${String(dataSourceId).slice(0, 40)}_${stableHash8(title)}`;
}

/** Schema 元数据表文档 → RAG doc_id */
export function schemaTableDocId(dataSourceId: string, tableName: string): string {
  return `autosch_${String(dataSourceId).slice(0, 36)}_${stableHash8(tableName)}`;
}

/** 自动条目 doc_id 前缀（按数据源隔离） */
function entryDocPrefix(dataSourceId: string): string {
  return `autokb_${String(dataSourceId).slice(0, 40)}_`;
}

/** Schema 表文档 doc_id 前缀 */
function schemaDocPrefix(dataSourceId: string): string {
  return `autosch_${String(dataSourceId).slice(0, 36)}_`;
}

/** 单数据源 Schema 向量化表数上限：防极宽 Schema 数据源产生百级文档拖慢接入 */
export const MAX_SCHEMA_DOCS = 60;
/** few-shot 样例种子条数上限（few-shot 注入预算内，过多样例反稀释） */
export const MAX_FEWSHOT_SEEDS = 8;

/** 列角色中文标签（主键 > 指标 > 维度） */
function columnRoleLabel(col: SchemaColumn): string {
  if (col.isPrimaryKey) return '主键';
  if (col.isMetric) return '指标';
  if (col.isDimension) return '维度';
  return '';
}

/**
 * 构建单表 Schema 元数据知识文档（纯函数）：
 * 标题含表名与业务名（供检索命中），内容含表说明/业务口径/列清单（列名｜角色｜注释）。
 * 列清单按行铺开，超长时由切块器自然分块（同标题多块，检索侧每文档限 2 块防挤占）。
 * 无列信息的表返回 null（不产生空文档）。
 */
export function buildSchemaTableDoc(
  table: SchemaTable,
  dataSourceName = ''
): { title: string; content: string } | null {
  const tableName = String(table.name || '').trim();
  if (!tableName) return null;
  const columns = (Array.isArray(table.columns) ? table.columns : []).filter((c) => c && c.name);
  if (columns.length === 0) return null;

  const display = String(table.displayName || '').trim();
  const businessName = display && display !== tableName ? display : '';
  const title = `表结构-${tableName}${businessName ? `-${businessName}` : ''}`.slice(0, 200);

  const lines: string[] = [];
  lines.push(`## 数据表 ${tableName}${businessName ? `（${businessName}）` : ''}${dataSourceName ? `｜数据源：${dataSourceName}` : ''}`);
  const desc = String(table.description || '').replace(/\s+/g, ' ').trim();
  if (desc) lines.push(`表说明：${desc.slice(0, 300)}`);
  const note = String(table.businessNote || '').replace(/\s+/g, ' ').trim();
  if (note) lines.push(`业务口径：${note.slice(0, 300)}`);
  if (typeof table.rowCount === 'number' && table.rowCount >= 0) lines.push(`数据规模：约 ${table.rowCount} 行`);
  lines.push(`字段清单（共 ${columns.length} 列，格式「列名｜角色｜说明」）：`);
  for (const c of columns) {
    const role = columnRoleLabel(c);
    const colDesc = String(c.description || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    lines.push(`- ${c.name}${role ? `｜${role}` : ''}${colDesc ? `｜${colDesc}` : ''}`);
  }
  return { title, content: lines.join('\n') };
}

export interface SchemaFewShotSeed {
  question: string;
  sql: string;
}

/**
 * 基于真实 Schema 生成 few-shot 样例种子（纯函数，最多 MAX_FEWSHOT_SEEDS 条）：
 * 全部引用真实表/列（来自 Schema 分析与角色推导），可直接执行；SQL 结构覆盖
 * 趋势分组 / 维度排名 / 快照最新期锁定 / 版本过滤 / 业务编号去重计数 / 基础计数六类范式。
 * 同类范式去重（归一化 SQL 相同仅保留一条）。
 */
export function buildSchemaFewShotExamples(tables: SchemaTable[]): SchemaFewShotSeed[] {
  const clean = tables.filter((t) => t && t.name);
  if (clean.length === 0) return [];
  const analysis = analyzeSchema(clean.map((t) => ({
    name: String(t.name),
    displayName: typeof t.displayName === 'string' ? t.displayName : undefined,
    description: typeof t.description === 'string' ? t.description : undefined,
    columns: (Array.isArray(t.columns) ? t.columns : []).map((c) => ({
      name: String(c.name),
      type: typeof c.type === 'string' ? c.type : undefined,
      description: typeof c.description === 'string' ? c.description : undefined,
      isPrimaryKey: c.isPrimaryKey === true,
    })),
  })));
  const byName = new Map(clean.map((t) => [String(t.name), t]));
  const labelOf = (t: SchemaTable): string => {
    const display = String(t.displayName || '').trim();
    return display && display !== t.name ? display : String(t.name);
  };
  const colsOf = (t: SchemaTable): SchemaColumn[] => (Array.isArray(t.columns) ? t.columns : []);
  const metricColOf = (tableName: string): string | null => {
    const t = byName.get(tableName);
    if (t) {
      const metric = colsOf(t).find((c) => c.isMetric === true);
      if (metric) return String(metric.name);
    }
    const amount = analysis.amountFields.find((a) => a.tableName === tableName);
    return amount ? amount.columnName : null;
  };
  const dimColOf = (tableName: string): string | null => {
    const t = byName.get(tableName);
    if (!t) return null;
    const cols = colsOf(t);
    const dim =
      cols.find((c) => c.isDimension === true && c.type === 'category') ||
      cols.find((c) => c.isDimension === true);
    return dim ? String(dim.name) : null;
  };

  const seeds: SchemaFewShotSeed[] = [];
  const push = (question: string, sql: string) => {
    if (seeds.length >= MAX_FEWSHOT_SEEDS) return;
    const q = String(question || '').trim().slice(0, 500);
    const s = normalizeSql(sql).slice(0, 2000);
    if (!q || !s || !/^select\b/i.test(s)) return;
    if (seeds.some((x) => x.question === q || normalizeSql(x.sql) === s)) return;
    seeds.push({ question: q, sql: s });
  };

  // ① 时序趋势：日期分组 + 指标聚合（最多 2 张时序表；无指标列时退化为记录数趋势）
  for (const ts of analysis.timeSeriesTables.slice(0, 2)) {
    const t = byName.get(ts.tableName);
    if (!t) continue;
    const metric = metricColOf(ts.tableName);
    if (metric) {
      push(
        `${labelOf(t)}按${ts.dateColumn}统计${metric}趋势`,
        `SELECT ${ts.dateColumn}, SUM(${metric}) AS total FROM ${ts.tableName} GROUP BY ${ts.dateColumn} ORDER BY ${ts.dateColumn}`
      );
    } else {
      push(
        `${labelOf(t)}按${ts.dateColumn}统计记录数趋势`,
        `SELECT ${ts.dateColumn}, COUNT(*) AS total FROM ${ts.tableName} GROUP BY ${ts.dateColumn} ORDER BY ${ts.dateColumn}`
      );
    }
  }

  // ② 维度排名：维度分组 + 指标降序（最多 2 张）
  let dimRankCount = 0;
  for (const t of clean) {
    if (dimRankCount >= 2) break;
    const tableName = String(t.name);
    const metric = metricColOf(tableName);
    const dim = dimColOf(tableName);
    if (!metric || !dim) continue;
    push(
      `按${dim}统计${labelOf(t)}的${metric}排名`,
      `SELECT ${dim}, SUM(${metric}) AS total FROM ${tableName} GROUP BY ${dim} ORDER BY total DESC LIMIT 10`
    );
    dimRankCount++;
  }

  // ③ 快照最新期锁定：MAX 子查询（最多 1 条）
  const snap = analysis.snapshotTables[0];
  if (snap && byName.has(snap.tableName)) {
    push(
      `统计${labelOf(byName.get(snap.tableName) as SchemaTable)}最新一期快照的记录数`,
      `SELECT COUNT(*) AS total FROM ${snap.tableName} WHERE ${snap.snapshotColumn} = (SELECT MAX(${snap.snapshotColumn}) FROM ${snap.tableName})`
    );
  }

  // ④ 版本过滤：正式版本条件（最多 1 条）
  const ver = analysis.versionFields[0];
  if (ver && byName.has(ver.tableName)) {
    push(
      `统计${labelOf(byName.get(ver.tableName) as SchemaTable)}正式版本的数据量`,
      `SELECT COUNT(*) AS total FROM ${ver.tableName} WHERE ${ver.suggestedFilter}`
    );
  }

  // ⑤ 业务编号去重计数（最多 1 条）
  const uniq = analysis.uniqueFields.find((u) => u.fieldType === 'business_key');
  if (uniq && byName.has(uniq.tableName)) {
    push(
      `${labelOf(byName.get(uniq.tableName) as SchemaTable)}的${uniq.columnName}去重数量`,
      `SELECT COUNT(DISTINCT ${uniq.columnName}) AS total FROM ${uniq.tableName}`
    );
  }

  // ⑥ 基础计数兜底：样例过少时给首表补一条（避免空样例库）
  if (seeds.length < 3) {
    const t = clean[0];
    push(`${labelOf(t)}共有多少条记录`, `SELECT COUNT(*) AS total FROM ${t.name}`);
  }

  return seeds;
}

export interface RagSyncSummary {
  docs: number;
  chunks: number;
  pruned: number;
}

export interface FewShotSeedSummary {
  seeded: number;
  skipped: number;
}

export interface AutoKnowledgeSyncResult {
  entries: RagSyncSummary;
  schema: RagSyncSummary;
  fewShot: FewShotSeedSummary;
  errors: string[];
}

/** 单文档幂等覆盖写入 RAG 表：先删旧块（同 doc_id）再切块 embedding 入库 */
async function upsertRagDoc(dataSourceId: string, title: string, content: string, actor: string, docId: string): Promise<number> {
  await getPool().query('DELETE FROM knowledge_base WHERE doc_id = ? AND data_source_id = ?', [docId, dataSourceId.slice(0, 64)]);
  const { chunkCount } = await saveKnowledgeDoc(dataSourceId, title, content, actor, docId);
  return chunkCount;
}

/** 清理该前缀下已不存在的文档（条目/表结构变更后的残留；仅在全量同步完成后调用，避免半途误删） */
async function pruneStaleDocs(dataSourceId: string, prefix: string, keepDocIds: Set<string>): Promise<number> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT DISTINCT doc_id FROM knowledge_base WHERE data_source_id = ? AND doc_id LIKE ?',
    [dataSourceId.slice(0, 64), `${prefix}%`]
  );
  let pruned = 0;
  for (const r of rows) {
    const docId = String(r.doc_id || '');
    if (!docId.startsWith(prefix) || keepDocIds.has(docId)) continue;
    await getPool().query('DELETE FROM knowledge_base WHERE doc_id = ?', [docId]);
    pruned++;
  }
  return pruned;
}

/** 断点 1：autoConfig 结构化知识条目 → RAG 向量表（幂等覆盖 + 残留清理） */
export async function syncKnowledgeEntriesToRag(
  dataSourceId: string,
  entries: KnowledgeEntryTemplate[],
  actor: string
): Promise<RagSyncSummary> {
  let chunks = 0;
  const keep = new Set<string>();
  for (const entry of entries) {
    const docId = autoEntryDocId(dataSourceId, entry.title);
    keep.add(docId);
    chunks += await upsertRagDoc(dataSourceId, entry.title, entry.content, actor, docId);
  }
  const pruned = await pruneStaleDocs(dataSourceId, entryDocPrefix(dataSourceId), keep);
  return { docs: keep.size, chunks, pruned };
}

/** 断点 2：Schema 元数据按表切块 embedding 入库（幂等覆盖 + 残留清理；上限 MAX_SCHEMA_DOCS 张表） */
export async function syncSchemaMetadataToRag(
  dataSourceId: string,
  dataSourceName: string,
  tables: SchemaTable[],
  actor: string
): Promise<RagSyncSummary> {
  let chunks = 0;
  let docs = 0;
  const keep = new Set<string>();
  for (const t of tables.slice(0, MAX_SCHEMA_DOCS)) {
    const doc = buildSchemaTableDoc(t, dataSourceName);
    if (!doc) continue;
    const docId = schemaTableDocId(dataSourceId, String(t.name));
    keep.add(docId);
    chunks += await upsertRagDoc(dataSourceId, doc.title, doc.content, actor, docId);
    docs++;
  }
  const pruned = await pruneStaleDocs(dataSourceId, schemaDocPrefix(dataSourceId), keep);
  return { docs, chunks, pruned };
}

/** 断点 3：few-shot 样例种子（幂等：同数据源同问题同归一化 SQL 已存在则跳过） */
export async function seedSchemaFewShotExamples(
  dataSourceId: string,
  tables: SchemaTable[],
  actor: string
): Promise<FewShotSeedSummary> {
  const seeds = buildSchemaFewShotExamples(tables);
  let seeded = 0;
  let skipped = 0;
  for (const s of seeds) {
    const [dup] = await getPool().query<RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM sql_examples WHERE data_source_id = ? AND question = ? AND sql_text = ?',
      [dataSourceId.slice(0, 64), s.question, normalizeSql(s.sql)]
    );
    if (Number(dup[0]?.cnt) > 0) {
      skipped++;
      continue;
    }
    await createSqlExample({ dataSourceId, question: s.question, sql: s.sql }, actor, 'IMPORT');
    seeded++;
  }
  return { seeded, skipped };
}

/**
 * 统一入口：知识条目向量入库 + Schema 向量化 + few-shot 种子（三步各自独立容错，单步失败不阻断其余）。
 * 供数据源接入（persistAutoConfig）与首启向导流水线共用。
 */
export async function runAutoKnowledgeSync(
  dataSourceId: string,
  dataSourceName: string,
  tables: SchemaTable[],
  actor: string,
  knowledgeEntries: KnowledgeEntryTemplate[]
): Promise<AutoKnowledgeSyncResult> {
  const result: AutoKnowledgeSyncResult = {
    entries: { docs: 0, chunks: 0, pruned: 0 },
    schema: { docs: 0, chunks: 0, pruned: 0 },
    fewShot: { seeded: 0, skipped: 0 },
    errors: [],
  };
  try {
    result.entries = await syncKnowledgeEntriesToRag(dataSourceId, knowledgeEntries, actor);
  } catch (err) {
    result.errors.push(`知识条目向量入库失败：${getErrorMessage(err)}`);
  }
  try {
    result.schema = await syncSchemaMetadataToRag(dataSourceId, dataSourceName, tables, actor);
  } catch (err) {
    result.errors.push(`Schema 元数据向量入库失败：${getErrorMessage(err)}`);
  }
  try {
    result.fewShot = await seedSchemaFewShotExamples(dataSourceId, tables, actor);
  } catch (err) {
    result.errors.push(`样例库种子失败：${getErrorMessage(err)}`);
  }
  if (result.errors.length > 0) {
    logger.warn(`[AutoKnowledgeSync] ${dataSourceId} 部分失败：${result.errors.join('；')}`);
  } else {
    logger.info(
      `[AutoKnowledgeSync] ${dataSourceId} 完成：条目 ${result.entries.docs} 篇/${result.entries.chunks} 块、` +
        `表结构 ${result.schema.docs} 篇/${result.schema.chunks} 块、样例种子 ${result.fewShot.seeded} 条`
    );
  }
  return result;
}
