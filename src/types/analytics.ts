export type DataSourceType = 'mysql' | 'postgresql' | 'csv' | 'json' | 'api' | 'demo';

// ---- Auth & RBAC ----
export type UserRole = 'ADMIN' | 'ANALYST' | 'VIEWER';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
}

export type AppTab = 'query' | 'reports' | 'datasources' | 'dashboard' | 'admin';

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
  scope?: DataScope | null;
  lastSyncedAt: string;
}

export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'donut' | 'radar' | 'scatter' | 'kpi' | 'table';

export interface ChartConfig {
  type: ChartType;
  title: string;
  xAxisKey: string;
  yAxisKeys: string[];
  yAxisNames?: Record<string, string>;
  stacked?: boolean;
  colors?: string[];
  description?: string;
}

export interface QueryResultData {
  columns: string[];
  rows: Record<string, any>[];
  totalCount: number;
  executionTimeMs: number;
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
  /** L7 敏感标记：本次问数被服务端安全策略从 AI 上下文中剔除的敏感列数量（>0 时 UI 展示提示） */
  sensitiveFiltered?: number;
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
  anomalies?: AnomalyItem[];
  anomalyScanTime?: string;
  comments?: ChartComment[];
}

export interface DashboardWidget {
  id: string;
  title: string;
  chartConfig: ChartConfig;
  data: Record<string, any>[];
  colSpan?: 1 | 2 | 3;
  height?: number;
}
