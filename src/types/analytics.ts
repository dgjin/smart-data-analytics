export type DataSourceType = 'mysql' | 'postgresql' | 'greenplum' | 'csv' | 'json' | 'api' | 'demo';

// ---- Auth & RBAC ----
export type UserRole = 'ADMIN' | 'ANALYST' | 'VIEWER';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  /** P2-11 组织维度：所属部门（数据源授权的部门匹配键） */
  department?: string;
  /** 首登/被重置密码后置位：改密前只能进入强制改密页 */
  mustChangePassword?: boolean;
}

export type AppTab = 'query' | 'reports' | 'query-reports' | 'datasources' | 'dashboard' | 'admin' | 'flexquery';

export interface ColumnSchema {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'category';
  description?: string;
  isMetric?: boolean;
  isDimension?: boolean;
  isPrimaryKey?: boolean;
}

export interface TableSchema {
  id: string;
  name: string;
  displayName: string;
  description: string;
  rowCount: number;
  columns: ColumnSchema[];
  /** 表级业务口径说明（管理员登记，注入问数/报表 prompt 约束口径，P2） */
  businessNote?: string;
  /** PostgreSQL/Greenplum 对象类型：TABLE, VIEW, MATERIALIZED_VIEW, FOREIGN_TABLE, SEQUENCE 等 */
  tableType?: 'TABLE' | 'VIEW' | 'MATERIALIZED_VIEW' | 'FOREIGN_TABLE' | 'SEQUENCE' | 'PARTITIONED_TABLE' | 'UNKNOWN';
}

/**
 * 问数范围：管理员圈定允许纳入智能问数的表与字段。
 * tables 为空数组或 scope 为 null = 不限制；columns[tableId] 非空时进一步限制字段。
 */
export interface DataScope {
  tables: string[];
  columns?: Record<string, string[]>;
}

export interface DataSource {
  id: string;
  name: string;
  type: DataSourceType;
  status: 'connected' | 'disconnected' | 'error';
  config: {
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    url?: string;
    fileName?: string;
    fileSize?: string;
  };
  tables: TableSchema[];
  /** 数据自省开关（Vanna intermediate_sql 借鉴）：允许问数链路先执行轻量自省 SQL 确认真实取值 */
  allowIntrospection?: boolean;
  /** 表数量（非管理员不下发 tables 详情时由服务端提供，供 UI 徽标展示） */
  tableCount?: number;
  /** P2-11：当前用户无访问权限时为 true（仅下发 id/name/type 等最小信息，可申请权限） */
  accessDenied?: boolean;
  /** P2-11 访问控制清单（仅 ADMIN 下发）：空/null = 全员可见 */
  acl?: { departments: string[]; userIds: number[] } | null;
  scope?: DataScope | null;
  /** 管理员登记的专业快速问题推荐（优先于通用 Schema 推导的推荐问题） */
  quickQuestions?: string[] | null;
  lastSyncedAt: string;
}

// ============ 业务知识库相关类型 ============

/** 知识条目结构 */
export interface KnowledgeBaseItem {
  id: string;        // 唯一标识符（如 kb_001）
  title: string;     // 标题
  content: string;   // Markdown 格式的完整内容
  tags: string[];    // 标签数组
  category: string;  // 分类
  createdAt?: string; // 创建时间（用于备份版本追踪）
  updatedAt?: string; // 更新时间
}

/** 知识库导出格式（包含元数据和版本信息） */
export interface KnowledgeExportFormat {
  version: string;           // 导出版本号
  exportedAt: string;        // 导出时间戳
  exportBy: string;          // 导出者用户名
  systemVersion: string;     // 系统版本号
  dataResourceInfo: {
    dataSourceId: string;
    dataSourceName: string;
    tables: string[];
    knowledgeCount: number;
  };
  knowledgeBase: KnowledgeBaseItem[];
}

