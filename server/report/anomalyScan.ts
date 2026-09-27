/**
 * 服务端异常扫描引擎（v0.9.73）——把「自动异常数据高亮扫描诊断」从纯前端 Z-Score 规则
 * 升级为领域感知的服务端引擎（设计文档：docs/报表异常扫描优化设计20260927.md）：
 *
 *   Step 1 口径校验    四红线 AST 静态检查（R1 快照锁定 / R2 核算版 / R3 去重计数 / R4 财务表），
 *                      违规图表标记「口径存疑」且不参与后续数值异常判定；
 *   Step 2 时序重算    按原 SQL 改写（快照锁定 → 近 N 期范围）重放取数，真实计算环比/同比，
 *                      不再依赖 LLM 给出的 change 字段（消除 D1 漏检）；
 *   Step 3 维度适配    时间维度图表保留 Z-Score + 环比突变；分类维度改用「排名突变 + 占比偏移」
 *                      （重放上一快照期对比，消除头部机构天然离群的 Z-Score 误报 D2）；
 *   Step 4 领域阈值    数据源级 anomaly_thresholds_json 覆盖 + 内置默认语义，
 *                      命中即定级并携带业务归因；
 *   Step 5 LLM 归因    仅 high 异常触发，LLM 不可用时降级为规则模板文案（保证功能可用）。
 *
 * 能力与阈值来源：data_sources.anomaly_capabilities_json / anomaly_thresholds_json
 * （由数据源接入自动化配置 executeAutoConfig 或迁移脚本写入；未配置的数据源仅启用通用检测）。
 *
 * 消费方：
 * - 报表页「重新扫描异常」→ POST /api/report/scan-anomalies（server/routes/report.ts）
 * - 异常巡检 executePatrol（server/anomalyPatrol.ts）——与报表页结果一致（验收标准 5）
 */
// node-sql-parser 是 CJS 包，ESM 下需默认导入后解构（与 sqlExecutor.ts/drill.ts 一致）
import sqlParserPkg from 'node-sql-parser';
import type { AST } from 'node-sql-parser';
import type mysql from 'mysql2/promise';
import { getPool } from '../infra/db';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';
import { executeSafeSql } from '../query/sqlExecutor';
import { loadSchemaContext, isLiveCapableType } from '../query/schemaContext';
import { loadActiveIronRules } from '../query/ironRules';
import { callLLMText } from '../llm/llmClient';
import type { AnomalyItem, SavedReport } from '../../src/types/analytics';

const { Parser } = sqlParserPkg;
const astParser = new Parser();
const SQL_OPT = { database: 'MySQL' };

/** 单次扫描结果上限（防极端报表异常爆炸；超出按严重度截断） */
export const MAX_SCAN_ANOMALIES = 50;
/** LLM 归因超时（超时降级规则模板，不阻塞扫描结果返回） */
export const LLM_ATTRIBUTION_TIMEOUT_MS = 20_000;

// ---------------- 内置领域语义常量（对齐数据资源库四红线与业务阈值；列名不匹配的数据源天然 N/A） ----------------

/** 内置快照列候选（R1；capabilities.timeSeriesRecalc.dateColumn 优先） */
export const BUILTIN_SNAPSHOT_COLUMNS = ['BBRQ', 'SJRQ'];
/** 内置核算版列（R2: BB = '1'） */
export const BUILTIN_VERSION_COLUMNS = ['BB'];
/** 内置项目编号列（R3: COUNT(DISTINCT XMBH)） */
export const BUILTIN_PROJECT_COLUMNS = ['XMBH'];
/** 内置投资收益语义列（R4: 必须查财务宽表） */
export const BUILTIN_FINANCE_METRIC_COLUMNS = ['DNTZSY', 'LZNZSY'];
/** 内置财务宽表名（R4 目标表） */
export const BUILTIN_FINANCE_TABLES = ['fct_jc_financial_stat'];

/** 通用时序默认阈值（可被数据源 anomaly_thresholds_json.timeSeries 覆盖） */
export const DEFAULT_TIME_SERIES_THRESHOLDS = { momPercent: 20, yoyPercent: 30 };
/** 分类维度默认检测参数（可被 capabilities.categoricalDetection 覆盖） */
export const DEFAULT_RANK_CHANGE_THRESHOLD = 3;
export const DEFAULT_SHARE_SHIFT_THRESHOLD = 10;
/** 排名突变命中需该分类具有实质份额（两期任一期占比 ≥ 1%，%）；占比近 0 的长尾分类排名波动不具业务意义 */
export const RANK_CHANGE_MIN_SHARE = 1;

/**
 * 内置领域阈值默认（数据源 anomaly_thresholds_json.metrics 同名覆盖；
 * 仅当 capabilities.domainThresholds.enabled 且指标名在名单内时参与检测）。
 */
export const BUILTIN_METRIC_RULES: Record<string, DomainMetricRule> = {
  长龄化率: { unit: '%', warnAbove: 30, criticalAbove: 40 },
  逾期金额: {
    unit: '万元',
    levels: [
      { maxExclusive: 100, label: '一般', level: 'low' },
      { maxExclusive: 500, label: '较大', level: 'medium' },
      { label: '重大', level: 'high' },
    ],
  },
  逾期率: { unit: '%', criticalAbove: 10 },
  成本回收率: { unit: '%', warnBelow: 50 },
};

/** 内置业务归因文案（命中领域阈值时拼入 reasoning；未匹配到则用通用文案） */
const BUILTIN_ACTION_HINTS: Record<string, Partial<Record<'high' | 'medium' | 'low', string>>> = {
  长龄化率: {
    high: '长龄资产占比已超严重线，需启动专项清收处置并纳入机构考核',
    medium: '长龄化率超关注线，建议跟踪走势并提前部署化解措施',
  },
  逾期金额: {
    high: '单机构逾期金额达重大级，需立即核查资产状况并制定催收方案',
    medium: '逾期金额较大，建议关注该机构回款进度与资产质量',
    low: '存在逾期金额，建议按常规流程跟踪处置',
  },
  逾期率: { high: '逾期率超警戒线，需排查新增逾期来源并收紧投放审核' },
  成本回收率: { medium: '回收率偏低，建议核查处置回款进度与抵押物变现情况' },
};

// ---------------- 类型定义 ----------------

/** 领域指标阈值规则：above/below 单向阈值 + levels 分级制（按 maxExclusive 升序） */
export interface DomainMetricLevel {
  maxExclusive?: number;
  label: string;
  level: 'low' | 'medium' | 'high';
}

export interface DomainMetricRule {
  unit?: string;
  warnAbove?: number;
  criticalAbove?: number;
  warnBelow?: number;
  criticalBelow?: number;
  levels?: DomainMetricLevel[];
}

export interface DomainThresholdsConfig {
  timeSeries?: { momPercent?: number; yoyPercent?: number };
  metrics?: Record<string, DomainMetricRule>;
}

export type CaliberRule = 'missing_snapshot_lock' | 'missing_bb_filter' | 'count_not_distinct' | 'wrong_table_for_finance';

export interface CaliberViolation {
  rule: CaliberRule;
  detail: string;
}

/** 归一化后的能力配置（未配置数据源的通用默认值） */
export interface NormalizedCapabilities {
  timeSeriesRecalc: { enabled: boolean; dateColumn: string; maxPeriods: number };
  categoricalDetection: { enabled: boolean; rankChangeThreshold: number; shareShiftThreshold: number };
  caliberCheck: { enabled: boolean; rules: { snapshotLock: boolean; versionFilter: boolean; distinctCount: boolean } };
  domainThresholds: { enabled: boolean; thresholdNames: string[] };
}

/** SQL 事实收集（AST 遍历产物，口径校验与重算判定共用） */
export interface SqlFacts {
  columns: string[];
  tables: string[];
  countAggrs: { column: string; distinct: boolean }[];
  groupByColumns: string[];
  /** 命中 BB='1' 等值过滤 */
  hasVersionFilter: boolean;
  /** 已用 MAX(...) 子查询锁定的快照列 */
  lockedSnapshotColumns: string[];
}

