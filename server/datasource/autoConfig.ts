/**
 * 数据源自动化配置引擎：新增数据源时自动完成 Schema 分析、能力接入、知识库骨架生成、铁律模板预填。
 * 输出「自动化配置报告」供前端展示，引导管理员完成必须人工确认的配置。
 */

import { analyzeSchema, type SchemaAnalysisResult, summarizeAnalysis } from './schemaAnalyzer';

export interface AnomalyCapabilities {
  timeSeriesRecalc: {
    enabled: boolean;
    dateColumn: string;
    maxPeriods: number;
  };
  categoricalDetection: {
    enabled: boolean;
    rankChangeThreshold: number;
    shareShiftThreshold: number;
  };
  caliberCheck: {
    enabled: boolean;
    rules: {
      snapshotLock: boolean;
      versionFilter: boolean;
      distinctCount: boolean;
    };
  };
  domainThresholds: {
    enabled: boolean;
    thresholds: unknown[];
  };
}

export interface IronRuleTemplate {
  title: string;
  content: string;
  reason: string;
}

export interface KnowledgeEntryTemplate {
  title: string;
  content: string;
  category: string;
  tags: string[];
}

export interface AutoConfigReport {
  dataSourceId: string;
  analysisSummary: string[];
  capabilities: AnomalyCapabilities;
  ironRuleTemplates: IronRuleTemplate[];
  knowledgeEntries: KnowledgeEntryTemplate[];
  suggestions: string[];
}

interface TableLike {
  name: string;
  displayName?: string;
  description?: string;
  rowCount?: number;
  columns?: { name: string; type?: string; description?: string; isPrimaryKey?: boolean }[];
}

/**
 * 根据 Schema 分析结果生成异常检测能力配置。
 */
export function buildCapabilities(analysis: SchemaAnalysisResult): AnomalyCapabilities {
  const hasTimeSeries = analysis.timeSeriesTables.length > 0;
  const hasSnapshot = analysis.snapshotTables.length > 0;
  const hasVersion = analysis.versionFields.length > 0;
  const hasUnique = analysis.uniqueFields.length > 0;

  return {
    timeSeriesRecalc: {
      enabled: hasTimeSeries,
      dateColumn: hasTimeSeries ? analysis.timeSeriesTables[0].dateColumn : '',
      maxPeriods: 12,
    },
    categoricalDetection: {
      enabled: true, // 分类维度检测总是启用（排名突变+占比偏移）
      rankChangeThreshold: 3,
      shareShiftThreshold: 10,
    },
    caliberCheck: {
      enabled: hasSnapshot || hasVersion || hasUnique,
      rules: {
        snapshotLock: hasSnapshot,
        versionFilter: hasVersion,
        distinctCount: hasUnique,
      },
    },
    domainThresholds: {
      enabled: false, // 领域阈值必须人工配置
      thresholds: [],
    },
  };
}

/**
 * 根据 Schema 分析结果生成铁律模板（待管理员确认）。
 */
export function buildIronRuleTemplates(analysis: SchemaAnalysisResult): IronRuleTemplate[] {
  const rules: IronRuleTemplate[] = [];

  // 快照表 → 最新快照锁定
  for (const snap of analysis.snapshotTables) {
    rules.push({
      title: `最新快照锁定-${snap.tableName}`,
      content: `查询 ${snap.tableName} 时必须使用 MAX(${snap.snapshotColumn}) 子查询锁定最新快照期，禁止跨期累加。`,
      reason: `识别到快照表（${snap.evidence}）`,
    });
  }

  // 版本字段 → 版本过滤
  for (const ver of analysis.versionFields) {
    rules.push({
      title: `版本过滤-${ver.tableName}`,
      content: `查询 ${ver.tableName} 时必须添加 WHERE ${ver.suggestedFilter}（过滤正式版本，避免草稿/分成版数据污染统计）。`,
      reason: `识别到版本字段 ${ver.columnName}`,
    });
  }

  // 主键字段 → 去重计数
  for (const uniq of analysis.uniqueFields) {
    if (uniq.fieldType === 'business_key') {
      rules.push({
        title: `去重计数-${uniq.tableName}`,
        content: `统计 ${uniq.tableName} 的记录数时必须使用 COUNT(DISTINCT ${uniq.columnName})，避免同一业务编号重复计数。`,
        reason: `识别到业务编号字段 ${uniq.columnName}`,
      });
    }
  }

  return rules;
}

/**
 * 根据 Schema 分析结果生成知识库骨架条目。
 */
