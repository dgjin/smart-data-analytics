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
  { value: 'scatter', label: '散点图' },
  { value: 'pie', label: '饼图' },
  // v0.9.77 P2-14c：KPI 卡片（每个指标一张卡，不要求维度）
  { value: 'kpi', label: 'KPI 卡片' },
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

/** v0.9.77 P2-15：固定报表版本历史条目（GET /api/flex-queries/:id/versions） */
export interface FlexVersionItem {
  version: number;
  /** CREATE / UPDATE / RESTORE */
  action: string;
  actor: string;
  remark: string;
  snapshot: unknown;
  createdAt: string;
}

/** v0.9.77 P2-15：固定报表订阅条目（GET /api/flex-queries/:id/subscriptions） */
export interface FlexSubscriptionItem {
  subscriptionId: string;
  queryId: string;
  userId: number;
  username: string;
  frequencyMinutes: number;
  /** 告警指标结果列名（空 = 仅重跑不告警） */
  alertMetric: string;
  alertOp: string;
  alertThreshold: number;
  /** ACTIVE / PAUSED */
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

/** v0.9.77 P2-15：订阅创建/更新入参 */
export interface FlexSubscriptionPayload {
  frequencyMinutes: number;
  alertMetric: string;
  alertOp: string;
  alertThreshold: number;
}

/** v0.9.77 P2-15：订阅运行历史条目（GET /api/flex-queries/subscriptions/:id/runs） */
export interface FlexSubRunItem {
  /** SUCCESS / ALERT / FAILED */
  status: string;
  rowCount: number;
  alertValue: string;
  message: string;
  durationMs: number;
  runAt: string;
}

/** v0.9.77 P2-16：表数据预览状态（选表后样例 N 行，GET /flex-preview） */
export interface FlexTablePreview {
  loading: boolean;
  error: string | null;
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

/** 主题偏好（system = 跟随系统深浅色） */
export type ThemePreference = 'system' | 'light' | 'dark';

/** 金额单位偏好（与 useAmountUnitStore.AMOUNT_UNITS 口径一致；'' = 跟随「系统管理 → 展示与偏好」全局设置） */
export type UserAmountUnitPreference = '' | '亿元' | '百万元' | '万元' | '元';

/** 个人偏好设置（空值 = 不覆盖全局默认） */
export interface UserPreferences {
  theme: ThemePreference;
  amountUnit: UserAmountUnitPreference;
  /** 默认数据源 id（'' = 不指定） */
  defaultDataSourceId: string;
}

/**
 * v0.9.104 REQ-16：首页用户信息 - 个性化维护数据（昵称/头像/签名 + 偏好设置）。
 * GET/PUT /api/user/personal 往返结构与前端表单状态共用；缺省字段回退 DEFAULT_USER_PERSONAL_INFO。
 */
export interface UserPersonalInfo {
  /** 昵称（空 = 展示账号名） */
  nickname: string;
  /** 头像地址（dataURL / 图片 URL；空 = 默认头像） */
  avatar: string;
  /** 个人签名（空 = 不展示） */
  signature: string;
  preferences: UserPreferences;
}

/** 个性化字段长度上限（前端表单校验与后端 PUT 入参校验共用） */
export const USER_PERSONAL_FIELD_LIMITS = {
  nickname: 30,
  avatar: 500000,
  signature: 100,
  defaultDataSourceId: 64,
} as const;

/** 个性化信息缺省值（未维护或首次获取时返回） */
export const DEFAULT_USER_PERSONAL_INFO: UserPersonalInfo = {
  nickname: '',
  avatar: '',
  signature: '',
  preferences: { theme: 'system', amountUnit: '', defaultDataSourceId: '' },
};

/** 金额单位偏好取值白名单校验 */
export function isUserAmountUnitPreference(v: unknown): v is UserAmountUnitPreference {
  return ['', '亿元', '百万元', '万元', '元'].includes(String(v));
}

/** 主题偏好取值白名单校验 */
export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'system' || v === 'light' || v === 'dark';
}

/**
 * v0.9.104 REQ-16：个性化信息入参校验与归一化（前端提交与后端 PUT 共用）。
 * 仅接受白名单字段，类型/长度/枚举非法时返回明确错误信息；通过时返回补全缺省值的完整结构。
 */
export function normalizeUserPersonalInfo(
  input: unknown,
): { ok: true; value: UserPersonalInfo } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: '个性化信息格式非法：应为对象' };
  }
  const raw = input as Record<string, unknown>;
  const value: UserPersonalInfo = {
    ...DEFAULT_USER_PERSONAL_INFO,
    preferences: { ...DEFAULT_USER_PERSONAL_INFO.preferences },
  };
  if (raw.nickname !== undefined) {
    if (typeof raw.nickname !== 'string') return { ok: false, error: '昵称必须为字符串' };
    const nickname = raw.nickname.trim();
    if (nickname.length > USER_PERSONAL_FIELD_LIMITS.nickname) {
      return { ok: false, error: `昵称过长（不超过 ${USER_PERSONAL_FIELD_LIMITS.nickname} 字）` };
    }
    value.nickname = nickname;
  }
  if (raw.avatar !== undefined) {
    if (typeof raw.avatar !== 'string') return { ok: false, error: '头像必须为字符串' };
    if (raw.avatar.length > USER_PERSONAL_FIELD_LIMITS.avatar) {
      return { ok: false, error: `头像数据过大（不超过 ${USER_PERSONAL_FIELD_LIMITS.avatar} 字节）` };
    }
    value.avatar = raw.avatar;
  }
  if (raw.signature !== undefined) {
    if (typeof raw.signature !== 'string') return { ok: false, error: '个人签名必须为字符串' };
    const signature = raw.signature.trim();
    if (signature.length > USER_PERSONAL_FIELD_LIMITS.signature) {
      return { ok: false, error: `个人签名过长（不超过 ${USER_PERSONAL_FIELD_LIMITS.signature} 字）` };
    }
    value.signature = signature;
  }
  if (raw.preferences !== undefined) {
    if (typeof raw.preferences !== 'object' || raw.preferences === null || Array.isArray(raw.preferences)) {
      return { ok: false, error: '偏好设置格式非法：应为对象' };
    }
    const prefs = raw.preferences as Record<string, unknown>;
    if (prefs.theme !== undefined) {
      const theme = prefs.theme;
      if (!isThemePreference(theme)) {
        return { ok: false, error: '主题仅支持 system / light / dark' };
      }
      value.preferences.theme = theme;
    }
    if (prefs.amountUnit !== undefined) {
      const amountUnit = prefs.amountUnit;
      if (!isUserAmountUnitPreference(amountUnit)) {
        return { ok: false, error: '金额单位仅支持 亿元 / 百万元 / 万元 / 元，或空字符串（跟随全局）' };
      }
      value.preferences.amountUnit = amountUnit;
    }
    if (prefs.defaultDataSourceId !== undefined) {
      if (typeof prefs.defaultDataSourceId !== 'string') {
        return { ok: false, error: '默认数据源 id 必须为字符串' };
      }
      const id = prefs.defaultDataSourceId.trim();
      if (id.length > USER_PERSONAL_FIELD_LIMITS.defaultDataSourceId) {
        return { ok: false, error: `默认数据源 id 过长（不超过 ${USER_PERSONAL_FIELD_LIMITS.defaultDataSourceId} 字）` };
      }
      value.preferences.defaultDataSourceId = id;
    }
  }
  return { ok: true, value };
}