export interface SeriesPoint {
  period: string;
  value: number;
}

export interface SeriesAnomaly {
  kind: 'mom' | 'yoy' | 'trend';
  direction: 'up' | 'down';
  deviationPercent: number;
  severity: 'high' | 'medium';
  latestPeriod: string;
  latestValue: number;
  compareLabel: string;
  compareValue: number;
  detail: string;
}

export interface CategoricalShift {
  dimValue: string;
  key: string;
  /** 正 = 排名上升（名次数字变小） */
  rankChange: number;
  currentRank: number;
  prevRank: number;
  shareShift: number;
  currentShare: number;
  prevShare: number;
  severity: 'high' | 'medium';
}

export interface ScanAnomaliesOptions {
  reportId: string;
  /** 已加载报表（巡检链路直接传入，省一次查库） */
  report?: SavedReport;
  dataSourceId?: string;
  /** 跳过 LLM 归因（巡检等批量场景减少时延） */
  skipLlm?: boolean;
  /** 跳过服务端 SQL 重放（单测/无执行能力场景，仅静态与本地检测） */
  skipSqlReplay?: boolean;
}

export interface ScanAnomaliesSuccess {
  ok: true;
  anomalies: AnomalyItem[];
  scanTime: string;
  engine: 'server-v2';
  caliberIssueCount: number;
  llmEnriched: boolean;
}

export type ScanAnomaliesOutcome = ScanAnomaliesSuccess | { ok: false; error: string };

// ---------------- AST 工具（node-sql-parser 产物为宽松结构，统一经 asNode 断言访问） ----------------

type AstNode = Record<string, unknown>;

function asNode(v: unknown): AstNode | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AstNode) : null;
}

function nodeStr(n: AstNode | null, key: string): string {
  const v = n ? n[key] : undefined;
  return typeof v === 'string' ? v : '';
}

function astifySelectRoot(sql: string): AstNode | null {
  try {
    const parsed = astParser.astify(sql.replace(/;+\s*$/, ''), SQL_OPT);
    const root = Array.isArray(parsed) ? parsed[0] : parsed;
    const node = asNode(root);
    return node && nodeStr(node, 'type') === 'select' ? node : null;
  } catch {
    return null;
  }
}

function sqlify(root: AstNode): string | null {
  try {
    const out = astParser.sqlify(root as unknown as AST, SQL_OPT);
    return typeof out === 'string' && out.trim() ? out : null;
  } catch {
    return null;
  }
}

function isColRef(node: unknown, column?: string): boolean {
  const n = asNode(node);
  if (!n || nodeStr(n, 'type') !== 'column_ref') return false;
  if (column === undefined) return true;
  return nodeStr(n, 'column').toUpperCase() === column.toUpperCase();
}

/** 子查询节点（{ ast, parentheses }）或直连 select 节点 → 内层 select AST */
function subquerySelect(node: unknown): AstNode | null {
  const n = asNode(node);
  if (!n) return null;
  const inner = asNode(n.ast) ?? (nodeStr(n, 'type') === 'select' ? n : null);
  return inner && nodeStr(inner, 'type') === 'select' ? inner : null;
}

/** 子查询是否为 MAX(<column>) 聚合 */
function subqueryMaxOf(node: unknown, column: string): boolean {
  const sel = subquerySelect(node);
  if (!sel) return false;
  const cols = Array.isArray(sel.columns) ? sel.columns : [];
  for (const c of cols) {
    const entry = asNode(c);
    const expr = entry ? asNode(entry.expr) : null;
    if (!expr || nodeStr(expr, 'type') !== 'aggr_func') continue;
    if (nodeStr(expr, 'name').toUpperCase() !== 'MAX') continue;
    const args = asNode(expr.args);
    const argExpr = args ? asNode(args.expr) : null;
    if (isColRef(argExpr, column)) return true;
  }
  return false;
}

/** 匹配 `col = (SELECT MAX(col) ...)` 快照锁定节点 */
function isSnapshotLockNode(node: unknown, dateColumns: string[]): boolean {
  const n = asNode(node);
  if (!n || nodeStr(n, 'type') !== 'binary_expr' || nodeStr(n, 'operator') !== '=') return false;
  for (const col of dateColumns) {
    if (isColRef(n.left, col) && subqueryMaxOf(n.right, col)) return true;
  }
  return false;
}

/** 递归定位 WHERE 树中的第一个快照锁定节点（返回匹配的列名与节点） */
function findSnapshotLock(where: unknown, dateColumns: string[]): { column: string; node: AstNode } | null {
  const n = asNode(where);
  if (!n) return null;
  if (nodeStr(n, 'type') === 'binary_expr') {
    if (n.operator === 'AND' || n.operator === 'OR') {
      return findSnapshotLock(n.left, dateColumns) ?? findSnapshotLock(n.right, dateColumns);
    }
    for (const col of dateColumns) {
      if (isColRef(n.left, col) && subqueryMaxOf(n.right, col)) return { column: col, node: n };
    }
    return null;
  }
  // 括号包装节点：递归内层表达式
  return findSnapshotLock(n.expr, dateColumns);
}

/** 字面量是否为 1 / '1'（{ type:'number', value:1 } 或 { type:'single_quote_string', value:'1' }） */
function valueIsOne(v: unknown): boolean {
  const n = asNode(v);
  const raw = n && 'value' in n ? n.value : v;
  return typeof raw === 'number' ? raw === 1 : String(raw) === '1';
}

/** WHERE 树中是否存在 target 列 = 1/'1' 的等值过滤（含括号包装节点） */
function whereHasEqualsOne(where: unknown, targetColumn: string): boolean {
  const n = asNode(where);
  if (!n) return false;
  if (nodeStr(n, 'type') === 'binary_expr') {
    const op = nodeStr(n, 'operator').toUpperCase();
    if (op === 'AND' || op === 'OR') {
      return whereHasEqualsOne(n.left, targetColumn) || whereHasEqualsOne(n.right, targetColumn);
    }
    if (op === '=') {
      if (isColRef(n.left, targetColumn) && valueIsOne(n.right)) return true;
      if (isColRef(n.right, targetColumn) && valueIsOne(n.left)) return true;
    }
    return false;
  }
  return whereHasEqualsOne(n.expr, targetColumn);
}

/** 遍历 AST 收集 SQL 事实（列名/表名/COUNT 聚合/GROUP BY/版本过滤/快照锁定） */
export function collectSqlFacts(sql: string): SqlFacts | null {
  const root = astifySelectRoot(sql);
  if (!root) return null;
  const columns = new Set<string>();
  const tables = new Set<string>();
  const countAggrs: SqlFacts['countAggrs'] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 40 || v === null || v === undefined || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    const n = v as AstNode;
    const t = nodeStr(n, 'type');
    if (t === 'column_ref') {
      const c = nodeStr(n, 'column');
      if (c) columns.add(c.toUpperCase());
    } else if (t === 'aggr_func' && nodeStr(n, 'name').toUpperCase() === 'COUNT') {
      const args = asNode(n.args);
      const expr = args ? asNode(args.expr) : null;
      const distinct = String((args ? args.distinct : '') || '').toUpperCase() === 'DISTINCT';
      if (expr && nodeStr(expr, 'type') === 'column_ref') countAggrs.push({ column: nodeStr(expr, 'column').toUpperCase(), distinct });
      else if (expr && nodeStr(expr, 'type') === 'star') countAggrs.push({ column: '*', distinct });
    } else if (typeof n.table === 'string' && 'db' in n) {
      // from/join 表项形态 { db, table, as }（column_ref 无 db 字段，天然排除）
      tables.add(n.table.toLowerCase());
    }
    for (const key of Object.keys(n)) walk(n[key], depth + 1);
  };
  walk(root, 0);

  const groupByColumns: string[] = [];
  const gb = asNode(root.groupby);
  const gbCols = gb && Array.isArray(gb.columns) ? gb.columns : [];
  for (const c of gbCols) {
    const col = asNode(c);
    if (col && nodeStr(col, 'type') === 'column_ref') groupByColumns.push(nodeStr(col, 'column').toUpperCase());
  }

  const dateColumns = BUILTIN_SNAPSHOT_COLUMNS.map((s) => s.toUpperCase());
  const lockedSnapshotColumns: string[] = [];
  for (const col of dateColumns) {
    if (findSnapshotLock(root.where, [col])) lockedSnapshotColumns.push(col);
  }

  const versionColumns = BUILTIN_VERSION_COLUMNS.map((s) => s.toUpperCase());
  const hasVersionFilter = versionColumns.some((col) => whereHasEqualsOne(root.where, col));

  return {
    columns: [...columns],
    tables: [...tables],
    countAggrs,
    groupByColumns,
    hasVersionFilter,
    lockedSnapshotColumns,
  };
}

