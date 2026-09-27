/**
 * Schema 深度分析器：在现有 extractDbSchema 基础上增加数据源特征识别。
 * 识别目标：时序表 / 快照表 / 版本字段 / 主键字段 / 金额字段，供自动化配置引擎使用。
 */

export interface TimeSeriesTableInfo {
  tableName: string;
  dateColumn: string;
  dateColumnType: 'date' | 'datetime' | 'string';
  partitionPattern: 'monthly' | 'daily' | 'unknown';
}

export interface SnapshotTableInfo {
  tableName: string;
  snapshotColumn: string;
  evidence: string;
}

export interface VersionFieldInfo {
  tableName: string;
  columnName: string;
  distinctValues: string[];
  suggestedFilter: string;
}

export interface UniqueFieldInfo {
  tableName: string;
  columnName: string;
  fieldType: 'primary_key' | 'business_key';
}

export interface AmountFieldInfo {
  tableName: string;
  columnName: string;
  suggestedUnit: '元' | '万元' | '亿元';
}

export interface SchemaAnalysisResult {
  timeSeriesTables: TimeSeriesTableInfo[];
  snapshotTables: SnapshotTableInfo[];
  versionFields: VersionFieldInfo[];
  uniqueFields: UniqueFieldInfo[];
  amountFields: AmountFieldInfo[];
}

interface ColumnLike {
  name: string;
  type?: string;
  description?: string;
  isPrimaryKey?: boolean;
}

interface TableLike {
  name: string;
  displayName?: string;
  description?: string;
  columns?: ColumnLike[];
}

/** 日期列名正则：*_rq / *_date / *_month / report_date / stat_date 等 */
const DATE_COLUMN_RE = /(_rq|_date|_month|_day|report_date|stat_date|data_date|bbrq|sjrq)$/i;

/** 快照表名/注释关键词 */
const SNAPSHOT_KEYWORDS = ['snapshot', '_snap', '快照', '月末', '日报', '时点'];

/** 版本字段名正则 */
const VERSION_COLUMN_RE = /^(bb|version|ver|版本)$/i;

/** 主键/业务编号字段名正则 */
const UNIQUE_COLUMN_RE = /(_id|_bh|_no|_code|编号|id)$/i;

/** 金额字段名正则 */
const AMOUNT_COLUMN_RE = /(_je|_amt|_amount|金额|余额|成本|投放|收益|逾期)/i;

/** 从列名/注释推断日期分区粒度 */
function inferPartitionPattern(columnName: string, description: string): 'monthly' | 'daily' | 'unknown' {
  const text = `${columnName} ${description}`.toLowerCase();
  if (/month|月末|月份|月度/.test(text)) return 'monthly';
  if (/day|日报|日期|日度/.test(text)) return 'daily';
  return 'unknown';
}

/** 从注释/样本值推断金额单位 */
function inferAmountUnit(description: string): '元' | '万元' | '亿元' {
  if (/亿元|百亿/.test(description)) return '亿元';
  if (/万元|万/.test(description)) return '万元';
  return '元';
}

/**
 * 对提取的 Schema 进行深度分析，识别数据源特征。
 * @param tables extractDbSchema 返回的表结构数组
 * @returns 分析结果（各类特征清单）
 */
export function analyzeSchema(tables: TableLike[]): SchemaAnalysisResult {
  const result: SchemaAnalysisResult = {
    timeSeriesTables: [],
    snapshotTables: [],
    versionFields: [],
    uniqueFields: [],
    amountFields: [],
  };

  for (const table of tables) {
    const tableName = table.name;
    const tableDesc = `${table.displayName || ''} ${table.description || ''}`;
    const columns = Array.isArray(table.columns) ? table.columns : [];

    // --- 时序表识别 ---
    for (const col of columns) {
      const colName = col.name;
      const colDesc = col.description || '';
      const colType = (col.type || '').toLowerCase();

      // 日期列识别
      if (DATE_COLUMN_RE.test(colName) || ['date', 'datetime', 'timestamp'].includes(colType)) {
        const pattern = inferPartitionPattern(colName, colDesc);
        result.timeSeriesTables.push({
          tableName,
          dateColumn: colName,
          dateColumnType: ['date', 'datetime'].includes(colType) ? (colType as 'date' | 'datetime') : 'string',
          partitionPattern: pattern,
        });

        // 快照表识别（表名/注释含快照语义，且该列为日期）
        const isSnapshot = SNAPSHOT_KEYWORDS.some((kw) => tableName.toLowerCase().includes(kw) || tableDesc.includes(kw));
        if (isSnapshot) {
          result.snapshotTables.push({
            tableName,
            snapshotColumn: colName,
            evidence: `表名/注释含快照语义（${SNAPSHOT_KEYWORDS.find((kw) => tableName.toLowerCase().includes(kw) || tableDesc.includes(kw))}）`,
          });
        }
        break; // 一个表只取第一个日期列
      }
    }

    // --- 版本字段识别 ---
    for (const col of columns) {
      const colName = col.name;
      const colDesc = col.description || '';
      if (VERSION_COLUMN_RE.test(colName) || /版本/.test(colDesc)) {
        // 采样 distinct 值（此处无法真实查询，仅根据注释推断建议过滤条件）
        const suggestedFilter = colName.toLowerCase() === 'bb' ? "BB = '1'" : `${colName} = '1'`;
        result.versionFields.push({
          tableName,
          columnName: colName,
          distinctValues: [], // 需真实查询填充
          suggestedFilter,
        });
      }
    }

    // --- 主键/去重字段识别 ---
    for (const col of columns) {
      const colName = col.name;
      const isPK = col.isPrimaryKey === true;
      const isBusinessKey = UNIQUE_COLUMN_RE.test(colName) && !isPK;
      if (isPK || isBusinessKey) {
        result.uniqueFields.push({
          tableName,
          columnName: colName,
          fieldType: isPK ? 'primary_key' : 'business_key',
        });
      }
    }

    // --- 金额字段识别 ---
    for (const col of columns) {
      const colName = col.name;
      const colDesc = col.description || '';
      const colType = (col.type || '').toLowerCase();
      if (AMOUNT_COLUMN_RE.test(colName) || AMOUNT_COLUMN_RE.test(colDesc)) {
        if (['number', 'decimal', 'float', 'double', 'bigint', 'int'].includes(colType)) {
          result.amountFields.push({
            tableName,
            columnName: colName,
            suggestedUnit: inferAmountUnit(colDesc),
          });
        }
      }
    }
  }

  return result;
}

/**
 * 生成人类可读的分析摘要（供自动化配置报告展示）。
 */
export function summarizeAnalysis(analysis: SchemaAnalysisResult): string[] {
  const lines: string[] = [];
  if (analysis.timeSeriesTables.length > 0) {
    lines.push(`识别到 ${analysis.timeSeriesTables.length} 张时序表（如 ${analysis.timeSeriesTables[0].tableName}）`);
  }
  if (analysis.snapshotTables.length > 0) {
    lines.push(`识别到 ${analysis.snapshotTables.length} 张快照表（如 ${analysis.snapshotTables[0].tableName}）`);
  }
  if (analysis.versionFields.length > 0) {
    lines.push(`识别到 ${analysis.versionFields.length} 个版本字段（如 ${analysis.versionFields[0].columnName}）`);
  }
  if (analysis.uniqueFields.length > 0) {
    lines.push(`识别到 ${analysis.uniqueFields.length} 个主键/业务编号字段`);
  }
  if (analysis.amountFields.length > 0) {
    lines.push(`识别到 ${analysis.amountFields.length} 个金额字段`);
  }
  return lines;
}
