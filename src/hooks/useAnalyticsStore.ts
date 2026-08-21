import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  ChartConfig,
  DataSource,
  TableSchema,
  QueryResultData,
  ChatMessage,
  SavedReport,
  DashboardWidget,
  ChartComment,
  ChartCommentReply,
  AppTab,
} from '../types/analytics';
import { apiFetch } from '../api/client';
import { scanReportForAnomalies } from '../utils/anomalyDetector';
import { trimChatMessages } from '../utils/chatRetention';

// 默认固化监控图表（widget-1..5）源自「数据资源」库的不良资产宽表（fct_jc_*）；
// 旧持久化数据缺失 dataSourceId 时，按最新数据资源库推演上游：
// 优先匹配已注册 Schema 的宽表特征，其次按源名「数据资源」，避免硬编码数据源 ID。
export const DEFAULT_NPA_WIDGET_IDS = ['widget-1', 'widget-2', 'widget-3', 'widget-4', 'widget-5'];
export const resolveNpaDataSource = (dataSources: DataSource[]): DataSource | undefined =>
  dataSources.find((ds) => ds.tables?.some((t) => t.name.startsWith('fct_jc_'))) ||
  dataSources.find((ds) => ds.name === '数据资源');

// 默认内容数据基线：不良资产宽表 2026-08-31 月末快照（BB=1 核算版），金额单位亿元
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

const INITIAL_REPORT: SavedReport = scanReportForAnomalies({
  id: 'report-demo-1',
  title: '不良资产业务经营分析决策简报（2026年8月月末快照）',
  summary:
    '本简报基于业务宽表与财务宽表（核算版、2026-08-31 月末快照）生成。全辖本年投放 2,318.3 亿元，累计投放资产规模 6.76 万亿元；债项类业务占比近六成，投放主力为北京、上海分公司。资产质量方面，长龄业务 1,841 笔、占比 55.0%，逾期资产 4,195.4 亿元、风险项目 307 个，去化处置压力仍需重点关注。',
  createdAt: new Date().toISOString().split('T')[0],
  dataSourceId: 'ds-1',
  templateType: 'executive',
  insights: [
    {
      title: '债项类业务主导本年投放结构',
      type: 'positive',
      content: '本年投放 2,318.3 亿元中债项类 1,383.2 亿元、占比 59.7%，收购处置类 580.5 亿元次之，重组类本年无新增投放。',
      actionItem: '在保持债项类基本盘的同时，评估收购处置类项目的处置周期与回报安排，培育重组类业务储备。',
    },
    {
      title: '长龄资产占比过半需加快去化',
      type: 'warning',
      content: '存量 3,348 笔业务中长龄业务 1,841 笔、占比 55.0%，浙江（189 笔）、福建（145 笔）长龄笔数居前。',
      actionItem: '对长龄占比前十机构逐户制定去化时间表，将去化进度纳入月度经营例会跟踪。',
    },
    {
      title: '逾期与风险项目规模仍处高位',
      type: 'critical',
      content: '逾期资产金额 4,195.4 亿元，风险项目 307 个，资产质量管控压力持续。',
      actionItem: '对风险项目实行清单制管理，逐项目明确化解责任人与处置路径。',
    },
    {
      title: '投资收益呈季末高点特征',
      type: 'info',
      content: '当年投资收益集中于 3 月（163.0 亿元）与 6 月（123.2 亿元）兑现，8 月当月仅 1.1 亿元。',
      actionItem: '结合项目处置节奏平滑收益确认安排，避免季度间大幅波动。',
    },
  ],
  kpiList: [
    { label: '本年投放金额', value: '2,318.3亿元', change: '核算版', status: 'good' },
    { label: '累计投放规模', value: '6.76万亿元', change: '月末快照', status: 'neutral' },
    { label: '长龄业务占比', value: '55.0%', change: '1,841/3,348笔', status: 'bad' },
    { label: '逾期资产金额', value: '4,195.4亿元', change: '风险项目307个', status: 'bad' },
  ],
  charts: [
    {
      title: '2026年逐月投放金额走势',
      chartConfig: {
        type: 'line',
        title: '逐月投放金额走势（月末快照口径）',
        xAxisKey: 'month',
        yAxisKeys: ['tfje'],
        yAxisNames: { tfje: '当月投放金额（亿元）' },
        xAxisName: '月份',
      },
      data: NPA_MONTHLY_INVEST,
      commentary: '投放节奏呈明显季末冲量特征，6 月达 586.5 亿元年内高点，8 月投放回落至 15.6 亿元。',
    },
    {
      title: '本年投放业务分类结构',
      chartConfig: {
        type: 'pie',
        title: '本年投放业务分类占比',
        xAxisKey: 'ywfl',
        yAxisKeys: ['je'],
        yAxisNames: { je: '本年投放金额（亿元）' },
        xAxisName: '业务分类',
      },
      data: NPA_BIZ_STRUCTURE,
      commentary: '债项类占比 59.7% 居绝对主导，收购处置类 25.0%、权益类 10.8%。',
    },
    {
      title: '当年投资收益逐月兑现走势',
      chartConfig: {
        type: 'bar',
        title: '当月投资收益走势（财务宽表核算版）',
        xAxisKey: 'month',
        yAxisKeys: ['sy'],
        yAxisNames: { sy: '当月投资收益（亿元）' },
        xAxisName: '月份',
      },
      data: NPA_MONTHLY_RETURN,
      commentary: '投资收益集中在 3 月与 6 月兑现，两月合计占前 8 个月的 58.8%。',
    },
  ],
  comments: [
    {
      id: 'cmt-demo-1',
      reportId: 'report-demo-1',
      chartTitle: '2026年逐月投放金额走势',
      dataPointKey: '6月',
      userName: '陈分析师 (BI)',
      userRole: '数据分析师',
      content: '6 月投放冲至 586.5 亿元的半年度高点，已核实主要为北京、上海分公司季末集中投放项目落地。',
      createdAt: '10分钟前',
      isResolved: false,
      replies: [
        {
          id: 'rpl-demo-1',
          userName: '张总 (CEO)',
          userRole: '首席执行官',
          content: '收到，请补充季末冲量项目的投后管理跟踪安排。',
          createdAt: '5分钟前',
        },
      ],
    },
    {
      id: 'cmt-demo-2',
      reportId: 'report-demo-1',
      chartTitle: '当年投资收益逐月兑现走势',
      dataPointKey: '8月',
      userName: '李总监 (财务)',
      userRole: '财务总监',
      content: '8 月当月投资收益仅 1.1 亿元，系处置项目收益确认尚未到账期，预计三季度末集中兑现。',
      createdAt: '15分钟前',
      isResolved: false,
      replies: [],
    },
  ],
});