// ---------------- Step 1：四红线口径校验 ----------------

export interface CaliberCheckOptions {
  snapshotColumns: string[];
  rules: { snapshotLock: boolean; versionFilter: boolean; distinctCount: boolean };
}

export type CaliberCheckResult = { ok: true; violations: CaliberViolation[]; facts: SqlFacts } | { ok: false; reason: string };

/**
 * 四红线口径校验（AST 静态检查，不查库）：
 * - 仅当 SQL 引用了快照列（BBRQ/SJRQ 等）或核算版列（BB）时进入检查（其余表天然 N/A）；
 * - 违规仅标记「口径存疑」不阻断，前端提供重新生成引导。
 */
export function checkCaliber(sql: string, opts: CaliberCheckOptions): CaliberCheckResult {
  const facts = collectSqlFacts(sql);
  if (!facts) return { ok: false, reason: 'SQL 解析失败' };

  const colSet = new Set(facts.columns.map((c) => c.toUpperCase()));
  const snapshotCols = opts.snapshotColumns.map((c) => c.toUpperCase());
  const versionCols = BUILTIN_VERSION_COLUMNS.map((c) => c.toUpperCase());
  const touchesSnapshot = snapshotCols.some((c) => colSet.has(c));
  const touchesVersion = versionCols.some((c) => colSet.has(c));

  const violations: CaliberViolation[] = [];
  if (touchesSnapshot || touchesVersion) {
    // R1 最新快照期锁定（GROUP BY 快照列的序列查询天然合规）
    if (opts.rules.snapshotLock && touchesSnapshot) {
      const groupedBySnapshot = facts.groupByColumns.some((c) => snapshotCols.includes(c));
      if (!groupedBySnapshot && facts.lockedSnapshotColumns.length === 0) {
        violations.push({
          rule: 'missing_snapshot_lock',
          detail: `未使用 MAX(${snapshotCols[0]}) 子查询锁定最新快照期（R1 最新快照期锁定，跨期累加会虚增金额）`,
        });
      }
    }
    // R2 核算版过滤
    if (opts.rules.versionFilter && (touchesVersion || touchesSnapshot) && !facts.hasVersionFilter) {
      violations.push({
        rule: 'missing_bb_filter',
        detail: "缺少 BB='1' 核算版过滤（R2 核算版过滤，分成版数据会虚增总额并失真排名）",
      });
    }
    // R3 项目数去重计数
    if (opts.rules.distinctCount) {
      const projectCols = BUILTIN_PROJECT_COLUMNS.map((c) => c.toUpperCase());
      const hasProjectRef = projectCols.some((c) => colSet.has(c));
      for (const agg of facts.countAggrs) {
        if (agg.distinct) continue;
        const isProjectCount = projectCols.includes(agg.column);
        const isStarWithProject = agg.column === '*' && hasProjectRef && !facts.groupByColumns.some((c) => projectCols.includes(c));
        if (isProjectCount || isStarWithProject) {
          violations.push({
            rule: 'count_not_distinct',
            detail: '项目数统计未使用 COUNT(DISTINCT XMBH)（R3 项目数去重计数，直接计数会因多笔投放重复放大）',
          });
          break;
        }
      }
    }
  }
  // R4 财务指标走财务表（以收益语义字段是否出现为准，跨数据源天然 N/A）
  const financeCols = BUILTIN_FINANCE_METRIC_COLUMNS.map((c) => c.toUpperCase());
  const financeTables = BUILTIN_FINANCE_TABLES.map((c) => c.toLowerCase());
  const usesFinanceMetric = financeCols.some((c) => colSet.has(c));
  const fromFinanceTable = facts.tables.some((t) => financeTables.includes(t));
  if (usesFinanceMetric && !fromFinanceTable) {
    violations.push({
      rule: 'wrong_table_for_finance',
      detail: `投资收益类字段须查询财务宽表 ${BUILTIN_FINANCE_TABLES[0]}（R4 财务指标走财务表，业务表金额为投放口径）`,
    });
  }

  return { ok: true, violations, facts };
}

// ---------------- Step 2：时序重算（快照锁定 → 近 N 期范围） ----------------

const mkColRef = (column: string): AstNode => ({ type: 'column_ref', table: null, column, collate: null });

const mkBinary = (operator: string, left: unknown, right: unknown): AstNode => ({ type: 'binary_expr', operator, left, right });

/** DATE_SUB(<子查询>, INTERVAL N MONTH)（结构对齐 node-sql-parser 解析产物，供 sqlify 回写） */
function mkDateSub(subquery: unknown, months: number): AstNode {
  return {
    type: 'function',
    name: { name: [{ type: 'default', value: 'DATE_SUB' }] },
    args: {
      type: 'expr_list',
      value: [subquery, { type: 'interval', expr: { type: 'number', value: months }, unit: 'month' }],
    },
    over: null,
  };
}

/**
 * WHERE 树替换：命中快照锁定节点时用 make(原节点) 生成新节点内容并原地替换
 * （make 须返回完整的新 binary_expr 属性集合；自底向上、单次替换；含括号包装节点）。
 */
function rewriteWhereLock(where: unknown, dateColumns: string[], make: (matched: AstNode) => AstNode): boolean {
  const n = asNode(where);
  if (!n) return false;
  if (nodeStr(n, 'type') === 'binary_expr') {
    if (n.operator === 'AND' || n.operator === 'OR') {
      if (rewriteWhereLock(n.left, dateColumns, make)) return true;
      return rewriteWhereLock(n.right, dateColumns, make);
    }
    if (isSnapshotLockNode(n, dateColumns)) {
      const replacement = make(n);
      for (const key of Object.keys(n)) delete n[key];
      Object.assign(n, replacement);
      return true;
    }
    return false;
  }
  // 括号包装节点：递归内层表达式
  return rewriteWhereLock(n.expr, dateColumns, make);
}

/**
 * 时序重算 SQL 改写：`<col> = (SELECT MAX(<col>)...)` → `<col> >= DATE_SUB((SELECT MAX(<col>)...), INTERVAL N MONTH)`，
 * 并追加 `SELECT <col>, ...` + `GROUP BY <col>` + `ORDER BY <col>`，得到近 N 期快照序列。
 * 不适用（非单值聚合 / 无快照锁定 / 无 GROUP BY 维度）时返回 null。
 */
export function buildTimeSeriesSql(sql: string, dateColumns: string[], maxPeriods = 12): string | null {
  const root = astifySelectRoot(sql);
  if (!root) return null;
  if (root.groupby) return null; // 分类/已分组 SQL 不适用（分类维度走上一期对比）
  const lock = findSnapshotLock(root.where, dateColumns);
  if (!lock) return null;
  const col = lock.column;
  const replaced = rewriteWhereLock(root.where, [col], (node) =>
    mkBinary('>=', mkColRef(col), mkDateSub(node.right, maxPeriods))
  );
  if (!replaced) return null;

  const cols = Array.isArray(root.columns) ? root.columns : [];
  const hasDateCol = cols.some((c) => {
    const entry = asNode(c);
    return entry ? isColRef(entry.expr, col) : false;
  });
  if (!hasDateCol) root.columns = [{ expr: mkColRef(col), as: null }, ...cols];
  root.groupby = { columns: [mkColRef(col)], modifiers: [null] };
  root.orderby = [{ expr: mkColRef(col), type: null }];
  return sqlify(root);
}

