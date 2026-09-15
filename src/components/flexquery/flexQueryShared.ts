// P0 拆分：FlexQueryBuilder 上帝组件拆分的共享类型与常量
//（原定义内联在 FlexQueryBuilder.tsx 顶部/组件体内，现由状态 Hook 与三个子组件共同引用）
import { ChartType } from '../../types/analytics';
import { FlexAgg, FlexBuildResult } from '../../utils/flexQueryBuilder';

/** 拖放目标区 */
export type DropZone = 'dimension' | 'measure' | 'filter' | 'having';

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

/** SQL 构建结果（buildFlexQuerySql 判别式联合；未选表时调用方为 null） */
export type FlexBuilt = FlexBuildResult | null;

/** 执行结果集（列名 + 行数据） */
export interface FlexResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** 透视图（两维度行列交叉 + 单指标值，客户端透视不额外查库） */
export interface FlexPivot {
  rowDim: string;
  colDim: string;
  alias: string;
  cols: string[];
  map: Map<string, Record<string, unknown>>;
}