/** 知识库导入请求参数 */
export interface KnowledgeImportRequest {
  file: File;              // JSON 文件对象
  mergeStrategy: 'replace' | 'append' | 'skip'; // 冲突处理策略：替换/追加/跳过
  dryRun?: boolean;        // 是否仅预检不实际导入
}

/** 知识库导入结果 */
export interface KnowledgeImportResult {
  success: boolean;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  errors?: Array<{
    itemId: string;
    message: string;
    severity: 'error' | 'warning';
  }>;
  summary: {
    totalItems: number;
    newItems: number;
    updatedItems: number;
    conflictItems: number;
  };
}

export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'donut' | 'radar' | 'scatter' | 'treemap' | 'heatmap' | 'kpi' | 'table';

export interface ChartConfig {
  type: ChartType;
  title: string;
  xAxisKey: string;
  yAxisKeys: string[];
  yAxisNames?: Record<string, string>;
  /** 维度（X 轴）中文名，用于 tooltip/图例展示 */
  xAxisName?: string;
  stacked?: boolean;
  colors?: string[];
  description?: string;
}

export interface QueryResultData {
  columns: string[];
  rows: Record<string, any>[];
  totalCount: number;
  executionTimeMs: number;
  /** 数据来源：live = 真实数据库执行（双阶段）；simulated = 演示/降级数据 */
  dataProvenance?: 'live' | 'simulated';
  /** 本次回答的专家角色标签（按问题关键词路由：财务/不良/客户/风险/默认金融分析师） */
  expertPersona?: string;
  /** 结果列名 → 中文表头（schema 业务含义 + LLM 聚合别名映射） */
  columnNames?: Record<string, string>;
  generatedSQL?: string;
  thoughtProcess?: string[];
  aiExplanation?: string;
  keyInsights?: string[];
  suggestedQuestions?: string[];
  chartConfig?: ChartConfig;
  kpiMetrics?: {
    label: string;
    value: string | number;
    change?: number;
    trend?: 'up' | 'down' | 'neutral';
    subtext?: string;
  }[];
}

/** M2 计划模式：LLM 预生成的分析计划（不执行，用户批准后携带 planId 提交问数） */
export interface QueryPlanData {
  planId: string;
  understanding: string;
  steps: { type: string; title: string; description: string; sql?: string }[];
  relatedTables: string[];
  complexity: 'simple' | 'multi-step';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  suggestedQuestions?: string[];
  queryResult?: QueryResultData;
  isLoading?: boolean;
  error?: string;
  /** True when the result came from offline fallback data instead of the LLM */
  isFallback?: boolean;
  /** 数据来源标识：live = 真实数据库执行；simulated = 演示/降级数据（UI 徽标） */
  dataProvenance?: 'live' | 'simulated';
  /** L7 敏感标记：本次问数被服务端安全策略从 AI 上下文中剔除的敏感列数量（>0 时 UI 展示提示） */
  sensitiveFiltered?: number;
  /** P2-12 DLP：本次结果被脱敏的敏感数据类型标签（如 ['手机号','身份证']，非空时 UI 展示脱敏徽标） */
  dlpMaskedLabels?: string[];
  /** P1 反馈闭环：本条 assistant 消息对应的用户原始提问（反馈落库用） */
  question?: string;
  /** P1 反馈闭环：用户对本条回答的评价（已提交后置灰按钮） */
  feedback?: 'UP' | 'DOWN';
  /** 歧义澄清：语义理解存在多种可能时由服务端返回，用户点选确认后重新提交 */
  clarification?: {
    question: string;
    options: { label: string; query: string }[];
  };
  /** 拒答：问题与当前数据源无关或超出系统能力，如实反馈（无演示数据托底） */
  refused?: boolean;
  /** P1-6 语义缓存命中：本次结果来自相似问题缓存（附原问题与相似度），用户可一键刷新重查 */
  semanticCache?: { matchedQuestion: string; similarity: number };
  /** M1 推导留痕：本次问数全链路步骤 trace ID（可按需回放查看每个环节） */
  traceId?: string;
  /** M2 计划模式：待批准的分析计划卡片（批准/取消后禁用操作） */
  queryPlan?: QueryPlanData;
  /** 对话归属数据源：历史按源隔离展示，避免不同数据源的对话串源 */
  dataSourceId?: string;
  /** v0.5.0 报告模式：报告消息卡片（点击跳转报告中心查看完整报告） */
  reportCard?: {
    reportId: string;
    title: string;
    summary: string;
    kpiCount: number;
    chartCount: number;
    insightCount: number;
    templateName: string;
  };
}