/**
 * 上一快照期 SQL 改写：`<col> = (SELECT MAX(<col>) FROM t WHERE P)` →
 * `<col> = (SELECT MAX(<col>) FROM t WHERE P AND <col> < (SELECT MAX(<col>) FROM t WHERE P))`。
 */
export function buildPrevPeriodSql(sql: string, dateColumns: string[]): string | null {
  const root = astifySelectRoot(sql);
  if (!root) return null;
  const lock = findSnapshotLock(root.where, dateColumns);
  if (!lock) return null;
  const col = lock.column;
  const originalSub = asNode(lock.node.right);
  if (!originalSub) return null;
  const prevSub = JSON.parse(JSON.stringify(originalSub)) as AstNode;
  const innerSub = JSON.parse(JSON.stringify(originalSub)) as AstNode;
  const prevSelect = subquerySelect(prevSub);
  if (!prevSelect) return null;
  const cond = mkBinary('<', mkColRef(col), innerSub);
  const existing = prevSelect.where;
  prevSelect.where = existing ? mkBinary('AND', existing, cond) : cond;
  const replaced = rewriteWhereLock(root.where, [col], (node) => mkBinary('=', node.left, prevSub));
  if (!replaced) return null;
  return sqlify(root);
}

/** 环比/同比百分比（基数为 0 时返回 null 表示不可比） */
export function pctChange(current: number, base: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(base) || base === 0) return null;
  return ((current - base) / Math.abs(base)) * 100;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** 解析快照期字符串（YYYY-MM-DD / YYYY-MM 等），不可解析返回 null */