interface AnalyticsState {
  // Data Sources
  dataSources: DataSource[];
  activeDataSourceId: string;
  activeTableId: string | null;
  addDataSource: (ds: DataSource) => void;
  removeDataSource: (id: string) => void;
  updateDataSource: (ds: DataSource) => void;
  loadDataSources: () => Promise<void>;
  setActiveDataSource: (id: string) => void;
  setActiveTable: (tableId: string | null) => void;
  updateTableSchema: (dsId: string, table: TableSchema) => void;

  // NL Chat & Query
  chatMessages: ChatMessage[];
  currentQuery: string;
  isQueryLoading: boolean;
  activeQueryResult: QueryResultData | null;
  setQueryLoading: (loading: boolean) => void;
  setCurrentQuery: (q: string) => void;
  addChatMessage: (msg: ChatMessage) => void;
  setActiveQueryResult: (res: QueryResultData | null) => void;
  updateMessageChartConfig: (msgId: string, config: ChartConfig) => void;
  setMessageFeedback: (msgId: string, verdict: 'UP' | 'DOWN') => void;
  clearChat: () => void;

  // Custom Dashboard Widgets
  dashboardWidgets: DashboardWidget[];
  pinChartToDashboard: (widget: Omit<DashboardWidget, 'id'>) => void;
  removeDashboardWidget: (id: string) => void;
  updateDashboardWidget: (id: string, updates: Partial<DashboardWidget>) => void;
  reorderDashboardWidgets: (widgets: DashboardWidget[]) => void;

  // Generated Visual Reports
  savedReports: SavedReport[];
  addSavedReport: (report: SavedReport) => void;
  /** v0.4.8 自主更新：数据变化重新生成后就地替换同 id 报表（保留批注等交互状态由调用方并入） */
  replaceSavedReport: (id: string, report: SavedReport) => void;
  deleteSavedReport: (id: string) => void;
  addReportComment: (reportId: string, comment: ChartComment) => void;
  addReportCommentReply: (reportId: string, commentId: string, reply: ChartCommentReply) => void;
  toggleReportCommentResolve: (reportId: string, commentId: string) => void;

  // Active View Tab
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;

  /** v0.5.0 报告中心：从问数对话跳转时待查看的报告 ID（报告中心消费后清除） */
  pendingReportId: string | null;
  setPendingReportId: (reportId: string | null) => void;
}

