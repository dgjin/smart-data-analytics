/**
 * v0.9.24 默认看板图表种子数据（服务端权威源）。
 * 首次启动时 dashboard_widgets 表为空则插入，user_id=0 / username='system' 表示出厂内置：
 * 全员可见，仅 ADMIN 可删除，排序/布局调整对所有登录用户生效（ADMIN/ANALYST 可改）。
 * 静态月末快照（BB=1 核算版 2026-08-31），不含 sourceSql，不参与 v0.4.8 数据变化自动重放。
 */

export interface DefaultDashboardWidgetSeed {
  widgetId: string;
  widget: Record<string, unknown>;
  sortOrder: number;
}

const NPA_MONTHLY_INVEST = [
  { month: '1月', tfje: 316.2 },
  { month: '2月', tfje: 284.9 },
  { month: '3月', tfje: 394.3 },
  { month: '4月', tfje: 172.1 },
  { month: '5月', tfje: 369.6 },
  { month: '6月', tfje: 586.5 },
  { month: '7月', tfje: 179.0 },
  { month: '8月', tfje: 15.6 },
];

const NPA_BIZ_STRUCTURE = [
  { ywfl: '债项类', je: 1383.2 },
  { ywfl: '收购处置类', je: 580.5 },
  { ywfl: '权益类', je: 251.5 },
  { ywfl: '其他', je: 103.0 },
];

const NPA_ORG_INVEST_TOP = [
  { jgmc: '北京市分公司', je: 720.3 },
  { jgmc: '上海市分公司', je: 285.5 },
  { jgmc: '四川省分公司', je: 210.1 },
  { jgmc: '江苏省分公司', je: 196.8 },
  { jgmc: '山东省分公司', je: 157.0 },
  { jgmc: '河北省分公司', je: 153.1 },
  { jgmc: '广东省分公司', je: 97.0 },
  { jgmc: '河南省分公司', je: 94.3 },
  { jgmc: '陕西省分公司', je: 58.8 },
  { jgmc: '海南省分公司', je: 55.2 },
];

const NPA_AGED_TOP = [
  { jgmc: '浙江省分公司', bs: 189 },
  { jgmc: '福建省分公司', bs: 145 },
  { jgmc: '上海市分公司', bs: 123 },
  { jgmc: '广东省分公司', bs: 114 },
  { jgmc: '山东省分公司', bs: 106 },
  { jgmc: '重庆市分公司', bs: 102 },
  { jgmc: '江苏省分公司', bs: 100 },
  { jgmc: '湖北省分公司', bs: 90 },
];

const NPA_MONTHLY_RETURN = [
  { month: '1月', sy: 25.4 },
  { month: '2月', sy: 31.8 },
  { month: '3月', sy: 163.0 },
  { month: '4月', sy: 29.4 },
  { month: '5月', sy: 59.6 },
  { month: '6月', sy: 123.2 },
  { month: '7月', sy: 53.0 },
  { month: '8月', sy: 1.1 },
];

export const DEFAULT_DASHBOARD_WIDGET_SEEDS: DefaultDashboardWidgetSeed[] = [
  {
    widgetId: 'widget-1',
    sortOrder: 0,
    widget: {
      id: 'widget-1',
      title: '2026年逐月投放金额走势',
      chartConfig: {
        type: 'area',
        title: '逐月投放金额走势（月末快照口径）',
        xAxisKey: 'month',
        yAxisKeys: ['tfje'],
        yAxisNames: { tfje: '当月投放金额（亿元）' },
        xAxisName: '月份',
        stacked: false,
      },
      data: NPA_MONTHLY_INVEST,
      colSpan: 2,
    },
  },
  {
    widgetId: 'widget-2',
    sortOrder: 1,
    widget: {
      id: 'widget-2',
      title: '本年投放业务分类结构',
      chartConfig: {
        type: 'pie',
        title: '本年投放业务分类占比',
        xAxisKey: 'ywfl',
        yAxisKeys: ['je'],
        yAxisNames: { je: '本年投放金额（亿元）' },
        xAxisName: '业务分类',
        stacked: false,
      },
      data: NPA_BIZ_STRUCTURE,
      colSpan: 1,
    },
  },
  {
    widgetId: 'widget-3',
    sortOrder: 2,
    widget: {
      id: 'widget-3',
      title: '本年投放金额 TOP10 机构',
      chartConfig: {
        type: 'bar',
        title: '各机构本年投放金额排名（核算版）',
        xAxisKey: 'jgmc',
        yAxisKeys: ['je'],
        yAxisNames: { je: '本年投放金额（亿元）' },
        xAxisName: '机构名称',
        stacked: false,
      },
      data: NPA_ORG_INVEST_TOP,
      colSpan: 2,
    },
  },
  {
    widgetId: 'widget-4',
    sortOrder: 3,
    widget: {
      id: 'widget-4',
      title: '长龄业务笔数 TOP8 机构',
      chartConfig: {
        type: 'bar',
        title: '各机构长龄业务笔数（SFCL=是）',
        xAxisKey: 'jgmc',
        yAxisKeys: ['bs'],
        yAxisNames: { bs: '长龄业务笔数' },
        xAxisName: '机构名称',
        stacked: false,
      },
      data: NPA_AGED_TOP,
      colSpan: 1,
    },
  },
  {
    widgetId: 'widget-5',
    sortOrder: 4,
    widget: {
      id: 'widget-5',
      title: '当年投资收益逐月兑现走势',
      chartConfig: {
        type: 'line',
        title: '当月投资收益走势（财务宽表核算版）',
        xAxisKey: 'month',
        yAxisKeys: ['sy'],
        yAxisNames: { sy: '当月投资收益（亿元）' },
        xAxisName: '月份',
        stacked: false,
      },
      data: NPA_MONTHLY_RETURN,
      colSpan: 2,
    },
  },
];