function parsePeriodDate(period: string): Date | null {
  const d = new Date(period.replace(/\//g, '-'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 找最新期对应的去年同期下标（同月优先；日期不可解析时按序号回退 12 期） */
function findYoYIndex(pts: SeriesPoint[]): number {
  const lastIdx = pts.length - 1;
  const lastDate = parsePeriodDate(pts[lastIdx].period);
  if (lastDate) {
    for (let i = lastIdx - 1; i >= 0; i--) {
      const d = parsePeriodDate(pts[i].period);
      if (!d) continue;
      if (d.getUTCFullYear() === lastDate.getUTCFullYear() - 1 && d.getUTCMonth() === lastDate.getUTCMonth()) return i;
    }
  }
  return lastIdx - 12 >= 0 ? lastIdx - 12 : -1;
}

/**
 * 时序序列判定：|MoM| ≥ 阈值 / |YoY| ≥ 阈值 / 连续 3 期同向 → 趋势异常（优先级 MoM > YoY > 趋势）。
 * 严重度：偏离达阈值 2 倍 → high，否则 medium。
 */
export function detectSeriesAnomalies(points: SeriesPoint[], thresholds: { momPercent: number; yoyPercent: number }): SeriesAnomaly | null {
  const pts = [...points].filter((p) => p.period && Number.isFinite(p.value)).sort((a, b) => a.period.localeCompare(b.period));
  if (pts.length < 2) return null;
  const latest = pts[pts.length - 1];
  const prev = pts[pts.length - 2];

  const mom = pctChange(latest.value, prev.value);
  if (mom !== null && Math.abs(mom) >= thresholds.momPercent) {
    return {
      kind: 'mom',
      direction: mom >= 0 ? 'up' : 'down',
      deviationPercent: round1(mom),
      severity: Math.abs(mom) >= thresholds.momPercent * 2 ? 'high' : 'medium',
      latestPeriod: latest.period,
      latestValue: latest.value,
      compareLabel: `环比上期（${prev.period}）`,
      compareValue: prev.value,
      detail: `环比 ${mom >= 0 ? '+' : ''}${round1(mom)}%（阈值 ±${thresholds.momPercent}%）`,
    };
  }

  if (pts.length >= 3) {
    const yoyIdx = findYoYIndex(pts);
    if (yoyIdx >= 0 && yoyIdx < pts.length - 1) {
      const base = pts[yoyIdx];
      const yoy = pctChange(latest.value, base.value);
      if (yoy !== null && Math.abs(yoy) >= thresholds.yoyPercent) {
        return {
          kind: 'yoy',
          direction: yoy >= 0 ? 'up' : 'down',
          deviationPercent: round1(yoy),
          severity: Math.abs(yoy) >= thresholds.yoyPercent * 2 ? 'high' : 'medium',
          latestPeriod: latest.period,
          latestValue: latest.value,
          compareLabel: `同比（${base.period}）`,
          compareValue: base.value,
          detail: `同比 ${yoy >= 0 ? '+' : ''}${round1(yoy)}%（阈值 ±${thresholds.yoyPercent}%）`,
        };
      }
    }
  }

  if (pts.length >= 3) {
    const [a, b, c] = pts.slice(-3);
    const up = a.value < b.value && b.value < c.value;
    const down = a.value > b.value && b.value > c.value;
    if (up || down) {
      const span = pctChange(c.value, a.value) ?? 0;
      return {
        kind: 'trend',
        direction: up ? 'up' : 'down',
        deviationPercent: round1(span),
        severity: 'medium',
        latestPeriod: latest.period,
        latestValue: latest.value,
        compareLabel: `对比 3 期前（${a.period}）`,
        compareValue: a.value,
        detail: `连续 3 期${up ? '上升' : '下降'}（${a.period} → ${c.period}，累计 ${span >= 0 ? '+' : ''}${round1(span)}%）`,
      };
    }
  }
  return null;
}

// ---------------- Step 3：维度适配检测 ----------------

const TIME_LIKE_PATTERN = /(日期|时间|月份|月度|年度|季度|BBRQ|SJRQ|RQBQ|TJRQ|DATE|MONTH|YEAR|PERIOD)/i;

/** 图表 X 轴是否为时间维度（决定用 Z-Score 还是分类对比） */
export function isTimeDimensionKey(key: string): boolean {
  return !!key && TIME_LIKE_PATTERN.test(key);
}

/** 时间维度图表本地检测命中项（Z-Score 离群 / 相邻环比突变） */
export interface ChartSeriesHit {
  key: string;
  rowIndex: number;
  dimValue: string;
  value: number;
  kind: 'zscore' | 'mom';
  zScore?: number;
  deviationPercent: number;
}

/** 时间维度图表检测：保留 Z-Score（小样本阈值放宽）+ 相邻点环比突变（替代简单百分比波动） */
export function detectChartSeriesAnomalies(
  data: Record<string, unknown>[],
  xKey: string,
  yKeys: string[],
  momPercent: number
): ChartSeriesHit[] {
  const hits: ChartSeriesHit[] = [];
  if (!Array.isArray(data) || data.length < 3) return hits;
  for (const yKey of yKeys) {
    const values = data.map((d) => Number(d[yKey]));
    if (values.some((v) => !Number.isFinite(v))) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const zThreshold = values.length < 10 ? 2.0 : 1.4;
    for (let i = 0; i < data.length; i++) {
      const val = values[i];
      const dimVal = String(data[i][xKey] ?? `节点 ${i + 1}`);
      if (stdDev > 0) {
        const z = (val - mean) / stdDev;
        if (Math.abs(z) >= zThreshold) {
          hits.push({ key: yKey, rowIndex: i, dimValue: dimVal, value: val, kind: 'zscore', zScore: round1(z), deviationPercent: mean !== 0 ? Math.round(((val - mean) / mean) * 100) : 0 });
          continue;
        }
      }
      if (i > 0) {
        const mom = pctChange(val, values[i - 1]);
        if (mom !== null && Math.abs(mom) >= momPercent) {
          hits.push({ key: yKey, rowIndex: i, dimValue: dimVal, value: val, kind: 'mom', deviationPercent: round1(mom) });
        }
      }
    }
  }
  return hits;
}

function toDimMap(rows: Record<string, unknown>[], dimKey: string, valueKey: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const dim = row[dimKey];
    const value = Number(row[valueKey]);
    if (dim === null || dim === undefined || String(dim) === '' || !Number.isFinite(value)) continue;
    map.set(String(dim), value);
  }
  return map;
}

function rankMap(map: Map<string, number>): Map<string, number> {
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const ranks = new Map<string, number>();
  sorted.forEach(([dim], i) => ranks.set(dim, i + 1));
  return ranks;
}

const sumValues = (map: Map<string, number>): number => [...map.values()].reduce((a, b) => a + b, 0);

/**
 * 分类维度对比（本期图表数据 vs 上一快照期重放结果）：
 * 排名突变 |Δrank| ≥ 阈值 或 占比偏移 |Δshare| ≥ 阈值 → 命中（达 2 倍阈值 → high）。
 * 相比 Z-Score，头部机构天然高值不再误报，只有真实位次/份额变化才标记。
 */
export function detectCategoricalShift(
  current: Record<string, unknown>[],
  prev: Record<string, unknown>[],
  dimKey: string,
  valueKeys: string[],
  opts: { rankChangeThreshold: number; shareShiftThreshold: number }
): CategoricalShift[] {
  const out: CategoricalShift[] = [];
  if (!dimKey || !current.length || !prev.length) return out;
  for (const key of valueKeys) {
    const cur = toDimMap(current, dimKey, key);
    const old = toDimMap(prev, dimKey, key);
    if (cur.size < 2 || old.size < 2) continue;
    const curRank = rankMap(cur);
    const oldRank = rankMap(old);
    const curSum = sumValues(cur);
    const oldSum = sumValues(old);
    for (const [dim, curVal] of cur) {
      const prevVal = old.get(dim);
      if (prevVal === undefined) continue;
      const rc = (oldRank.get(dim) ?? 0) - (curRank.get(dim) ?? 0);
      const cs = curSum ? (curVal / curSum) * 100 : 0;
      const ps = oldSum ? (prevVal / oldSum) * 100 : 0;
      const sshift = cs - ps;
      // 长尾守卫：排名突变需有实质份额，否则占比≈0 的分类排位来回跳动只产生噪音
      const rankHit = Math.abs(rc) >= opts.rankChangeThreshold && Math.max(cs, ps) >= RANK_CHANGE_MIN_SHARE;
      if (rankHit || Math.abs(sshift) >= opts.shareShiftThreshold) {
        out.push({
          dimValue: dim,
          key,
          rankChange: rc,
          currentRank: curRank.get(dim) ?? 0,
          prevRank: oldRank.get(dim) ?? 0,
          shareShift: round1(sshift),
          currentShare: round1(cs),
          prevShare: round1(ps),
          severity: Math.abs(rc) >= opts.rankChangeThreshold * 2 || Math.abs(sshift) >= opts.shareShiftThreshold * 2 ? 'high' : 'medium',
        });
      }
    }
  }
  return out;
}

// ---------------- Step 4：领域阈值 ----------------

function parseJsonLoose(raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/** 归一化数据源能力配置（未配置 / 字段缺失时回退通用默认） */
export function normalizeCapabilities(raw: unknown): NormalizedCapabilities {
  const obj = asNode(parseJsonLoose(raw));
  const ts = asNode(obj ? obj.timeSeriesRecalc : null);
  const cat = asNode(obj ? obj.categoricalDetection : null);
  const cal = asNode(obj ? obj.caliberCheck : null);
  const calRules = asNode(cal ? cal.rules : null);
  const dom = asNode(obj ? obj.domainThresholds : null);
  const names: string[] = [];
  const rawNames = dom && Array.isArray(dom.thresholds) ? dom.thresholds : [];
  for (const item of rawNames) {
    if (typeof item === 'string' && item) names.push(item);
    else {
      const n = asNode(item);
      const name = n ? String(n.metric || n.name || '') : '';
      if (name) names.push(name);
    }
  }
  const numOr = (v: unknown, dft: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dft);
  return {
    timeSeriesRecalc: {
      enabled: ts ? ts.enabled !== false : true,
      dateColumn: ts ? String(ts.dateColumn || '') : '',
      maxPeriods: ts ? Math.min(36, Math.max(2, numOr(ts.maxPeriods, 12))) : 12,
    },
    categoricalDetection: {
      enabled: cat ? cat.enabled !== false : true,
      rankChangeThreshold: cat ? Math.max(1, numOr(cat.rankChangeThreshold, DEFAULT_RANK_CHANGE_THRESHOLD)) : DEFAULT_RANK_CHANGE_THRESHOLD,
      shareShiftThreshold: cat ? Math.max(1, numOr(cat.shareShiftThreshold, DEFAULT_SHARE_SHIFT_THRESHOLD)) : DEFAULT_SHARE_SHIFT_THRESHOLD,
    },
    caliberCheck: {
      enabled: cal ? cal.enabled !== false : true,
      rules: {
        snapshotLock: calRules ? calRules.snapshotLock !== false : true,
        versionFilter: calRules ? calRules.versionFilter !== false : true,
        distinctCount: calRules ? calRules.distinctCount !== false : true,
      },
    },
    domainThresholds: {
      enabled: dom ? dom.enabled === true : false,
      thresholdNames: names,
    },
  };
}

/**
 * 领域规则集：domainThresholds 关闭 → 空；
 * 开启时以「名单（capabilities.thresholds + 数据源 thresholds.metrics 键）」为准，
 * 数据源配置覆盖内置同名规则，内置规则补齐名单内未覆盖项。
 */
export function resolveDomainRules(cap: NormalizedCapabilities, thresholds: DomainThresholdsConfig | null): Record<string, DomainMetricRule> {
  if (!cap.domainThresholds.enabled) return {};
  const names = new Set<string>(cap.domainThresholds.thresholdNames);
  const override = (thresholds && thresholds.metrics) || {};
  for (const key of Object.keys(override)) names.add(key);
  const rules: Record<string, DomainMetricRule> = {};
  for (const name of names) {
    const rule = override[name] ?? BUILTIN_METRIC_RULES[name];
    if (rule) rules[name] = rule;
  }
  return rules;
}

/** 指标名匹配（KPI label / 图表标题+字段名 包含规则名即命中） */
export function matchMetricRule(label: string, rules: Record<string, DomainMetricRule>): { name: string; rule: DomainMetricRule } | null {
  for (const name of Object.keys(rules)) {
    if (label.includes(name)) return { name, rule: rules[name] };
  }
  return null;
}

/** 阈值判定：levels 分级优先，其次 above/below 单向阈值（critical 优先于 warn） */
export function evaluateMetricRule(value: number, rule: DomainMetricRule): { severity: 'low' | 'medium' | 'high'; levelLabel: string; thresholdText: string } | null {
  const unit = rule.unit || '';
  if (Array.isArray(rule.levels) && rule.levels.length > 0) {
    const levelText = rule.levels.map((l) => (l.maxExclusive === undefined ? `${l.label}（上限以上）` : `<${l.maxExclusive}${unit} ${l.label}`)).join(' / ');
    for (const level of rule.levels) {
      if (level.maxExclusive === undefined || value < level.maxExclusive) {
        return { severity: level.level, levelLabel: level.label, thresholdText: `分级参考：${levelText}` };
      }
    }
  }
  if (rule.criticalAbove !== undefined && value > rule.criticalAbove) {
    return { severity: 'high', levelLabel: '严重', thresholdText: `阈值 >${rule.criticalAbove}${unit}` };
  }
  if (rule.warnAbove !== undefined && value > rule.warnAbove) {
    return { severity: 'medium', levelLabel: '关注', thresholdText: `阈值 >${rule.warnAbove}${unit}` };
  }
  if (rule.criticalBelow !== undefined && value < rule.criticalBelow) {
    return { severity: 'high', levelLabel: '严重', thresholdText: `阈值 <${rule.criticalBelow}${unit}` };
  }
  if (rule.warnBelow !== undefined && value < rule.warnBelow) {
    return { severity: 'medium', levelLabel: '关注', thresholdText: `阈值 <${rule.warnBelow}${unit}` };
  }
  return null;
}

/** 数值解析：剥离千分位与百分号；含中文单位（亿/万）等不可比格式返回 null */
export function parseNumericValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = String(raw ?? '').trim();
  if (!s || /[亿万千百]/.test(s)) return null;
  const cleaned = s.replace(/[,，%\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ---------------- Step 5：LLM 归因解读（仅 high，失败降级模板） ----------------

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('LLM 归因超时')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

/** 从 LLM 输出中提取 JSON 数组（容忍 markdown 围栏与前后噪声） */
export function parseLlmAttributionPayload(text: string): Map<number, { reasoning: string; action: string }> {
  const result = new Map<number, { reasoning: string; action: string }>();
  const match = String(text || '').match(/\[[\s\S]*\]/);
  if (!match) return result;
  try {
    const arr = JSON.parse(match[0]) as unknown[];
    for (const item of arr) {
      const n = asNode(item);
      if (!n) continue;
      const idx = Number(n.idx);
      if (!Number.isFinite(idx)) continue;
      result.set(idx, { reasoning: String(n.reasoning || '').trim(), action: String(n.action || '').trim() });
    }
  } catch {
    return result;
  }
  return result;
}

/**
 * 对 high 异常生成领域化归因（就地替换 reasoning；口径存疑项与低级别不参与）。
 * LLM 不可用 / 超时 / 输出不可解析 → 返回 false，保留规则模板文案（验收标准 6）。
 */
export async function enrichHighAnomaliesWithLlm(
  anomalies: AnomalyItem[],
  dataSourceName: string,
  dataSourceId: string
): Promise<boolean> {
  const highs = anomalies.filter((a) => a.severity === 'high' && a.category !== 'caliber').slice(0, 10);
  if (highs.length === 0) return false;
  try {
    // 口径上下文：铁律（前 5 条）+ 知识库异常检测条目（如 kb_006 阈值依据，供领域化归因）
    const ironRules = await loadActiveIronRules(dataSourceId).catch(() => []);
    const caliberCtx = ironRules
      .slice(0, 5)
      .map((r) => `- ${r.title}：${String(r.content).slice(0, 120)}`)
      .join('\n');
    const kbCtx = await loadAnomalyKnowledgeContext(dataSourceId);
    const payload = highs.map((a, i) => ({
      idx: i + 1,
      metric: a.metricLabel,
      dimension: a.dimensionValue || '',
      actual: a.actualValue,
      expected: a.expectedValue,
      deviationPercent: a.deviationPercent,
      templateReasoning: a.reasoning,
    }));
    const system =
      '你是不良资产经营领域的数据分析专家。基于给定的异常项与口径规则，输出每个异常的领域化归因与处置建议。' +
      '严格返回 JSON 数组（不要输出其他内容），每项格式：{"idx":序号,"reasoning":"归因（60字内，中文，结合业务）","action":"处置建议（30字内）"}。';
    const user =
      `数据源：${dataSourceName}\n口径规则：\n${caliberCtx || '（无）'}\n` +
      (kbCtx ? `异常检测口径（知识库）：\n${kbCtx}\n` : '') +
      `异常列表：\n${JSON.stringify(payload)}`;
    const text = await withTimeout(callLLMText(system, user), LLM_ATTRIBUTION_TIMEOUT_MS);
    const parsed = parseLlmAttributionPayload(text);
    if (parsed.size === 0) return false;
    let replaced = 0;
    highs.forEach((a, i) => {
      const attr = parsed.get(i + 1);
      if (!attr || !attr.reasoning) return;
      a.reasoning = attr.action ? `${attr.reasoning} 建议：${attr.action}` : attr.reasoning;
      replaced++;
    });
    return replaced > 0;
  } catch (err) {
    logger.warn(`[AnomalyScan] LLM 归因降级为规则模板：${getErrorMessage(err)}`);
    return false;
  }
}

// ---------------- 主流程 ----------------

/** 知识库异常检测口径检索（标题/标签命中「异常」，注入 LLM 归因上下文；失败静默返回空不阻断归因） */
async function loadAnomalyKnowledgeContext(dataSourceId: string): Promise<string> {
  try {
    const [rows] = await getPool().query<mysql.RowDataPacket[]>(
      "SELECT title, content FROM knowledge_base_entries WHERE data_source_id = ? AND (title LIKE '%异常%' OR tags LIKE '%异常检测%') ORDER BY entry_id LIMIT 2",
      [dataSourceId]
    );
    return rows
      .map((r) => `《${String(r.title || '')}》：${String(r.content || '').slice(0, 800)}`)
      .join('\n');
  } catch {
    return '';
  }
}

interface ReportRow extends mysql.RowDataPacket {
  report_id: string;
  data_source_id: string;
  report_data: string;
}

interface DsAnomalyRow extends mysql.RowDataPacket {
  name: string;
  anomaly_capabilities_json: string | null;
  anomaly_thresholds_json: string | null;
}

async function loadReportRow(reportId: string): Promise<{ report: SavedReport; dataSourceId: string } | null> {
  const [rows] = await getPool().query<ReportRow[]>(
    'SELECT report_id, data_source_id, report_data FROM saved_reports WHERE report_id = ? LIMIT 1',
    [reportId]
  );
  const row = rows[0];
  if (!row) return null;
  try {
    const report = JSON.parse(String(row.report_data)) as SavedReport;
    return { report, dataSourceId: String(row.data_source_id || '') };
  } catch {
    return null;
  }
}

async function loadDsAnomalyConfig(dataSourceId: string): Promise<{ name: string; capabilities: unknown; thresholds: unknown } | null> {
  const [rows] = await getPool().query<DsAnomalyRow[]>(
    'SELECT name, anomaly_capabilities_json, anomaly_thresholds_json FROM data_sources WHERE id = ? LIMIT 1',
    [dataSourceId]
  );
  const row = rows[0];
  if (!row) return null;
  return { name: String(row.name || ''), capabilities: row.anomaly_capabilities_json, thresholds: row.anomaly_thresholds_json };
}

function caliberAnomaly(chartIdx: number, title: string, violations: CaliberViolation[]): AnomalyItem {
  return {
    id: `sv2-caliber-${chartIdx}`,
    metricLabel: `${title}（口径存疑）`,
    severity: 'medium',
    type: 'threshold',
    actualValue: 'SQL 口径违规',
    expectedValue: '四红线合规',
    deviationPercent: 0,
    reasoning: `该图表查询未遵循数据口径规范：${violations.map((v) => v.detail).join('；')}。结果可能失真，本项不参与数值异常判定，建议重新生成报表或联系管理员修正口径。`,
    location: 'chart',
    chartTitle: title,
    category: 'caliber',
  };
}

function trendAnomaly(chartIdx: number, chartTitle: string, key: string, a: SeriesAnomaly): AnomalyItem {
  const dirText = a.direction === 'up' ? '突增' : '骤降';
  return {
    id: `sv2-trend-${chartIdx}-${key}`,
    metricLabel: `${chartTitle}（${key}）`,
    severity: a.severity,
    type: a.direction === 'up' ? 'spike' : 'drop',
    actualValue: a.latestValue,
    expectedValue: a.compareValue,
    deviationPercent: a.deviationPercent,
    reasoning: `服务端按原 SQL 重放近 12 期快照重算：【${chartTitle}】最新期 ${a.latestPeriod} 录得 ${a.latestValue}，${a.detail}，识别为${dirText}；${
      a.direction === 'up' ? '需核查是否存在冲量投放或口径变化' : '建议核查投放进度与资产质量变化'
    }。`,
    location: 'chart',
    chartTitle,
    category: 'value',
  };
}

function shiftAnomaly(chartIdx: number, chartTitle: string, s: CategoricalShift): AnomalyItem {
  const rankText = s.rankChange === 0 ? '排名未变' : `排名由第 ${s.prevRank} 位${s.rankChange > 0 ? '升' : '降'}至第 ${s.currentRank} 位`;
  const shareText = Math.abs(s.shareShift) < 0.1
    ? '占比基本持平'
    : `占比 ${s.prevShare}% → ${s.currentShare}%（${s.shareShift >= 0 ? '+' : ''}${s.shareShift}pp）`;
  return {
    id: `sv2-shift-${chartIdx}-${s.key}-${s.dimValue}`,
    metricLabel: `${chartTitle}（${s.key}）`,
    dimensionValue: s.dimValue,
    severity: s.severity,
    type: s.rankChange < 0 ? 'drop' : 'spike',
    actualValue: s.currentShare,
    expectedValue: s.prevShare,
    deviationPercent: s.shareShift,
    reasoning: `服务端重放上一快照期对比：【${s.dimValue}】${rankText}，${shareText}，位次/份额发生${Math.abs(s.rankChange) >= 6 ? '显著' : '明显'}变化，建议核查该维度业务节奏与数据完整性。`,
    location: 'chart',
    chartTitle,
    category: 'value',
  };
}

function thresholdAnomaly(
  location: 'kpi' | 'chart',
  idx: number,
  label: string,
  meta: { ruleName: string; severity: 'low' | 'medium' | 'high'; levelLabel: string; thresholdText: string; value: number; unit: string; dimensionValue?: string; chartTitle?: string }
): AnomalyItem {
  const hint = (BUILTIN_ACTION_HINTS[meta.ruleName] || {})[meta.severity] || '请核查该指标的业务原因';
  const dimText = meta.dimensionValue ? `【${meta.dimensionValue}】` : '';
  return {
    id: `sv2-thr-${location}-${idx}-${meta.ruleName}-${meta.dimensionValue || ''}`,
    metricLabel: label,
    dimensionValue: meta.dimensionValue,
    severity: meta.severity,
    type: 'threshold',
    actualValue: meta.value,
    expectedValue: meta.thresholdText,
    deviationPercent: 0,
    reasoning: `${dimText}【${meta.ruleName}】录得 ${meta.value}${meta.unit}（${meta.levelLabel}，${meta.thresholdText}）：${hint}。`,
    location,
    chartTitle: meta.chartTitle,
    category: 'value',
  };
}

const SEVERITY_WEIGHT: Record<AnomalyItem['severity'], number> = { high: 3, medium: 2, low: 1 };

/** 去重（同 id 保留首个）并按严重度排序 */
function dedupeAndSort(list: AnomalyItem[]): AnomalyItem[] {
  const seen = new Set<string>();
  const out: AnomalyItem[] = [];
  for (const a of list) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
}

/** 重算结果行结构识别：日期键 = 快照列（大小写不敏感）；数值键 = 其余列（最多 3 列） */
function rowsSeriesShape(rows: Record<string, unknown>[], dateColumns: string[]): { dateKey: string; valueKeys: string[] } | null {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]);
  const upper = new Map(keys.map((k) => [k.toUpperCase(), k]));
  let dateKey = '';
  for (const col of dateColumns) {
    const hit = upper.get(col.toUpperCase());
    if (hit) {
      dateKey = hit;
      break;
    }
  }
  if (!dateKey) return null;
  const valueKeys = keys.filter((k) => k !== dateKey).slice(0, 3);
  if (!valueKeys.length) return null;
  return { dateKey, valueKeys };
}

/**
 * 服务端扫描主入口：加载报表与数据源配置 → Step 1~5 → 汇总排序返回。
 * 扫描结果不落库（每次实时计算，避免旧结果与新数据不一致）。
 */
export async function scanReportAnomalies(opts: ScanAnomaliesOptions): Promise<ScanAnomaliesOutcome> {
  const reportId = String(opts.reportId || '').trim();
  let report = opts.report;
  let dataSourceId = String(opts.dataSourceId || '');

  if (!report) {
    if (!reportId) return { ok: false, error: '缺少 reportId' };
    const loaded = await loadReportRow(reportId);
    if (!loaded) return { ok: false, error: '报表不存在' };
    report = loaded.report;
    dataSourceId = dataSourceId || loaded.dataSourceId;
  }
  if (!report || !Array.isArray(report.kpiList) || !Array.isArray(report.charts)) {
    return { ok: false, error: '报表数据不完整（缺少 kpiList/charts）' };
  }
  dataSourceId = dataSourceId || String(report.dataSourceId || '');

  const ds = dataSourceId ? await loadDsAnomalyConfig(dataSourceId).catch(() => null) : null;
  const capabilities = normalizeCapabilities(ds?.capabilities);
  const thresholdsRaw = parseJsonLoose(ds?.thresholds) as DomainThresholdsConfig | null;
  const positiveOr = (v: unknown, dft: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dft);
  const timeThresholds = {
    momPercent: positiveOr(thresholdsRaw?.timeSeries?.momPercent, DEFAULT_TIME_SERIES_THRESHOLDS.momPercent),
    yoyPercent: positiveOr(thresholdsRaw?.timeSeries?.yoyPercent, DEFAULT_TIME_SERIES_THRESHOLDS.yoyPercent),
  };
  const domainRules = resolveDomainRules(capabilities, thresholdsRaw);
  const snapshotColumns = [...new Set([capabilities.timeSeriesRecalc.dateColumn, ...BUILTIN_SNAPSHOT_COLUMNS].filter(Boolean))];

  // 执行上下文（重放取数）：仅数据库型 / 已落物理表的文件型可用
  let execCtx: { schema: Parameters<typeof executeSafeSql>[2]; sensitiveRemoved: string[]; rowFilters: Record<string, string> } | null = null;
  if (!opts.skipSqlReplay && dataSourceId) {
    try {
      const ctx = await loadSchemaContext(dataSourceId, undefined);
      if (isLiveCapableType(ctx.dsType, ctx.fileBacked)) {
        execCtx = { schema: ctx.schema, sensitiveRemoved: ctx.sensitiveRemoved, rowFilters: ctx.rowFilters };
      }
    } catch (err) {
      logger.warn(`[AnomalyScan] 加载执行上下文失败，跳过 SQL 重放：${getErrorMessage(err)}`);
    }
  }

  const anomalies: AnomalyItem[] = [];
  const charts = report.charts;
  const sqls = Array.isArray(report.executedSqls) ? report.executedSqls : [];
  const chartTitleOf = (idx: number): string => String(charts[idx]?.title || `查询 ${idx + 1}`);

  // ---- Step 1：口径校验 ----
  const compliantFacts = new Map<number, SqlFacts>();
  const violatedIdx = new Set<number>();
  for (let i = 0; i < sqls.length; i++) {
    const sql = String(sqls[i] || '').trim();
    if (!sql) continue;
    const res = checkCaliber(sql, { snapshotColumns, rules: capabilities.caliberCheck.rules });
    if (res.ok !== true) continue; // 解析失败：保守跳过重算，不标记违规
    if (res.violations.length === 0) {
      compliantFacts.set(i, res.facts);
    } else if (capabilities.caliberCheck.enabled) {
      violatedIdx.add(i);
      anomalies.push(caliberAnomaly(i, chartTitleOf(i), res.violations));
    } else {
      compliantFacts.set(i, res.facts); // 校验关闭：仅记录事实供重算
    }
  }

  // ---- Step 2 / 3b：服务端重放（并发执行，单条失败静默降级） ----
  const replayTasks: Promise<AnomalyItem[]>[] = [];
  if (execCtx) {
    for (const i of compliantFacts.keys()) {
      const chart = charts[i];
      const sql = String(sqls[i] || '').trim();
      if (!chart || !sql) continue;
      const xKey = String(chart.chartConfig?.xAxisKey || '');
      const yKeys = (Array.isArray(chart.chartConfig?.yAxisKeys) ? chart.chartConfig.yAxisKeys : []).map(String);

      // Step 2：时序重算（单值聚合 SQL）
      if (capabilities.timeSeriesRecalc.enabled) {
        const tsSql = buildTimeSeriesSql(sql, snapshotColumns, capabilities.timeSeriesRecalc.maxPeriods);
        if (tsSql) {
          replayTasks.push(
            (async (): Promise<AnomalyItem[]> => {
              const outcome = await executeSafeSql(dataSourceId, tsSql, execCtx!.schema, execCtx!.sensitiveRemoved, 500, execCtx!.rowFilters, 'chain');
              if (outcome.ok !== true) return [];
              const rows = outcome.result.rows as Record<string, unknown>[];
              const shape = rowsSeriesShape(rows, snapshotColumns);
              if (!shape) return [];
              const out: AnomalyItem[] = [];
              for (const key of shape.valueKeys) {
                const points = rows
                  .map((r) => ({ period: String(r[shape.dateKey] ?? ''), value: Number(r[key]) }))
                  .filter((p) => p.period && Number.isFinite(p.value));
                const hit = detectSeriesAnomalies(points, timeThresholds);
                if (hit) out.push(trendAnomaly(i, chartTitleOf(i), key, hit));
              }
              return out;
            })().catch((err) => {
              logger.warn(`[AnomalyScan] 时序重放失败（chart#${i}）：${getErrorMessage(err)}`);
              return [];
            })
          );
          continue;
        }
      }

      // Step 3b：分类维度上一期对比（有分组维度的 SQL）
      if (capabilities.categoricalDetection.enabled && xKey && !isTimeDimensionKey(xKey) && yKeys.length) {
        const prevSql = buildPrevPeriodSql(sql, snapshotColumns);
        if (prevSql) {
          replayTasks.push(
            (async (): Promise<AnomalyItem[]> => {
              const outcome = await executeSafeSql(dataSourceId, prevSql, execCtx!.schema, execCtx!.sensitiveRemoved, 500, execCtx!.rowFilters, 'chain');
              if (outcome.ok !== true) return [];
              const prevRows = outcome.result.rows as Record<string, unknown>[];
              const shifts = detectCategoricalShift(chart.data || [], prevRows, xKey, yKeys, {
                rankChangeThreshold: capabilities.categoricalDetection.rankChangeThreshold,
                shareShiftThreshold: capabilities.categoricalDetection.shareShiftThreshold,
              });
              return shifts.slice(0, 10).map((s) => shiftAnomaly(i, chartTitleOf(i), s));
            })().catch((err) => {
              logger.warn(`[AnomalyScan] 分类对比重放失败（chart#${i}）：${getErrorMessage(err)}`);
              return [];
            })
          );
        }
      }
    }
  }
  const settled = await Promise.allSettled(replayTasks);
  for (const item of settled) {
    if (item.status === 'fulfilled') anomalies.push(...item.value);
  }

  // ---- Step 3a：时间维度图表本地检测（Z-Score + 环比突变） ----
  for (let i = 0; i < charts.length; i++) {
    if (violatedIdx.has(i)) continue; // 口径存疑的图表不参与数值判定
    const chart = charts[i];
    const xKey = String(chart?.chartConfig?.xAxisKey || '');
    const yKeys = (Array.isArray(chart?.chartConfig?.yAxisKeys) ? chart.chartConfig.yAxisKeys : []).map(String);
    if (!xKey || !yKeys.length || !isTimeDimensionKey(xKey)) continue;
    const data = Array.isArray(chart.data) ? (chart.data as Record<string, unknown>[]) : [];
    const hits = detectChartSeriesAnomalies(data, xKey, yKeys, timeThresholds.momPercent);
    for (const hit of hits.slice(0, 10)) {
      anomalies.push({
        id: `sv2-z-${i}-${hit.key}-${hit.rowIndex}`,
        metricLabel: `${chartTitleOf(i)}（${hit.key}）`,
        dimensionValue: hit.dimValue,
        severity: hit.kind === 'zscore' && Math.abs(hit.zScore ?? 0) >= 2.5 ? 'high' : 'medium',
        type: hit.deviationPercent >= 0 ? 'spike' : 'drop',
        actualValue: hit.value,
        expectedValue: hit.kind === 'zscore' ? '历史均值区间' : '环比平稳区间',
        deviationPercent: hit.deviationPercent,
        zScore: hit.zScore,
        reasoning:
          hit.kind === 'zscore'
            ? `数据维度【${hit.dimValue}】在【${hit.key}】录得 ${hit.value}，偏离历史均值达 ${Math.abs(hit.zScore ?? 0)} 倍标准差（Z-Score）。`
            : `数据维度【${hit.dimValue}】在【${hit.key}】环比变化 ${hit.deviationPercent >= 0 ? '+' : ''}${hit.deviationPercent}%（阈值 ±${timeThresholds.momPercent}%），存在突变。`,
        location: 'chart',
        chartTitle: chartTitleOf(i),
        category: 'value',
      });
    }
  }

  // ---- Step 4：领域阈值叠加 ----
  if (Object.keys(domainRules).length > 0) {
    report.kpiList.forEach((kpi, idx) => {
      const matched = matchMetricRule(String(kpi.label || ''), domainRules);
      if (!matched) return;
      const value = parseNumericValue(kpi.value);
      if (value === null) return;
      const hit = evaluateMetricRule(value, matched.rule);
      if (!hit) return;
      anomalies.push(thresholdAnomaly('kpi', idx, String(kpi.label), { ruleName: matched.name, severity: hit.severity, levelLabel: hit.levelLabel, thresholdText: hit.thresholdText, value, unit: matched.rule.unit || '' }));
    });
    charts.forEach((chart, ci) => {
      const yKeys = (Array.isArray(chart?.chartConfig?.yAxisKeys) ? chart.chartConfig.yAxisKeys : []).map(String);
      const data = Array.isArray(chart?.data) ? (chart.data as Record<string, unknown>[]) : [];
      for (const yKey of yKeys) {
        const matched = matchMetricRule(`${chart.title || ''} ${yKey}`, domainRules);
        if (!matched) continue;
        let emitted = 0;
        for (const row of data) {
          if (emitted >= 20) break;
          const value = parseNumericValue(row[yKey]);
          if (value === null) continue;
          const hit = evaluateMetricRule(value, matched.rule);
          if (!hit) continue;
          const dimValue = String(row[String(chart.chartConfig?.xAxisKey || '')] ?? '');
          anomalies.push(
            thresholdAnomaly('chart', ci, `${chartTitleOf(ci)}（${yKey}）`, {
              ruleName: matched.name,
              severity: hit.severity,
              levelLabel: hit.levelLabel,
              thresholdText: hit.thresholdText,
              value,
              unit: matched.rule.unit || '',
              dimensionValue: dimValue || undefined,
              chartTitle: chartTitleOf(ci),
            })
          );
          emitted++;
        }
      }
    });
  }

  // ---- 汇总 ----
  const finalList = dedupeAndSort(anomalies).slice(0, MAX_SCAN_ANOMALIES);
  let llmEnriched = false;
  if (!opts.skipLlm && finalList.length > 0 && dataSourceId) {
    llmEnriched = await enrichHighAnomaliesWithLlm(finalList, ds?.name || dataSourceId, dataSourceId);
  }

  return {
    ok: true,
    anomalies: finalList,
    scanTime: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    engine: 'server-v2',
    caliberIssueCount: finalList.filter((a) => a.category === 'caliber').length,
    llmEnriched,
  };
}