export const useAnalyticsStore = create<AnalyticsState>()(
  persist(
    (set) => ({
  // 数据源由服务端 MySQL 持久化，登录后通过 loadDataSources() 加载
  dataSources: [],
  activeDataSourceId: '',
  activeTableId: null,

  addDataSource: (ds) =>
    set((state) => ({
      dataSources: [ds, ...state.dataSources],
      activeDataSourceId: ds.id,
    })),

  removeDataSource: (id) =>
    set((state) => {
      const remaining = state.dataSources.filter((d) => d.id !== id);
      const nextActive =
        state.activeDataSourceId === id ? remaining[0]?.id || '' : state.activeDataSourceId;
      const nextActiveDS = remaining.find((d) => d.id === nextActive);
      return {
        dataSources: remaining,
        activeDataSourceId: nextActive,
        activeTableId: nextActiveDS?.tables[0]?.id || null,
      };
    }),

  updateDataSource: (ds) =>
    set((state) => ({
      dataSources: state.dataSources.map((d) => (d.id === ds.id ? ds : d)),
    })),

  loadDataSources: async () => {
    try {
      const res = await apiFetch('/api/datasources');
      const data = await res.json();
      if (!Array.isArray(data.dataSources)) return;
      const list = data.dataSources as DataSource[];
      set((state) => {
        // P2-11：无访问权限（accessDenied）的数据源不可作为活跃源（选择器也不展示）
        const accessible = list.filter((d) => !d.accessDenied);
        const stillValid = accessible.some((d) => d.id === state.activeDataSourceId);
        const nextActiveId = stillValid ? state.activeDataSourceId : accessible[0]?.id || '';
        const nextActiveDS = accessible.find((d) => d.id === nextActiveId);
        return {
          dataSources: list,
          activeDataSourceId: nextActiveId,
          activeTableId: stillValid
            ? state.activeTableId
            : nextActiveDS?.tables[0]?.id || null,
        };
      });
    } catch {
      // 静默失败：401 已由 apiFetch 统一处理（清空会话跳转登录页）
    }
  },

  setActiveDataSource: (id) =>
    set((state) => {
      const found = state.dataSources.find((d) => d.id === id);
      return {
        activeDataSourceId: id,
        activeTableId: found?.tables[0]?.id || null,
      };
    }),

  setActiveTable: (tableId) => set({ activeTableId: tableId }),

  updateTableSchema: (dsId, table) =>
    set((state) => ({
      dataSources: state.dataSources.map((ds) => {
        if (ds.id !== dsId) return ds;
        const exists = ds.tables.some((t) => t.id === table.id);
        const updatedTables = exists
          ? ds.tables.map((t) => (t.id === table.id ? table : t))
          : [...ds.tables, table];
        return { ...ds, tables: updatedTables };
      }),
    })),

  // 欢迎语仅为首次初始化兜底：QueryChat 渲染时会按当前数据源真实表结构动态替换其内容
  chatMessages: [
    {
      id: 'welcome-1',
      role: 'assistant',
      content:
        '👋 你好！我是企业智能问数据分析助手。接入数据源后，即可用自然语言直接查询真实业务数据。',
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    },
  ],

  currentQuery: '',
  isQueryLoading: false,
  activeQueryResult: null,

  setQueryLoading: (loading) => set({ isQueryLoading: loading }),
  setCurrentQuery: (q) => set({ currentQuery: q }),

  addChatMessage: (msg) =>
    set((state) => ({
      // 消息未显式指定归属源时，盖上当前活跃数据源戳，保证历史按源隔离；
      // P2-2 滚动上限：追加后按源裁剪，防 localStorage 无限膨胀
      chatMessages: trimChatMessages([
        ...state.chatMessages,
        { ...msg, dataSourceId: msg.dataSourceId ?? state.activeDataSourceId },
      ]),
    })),

  setActiveQueryResult: (res) => set({ activeQueryResult: res }),

  updateMessageChartConfig: (msgId, config) =>
    set((state) => ({
      chatMessages: state.chatMessages.map((m) =>
        m.id === msgId && m.queryResult
          ? { ...m, queryResult: { ...m.queryResult, chartConfig: config } }
          : m
      ),
    })),

  setMessageFeedback: (msgId, verdict) =>
    set((state) => ({
      chatMessages: state.chatMessages.map((m) => (m.id === msgId ? { ...m, feedback: verdict } : m)),
    })),

  clearChat: () =>
    set((state) => ({
      // 仅清空当前数据源的对话历史，其他数据源历史保留
      chatMessages: state.chatMessages.filter(
        (m) => (m.dataSourceId ?? '') !== (state.activeDataSourceId || '')
      ),
      activeQueryResult: null,
    })),

  // Pin Widgets to Dashboard（默认组件：不良资产宽表 2026-08-31 月末快照核算版真实数据，金额单位亿元）
  // 显式标注 DashboardWidget[]：strictNullChecks 下各 widget 的 yAxisNames 字面量形状不同，
  // 推断出的联合类型（可选键 ?: undefined）与 Record<string, string> 不兼容
  dashboardWidgets: [
    {
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
    {
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
    {
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
    {
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
    {
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
  ] as DashboardWidget[],

  pinChartToDashboard: (widget) =>
    set((state) => ({
      dashboardWidgets: [
        ...state.dashboardWidgets,
        { ...widget, id: `widget-${Date.now()}` },
      ],
    })),

  removeDashboardWidget: (id) =>
    set((state) => ({
      dashboardWidgets: state.dashboardWidgets.filter((w) => w.id !== id),
    })),

  updateDashboardWidget: (id, updates) =>
    set((state) => ({
      dashboardWidgets: state.dashboardWidgets.map((w) =>
        w.id === id ? { ...w, ...updates } : w
      ),
    })),

  reorderDashboardWidgets: (widgets) => set({ dashboardWidgets: widgets }),

  savedReports: [INITIAL_REPORT],
  addSavedReport: (report) =>
    set((state) => ({
      savedReports: [report, ...state.savedReports],
    })),
  replaceSavedReport: (id, report) =>
    set((state) => ({
      savedReports: state.savedReports.map((r) => (r.id === id ? report : r)),
    })),
  deleteSavedReport: (id) =>
    set((state) => ({
      savedReports: state.savedReports.filter((r) => r.id !== id),
    })),

  addReportComment: (reportId, comment) =>
    set((state) => ({
      savedReports: state.savedReports.map((report) => {
        if (report.id !== reportId) return report;
        const currentComments = report.comments || [];
        return {
          ...report,
          comments: [comment, ...currentComments],
        };
      }),
    })),

  addReportCommentReply: (reportId, commentId, reply) =>
    set((state) => ({
      savedReports: state.savedReports.map((report) => {
        if (report.id !== reportId) return report;
        const currentComments = report.comments || [];
        return {
          ...report,
          comments: currentComments.map((cmt) => {
            if (cmt.id !== commentId) return cmt;
            return {
              ...cmt,
              replies: [...cmt.replies, reply],
            };
          }),
        };
      }),
    })),

  toggleReportCommentResolve: (reportId, commentId) =>
    set((state) => ({
      savedReports: state.savedReports.map((report) => {
        if (report.id !== reportId) return report;
        const currentComments = report.comments || [];
        return {
          ...report,
          comments: currentComments.map((cmt) => {
            if (cmt.id !== commentId) return cmt;
            return {
              ...cmt,
              isResolved: !cmt.isResolved,
            };
          }),
        };
      }),
    })),

  activeTab: 'query',
  setActiveTab: (tab) => set({ activeTab: tab }),

  // v0.5.0 报告中心跳转（不持久化，会话内有效）
  pendingReportId: null,
  setPendingReportId: (reportId) => set({ pendingReportId: reportId }),
    }),
    {
      // v2：默认看板组件与示例报表切换为不良资产真实数据快照，旧版本本地缓存直接废弃重建
      // v3：为默认固化图表补全 dataSourceId（指向「数据资源」库），修正血缘视图上游归属
      // v4：旧未归属对话消息补盖最后活跃数据源戳，历史按源隔离不再串源
      name: 'analytics-store',
      version: 4,
      migrate: (persisted, version) => {
        const state = persisted as {
          dataSources?: DataSource[];
          dashboardWidgets?: DashboardWidget[];
          chatMessages?: ChatMessage[];
          activeDataSourceId?: string;
        };
        if (version < 3 && state && Array.isArray(state.dashboardWidgets)) {
          const npa = resolveNpaDataSource(state.dataSources || []);
          if (npa) {
            state.dashboardWidgets = state.dashboardWidgets.map((w) =>
              DEFAULT_NPA_WIDGET_IDS.includes(w.id) && !w.dataSourceId
                ? { ...w, dataSourceId: npa.id }
                : w
            );
          }
        }
        if (version < 4 && state && Array.isArray(state.chatMessages)) {
          const fallbackDs = state.activeDataSourceId || '';
          state.chatMessages = state.chatMessages.map((m) =>
            m.dataSourceId ? m : { ...m, dataSourceId: fallbackDs }
          );
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return state as any;
      },
      partialize: (state) => ({
        dataSources: state.dataSources,
        activeDataSourceId: state.activeDataSourceId,
        activeTableId: state.activeTableId,
        chatMessages: state.chatMessages,
        dashboardWidgets: state.dashboardWidgets,
        savedReports: state.savedReports,
        activeTab: state.activeTab,
      }),
    }
  )
);
