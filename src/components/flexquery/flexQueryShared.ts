// P0 拆分：FlexQueryBuilder 上帝组件拆分的共享类型与常量
//（原定义内联在 FlexQueryBuilder.tsx 顶部/组件体内，现由状态 Hook 与三个子组件共同引用）
import { ChartType } from '../../types/analytics';
import { FlexAgg, FlexBuildResult, FlexDerivedKind, FlexLikeMode, FlexTimeUnit } from '../../utils/flexQueryBuilder';

/** 拖放目标区（v0.9.76：新增语义指标区） */
export type DropZone = 'dimension' | 'measure' | 'filter' | 'having' | 'metric';

/** v0.4.11 字段面板分组可见性（字段较多时按类型过滤，减少滚动） */
export type FieldTab = 'all' | 'dimension' | 'measure';

/** v0.4.15：跨表字段（带来源表标识与 fullName，用于拖拽/命名冲突规避） */
export interface FieldWithTable {
  name: string;
  type: string;
  description?: string;
  table: string;
  fullName: string;
}

/** 支持灵活查询的数据源类型（已落库文件源另行放行） */
export const DB_TYPES = ['mysql', 'postgresql', 'greenplum'];

/** 聚合方式中文标签（v0.4.10 参照 Agile Query：新增去重计数） */
export const AGG_LABELS: Record<FlexAgg, string> = {
  SUM: '求和',
  COUNT: '计数',
  COUNT_DISTINCT: '去重计数',
  AVG: '平均',
  MAX: '最大',
  MIN: '最小',
};

export const CHART_TYPE_OPTIONS: { value: ChartType; label: string }[] = [
  { value: 'bar', label: '柱状图' },
  { value: 'line', label: '折线图' },
  { value: 'area', label: '面积图' },
  { value: 'pie', label: '饼图' },
  { value: 'table', label: '表格' },
];

/** v0.9.75：时间粒度中文标签（粒度下拉与结果列名标注共用） */
export const TIME_UNIT_LABELS: Record<FlexTimeUnit, string> = {
  year: '按年',
  quarter: '按季度',
  month: '按月',
  week: '按周',
  day: '按日',
};

/** v0.9.75：LIKE 匹配模式中文标签（筛选值输入控件） */
export const LIKE_MODE_LABELS: Record<FlexLikeMode, string> = {
  contains: '包含',
  startsWith: '开头是',
  endsWith: '结尾是',
  exact: '精确匹配',
};

/** v0.9.76 P1-7：语义指标选项（GET /api/metrics 投影，仅 ACTIVE） */
export interface MetricOption {
  id: number;
  name: string;
  expr: string;
  tableName: string;
  filters: string;
  description?: string;
}

/** v0.9.76 P1-8：时间衍生列中文标签（编辑器下拉与结果列名标注共用） */
export const DERIVED_LABELS: Record<FlexDerivedKind, string> = {
  yoy: '同比',
  mom: '环比',
  cum: '累计',
  ma: '移动平均',
};

/** SQL 构建结果（buildFlexQuerySql 判别式联合；未选表时调用方为 null） */
export type FlexBuilt = FlexBuildResult | null;

/** 执行结果集（列名 + 行数据；truncated = 服务端按行上限截断，合计行需据此禁用） */
export interface FlexResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated?: boolean;
}

/** 透视图（两维度行列交叉 + 单指标值，客户端透视不额外查库） */
export interface FlexPivot {
  rowDim: string;
  colDim: string;
  alias: string;
  cols: string[];
  map: Map<string, Record<string, unknown>>;
}

/** v0.9.75：列取值探测状态（懒加载缓存：loading/error/ready） */
export type ColumnValuesState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; values: string[]; truncated: boolean };