export interface AnomalyItem {
  id: string;
  metricLabel: string;
  dimensionValue?: string;
  severity: 'high' | 'medium' | 'low';
  type: 'spike' | 'drop' | 'outlier' | 'threshold';
  actualValue: number | string;
  expectedValue: number | string;
  deviationPercent: number;
  zScore?: number;
  reasoning: string;
  location: 'kpi' | 'chart' | 'insight';
  chartTitle?: string;
}

export interface ChartCommentReply {
  id: string;
  userName: string;
  userAvatar?: string;
  userRole?: string;
  content: string;
  createdAt: string;
}

export interface ChartComment {
  id: string;
  reportId: string;
  chartTitle: string;
  dataPointKey?: string;
  metricKey?: string;
  userName: string;
  userRole: string;
  userAvatar?: string;
  content: string;
  createdAt: string;
  isResolved?: boolean;
  replies: ChartCommentReply[];
}

export interface SavedReport {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  dataSourceId: string;
  templateType: 'executive' | 'sales' | 'inventory' | 'marketing' | 'custom';
  insights: {
    title: string;
    type: 'positive' | 'warning' | 'info' | 'critical';
    content: string;
    actionItem?: string;
  }[];
  kpiList: {
    label: string;
    value: string;
    change: string;
    status: 'good' | 'bad' | 'neutral';
    isAnomaly?: boolean;
    anomalyNote?: string;
  }[];
  charts: {
    title: string;
    chartConfig: ChartConfig;
    data: Record<string, any>[];
    commentary: string;
    anomalies?: AnomalyItem[];
    comments?: ChartComment[];
  }[];
  /** P2-2 下钻：各图表对应的原聚合 SQL（与 charts 顺序对齐） */
  executedSqls?: string[];
  anomalies?: AnomalyItem[];
  anomalyScanTime?: string;
  comments?: ChartComment[];
  /** v0.4.8 自主更新：生成时的自定义要求与数据来源，数据变化时按同参数重新生成 */
  customPrompt?: string;
  dataProvenance?: 'live' | 'simulated';
}

export interface DashboardWidget {
  id: string;
  title: string;
  chartConfig: ChartConfig;
  data: Record<string, any>[];
  /** 固化时所在的问数数据源（旧数据可能缺失，消费方需兜底） */
  dataSourceId?: string;
  /** v0.4.8 自主更新：固化时的原聚合 SQL（仅 live 链路），数据变化时重放刷新；缺失则不参与自动更新 */
  sourceSql?: string;
  /** v0.4.8 最近一次自动更新时间（检测到数据变化并重放成功后写入） */
  lastAutoUpdatedAt?: string;
  colSpan?: 1 | 2 | 3;
  height?: number;
}

// v0.5.0 智能问数报告模式：报告模板
export interface ReportTemplate {
  id: number;
  name: string;
  description: string;
  templateContent: string; // JSON 字符串
  isPreset: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt?: string;
}

// v0.5.0 智能问数报告模式：问数报告记录
export interface QueryReport {
  id: number;
  reportId: string;
  userId: number;
  username: string;
  dataSourceId: string;
  question: string;
  templateId: number | null;
  templateName: string;
  reportData: SavedReport; // 复用现有 SavedReport 类型
  createdAt: string;
}