export function buildKnowledgeEntries(
  analysis: SchemaAnalysisResult,
  tables: TableLike[],
  dataSourceName: string,
): KnowledgeEntryTemplate[] {
  const entries: KnowledgeEntryTemplate[] = [];

  // 数据源概览（总是生成）
  const tableList = tables.map((t) => `- ${t.displayName || t.name}（${t.name}，约 ${t.rowCount || '?'} 行）`).join('\n');
  entries.push({
    title: `${dataSourceName}数据源概览`,
    content: `## 数据源概览\n\n本数据源包含 ${tables.length} 张数据表：\n\n${tableList}\n\n**自动生成**：系统根据 Schema 提取结果生成，供问数链路参考。`,
    category: '自动生成',
    tags: ['数据源概览', '自动生成'],
  });

  // 时序表 → 时间维度查询注意事项
  if (analysis.timeSeriesTables.length > 0) {
    const tsTable = analysis.timeSeriesTables[0];
    entries.push({
      title: `${dataSourceName}时间维度查询注意事项`,
      content: `## 时间维度查询注意事项\n\n本数据源包含时序表 ${tsTable.tableName}（日期列：${tsTable.dateColumn}，分区粒度：${tsTable.partitionPattern === 'monthly' ? '月度' : tsTable.partitionPattern === 'daily' ? '日度' : '未知'}）。\n\n**查询建议**：\n- 查询最新数据时，建议使用 MAX(${tsTable.dateColumn}) 子查询锁定最新一期\n- 避免使用日期范围查询代替 MAX 锁定（可能包含多期数据导致重复累计）\n\n**自动生成**：系统根据 Schema 分析结果生成。`,
      category: '自动生成',
      tags: ['时间维度', '自动生成'],
    });
  }

  // 快照表 → 快照口径说明
  if (analysis.snapshotTables.length > 0) {
    const snap = analysis.snapshotTables[0];
    entries.push({
      title: `${dataSourceName}快照口径说明`,
      content: `## 快照表口径说明\n\n本数据源包含快照表 ${snap.tableName}（快照日期列：${snap.snapshotColumn}）。\n\n**快照表特性**：\n- 每期生成静态快照，反映该时点状态\n- 不跨期累加：查询「最新」数据需用 MAX(${snap.snapshotColumn}) 锁定\n- 错误示例：WHERE ${snap.snapshotColumn} >= '2026-01-01'（会包含多期快照，重复累计）\n\n**正确查询方式**：\n\`\`\`sql\nSELECT * FROM ${snap.tableName}\nWHERE ${snap.snapshotColumn} = (SELECT MAX(${snap.snapshotColumn}) FROM ${snap.tableName})\n\`\`\`\n\n**自动生成**：系统根据 Schema 分析结果生成（${snap.evidence}）。`,
      category: '自动生成',
      tags: ['快照口径', '自动生成'],
    });
  }

  // 版本字段 → 版本过滤说明
  if (analysis.versionFields.length > 0) {
    const ver = analysis.versionFields[0];
    entries.push({
      title: `${dataSourceName}版本过滤说明`,
      content: `## 版本过滤说明\n\n本数据源的 ${ver.tableName} 表包含版本字段 ${ver.columnName}。\n\n**版本字段含义**：\n- 不同版本代表数据的不同状态（如草稿/正式/分成）\n- 建议过滤条件：${ver.suggestedFilter}\n\n**注意事项**：\n- 查询时必须添加版本过滤，避免草稿/中间版本数据污染统计结果\n- 具体版本值含义请咨询数据所有者\n\n**自动生成**：系统根据 Schema 分析结果生成。`,
      category: '自动生成',
      tags: ['版本过滤', '自动生成'],
    });
  }

  return entries;
}

/**
 * 生成配置建议（引导管理员完成必须人工确认的部分）。
 */
export function buildSuggestions(analysis: SchemaAnalysisResult): string[] {
  const suggestions: string[] = [];

  if (analysis.amountFields.length > 0) {
    suggestions.push(
      `检测到 ${analysis.amountFields.length} 个金额字段，建议在「系统管理 → 规则治理 → 语义指标」为核心指标配置阈值规则，以获得更精准的异常检测。`,
    );
  }

  if (analysis.snapshotTables.length > 0 || analysis.versionFields.length > 0) {
    suggestions.push('请确认预填的铁律模板（口径规则），确认后立即生效并参与异常扫描的口径校验。');
  }

  if (analysis.timeSeriesTables.length > 0) {
    suggestions.push('时序表已自动启用「时序重算」能力（环比/同比/Z-Score 检测），无需额外配置。');
  }

  return suggestions;
}

/**
 * 执行数据源自动化配置（主入口）。
 * @param dataSourceId 数据源 ID
 * @param dataSourceName 数据源名称
 * @param tables extractDbSchema 返回的表结构数组
 * @returns 自动化配置报告
 */
export function executeAutoConfig(
  dataSourceId: string,
  dataSourceName: string,
  tables: TableLike[],
): AutoConfigReport {
  const analysis = analyzeSchema(tables);
  const capabilities = buildCapabilities(analysis);
  const ironRuleTemplates = buildIronRuleTemplates(analysis);
  const knowledgeEntries = buildKnowledgeEntries(analysis, tables, dataSourceName);
  const suggestions = buildSuggestions(analysis);

  return {
    dataSourceId,
    analysisSummary: summarizeAnalysis(analysis),
    capabilities,
    ironRuleTemplates,
    knowledgeEntries,
    suggestions,
  };
}
