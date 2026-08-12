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

const INITIAL_REPORT: SavedReport = scanReportForAnomalies({
  id: 'report-demo-1',
  title: '2026年企业数字化运营与全渠道商业增长决策报告',
  summary: '本报告基于企业多维度数据接入与AI归因分析，对营收结构、营销投放效能及供应链健康度进行了系统性梳理。数据显示企业整体业绩保持高速增长，但部分区域的客单价与滞销库存仍有优化空间。',
  createdAt: new Date().toISOString().split('T')[0],
  dataSourceId: 'ds-1',
  templateType: 'executive',
  insights: [
    {
      title: '高利润软件与云服务业务加速释放',
      type: 'positive',
      content: '企业软件与云服务类目在过去两季度营收占比提升至 48%，拉动整体毛利率上涨 2.3 个百分点。',
      actionItem: '加大B2B云端解决方案的销售人员激励与渠道跟进力度。',
    },
    {
      title: '华南线下渠道客单价呈现小幅下滑',
      type: 'warning',
      content: '华南线下门店客单价环比下降 4.1%，且平均折扣率由 9.5 降至 8.8。',
      actionItem: '针对华南区域推出高价值硬件组合套餐以提升连带率。',
    },
    {
      title: '硬件类目断货与呆滞双重预警',
      type: 'critical',
      content: 'AI边缘计算网关Pro库存偏低，而高精传感器终端周转天数达48天。',
      actionItem: '启动紧急补货机制，同时对长周转传感器执行促销清仓。',
    },
  ],
  kpiList: [
    { label: '全渠道总营收', value: '¥38.57M', change: '+32.4%', status: 'good' },
    { label: '综合净利润率', value: '37.1%', change: '+2.3%', status: 'good' },
    { label: '营销平均ROI', value: '3.74', change: '-12.8%', status: 'bad' },
    { label: '库存周转天数', value: '29.6天', change: '-4.2天', status: 'good' },
  ],
  charts: [
    {
      title: '2026上半年月度销售额与净利润走势',
      chartConfig: {
        type: 'line',
        title: '月度营收与利润走势',
        xAxisKey: 'date',
        yAxisKeys: ['revenue', 'profit'],
      },
      data: [
        { date: '1月', revenue: 450, profit: 162 },
        { date: '2月', revenue: 515, profit: 185 },
        { date: '3月', revenue: 608, profit: 222 },
        { date: '4月', revenue: 673, profit: 252 },
        { date: '5月', revenue: 749, profit: 284 },
        { date: '6月', revenue: 1262, profit: 524 }, // Sharp anomaly spike
      ],
      commentary: '营收曲线呈现连续上扬态势，6月受年中大促与冲量订单影响出现明显高点突破。',
    },
    {
      title: '营销投放渠道成本与收益分布',
      chartConfig: {
        type: 'bar',
        title: '渠道投放成本与ROI',
        xAxisKey: 'channel',
        yAxisKeys: ['roi'],
      },
      data: [
        { channel: '行业垂直媒体', roi: 5.20 },
        { channel: '搜索引擎竞价', roi: 4.12 },
        { channel: '信息流广告', roi: 3.85 },
        { channel: '社媒精准种草', roi: 3.42 },
        { channel: '视频内容投流', roi: 1.15 }, // Anomaly drop
      ],
      commentary: '垂直媒体渠道效率最优，视频内容投流成本高昂但转化率偏低，已触发异常标注。',
    },
  ],
  comments: [
    {
      id: 'cmt-demo-1',
      reportId: 'report-demo-1',
      chartTitle: '2026上半年月度销售额与净利润走势',
      dataPointKey: '6月',
      userName: '陈分析师 (BI)',
      userRole: '数据分析师',
      content: '6月营收冲至 1,262 万的陡增节点，已确认包含 618 大促补贴以及华东大客户的 280 万采购订单归因。',
      createdAt: '10分钟前',
      isResolved: false,
      replies: [
        {
          id: 'rpl-demo-1',
          userName: '张总 (CEO)',
          userRole: '首席执行官',
          content: '收到，请评估去除大促补贴后的真实复购率基线。',
          createdAt: '5分钟前',
        },
      ],
    },
    {
      id: 'cmt-demo-2',
      reportId: 'report-demo-1',
      chartTitle: '营销投放渠道成本与收益分布',
      dataPointKey: '视频内容投流',
      userName: '李总监 (运营)',
      userRole: '运营总监',
      content: '视频内容投流 ROI 仅 1.15，属于严重异常低效区间，已暂停该渠道预算投放，正在重新审查服务商素材质量。',
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
  deleteSavedReport: (id: string) => void;
  addReportComment: (reportId: string, comment: ChartComment) => void;
  addReportCommentReply: (reportId: string, commentId: string, reply: ChartCommentReply) => void;
  toggleReportCommentResolve: (reportId: string, commentId: string) => void;

  // Active View Tab
  activeTab: AppTab;
  setActiveTab: (tab: AppTab) => void;
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
        const stillValid = list.some((d) => d.id === state.activeDataSourceId);
        const nextActiveId = stillValid ? state.activeDataSourceId : list[0]?.id || '';
        const nextActiveDS = list.find((d) => d.id === nextActiveId);
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
      chatMessages: [...state.chatMessages, msg],
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
      chatMessages: [state.chatMessages[0]],
      activeQueryResult: null,
    })),

  // Pin Widgets to Dashboard
  dashboardWidgets: [
    {
      id: 'widget-1',
      title: '月度销售与利润趋势 (直观分析)',
      chartConfig: {
        type: 'area',
        title: '2026上半年月度销售额与净利润增长趋势',
        xAxisKey: 'date',
        yAxisKeys: ['revenue', 'profit'],
        stacked: false,
      },
      data: [
        { date: '2026-01', revenue: 4500000, profit: 1620000 },
        { date: '2026-02', revenue: 5150000, profit: 1850000 },
        { date: '2026-03', revenue: 6080000, profit: 2220000 },
        { date: '2026-04', revenue: 6730000, profit: 2520000 },
        { date: '2026-05', revenue: 7490000, profit: 2840000 },
        { date: '2026-06', revenue: 8620000, profit: 3240000 },
      ],
      colSpan: 2,
    },
    {
      id: 'widget-2',
      title: '营销投放渠道ROI排行榜',
      chartConfig: {
        type: 'bar',
        title: '渠道投资回报率对比',
        xAxisKey: 'channel',
        yAxisKeys: ['roi'],
        stacked: false,
      },
      data: [
        { channel: '行业垂直媒体', roi: 5.2 },
        { channel: '搜索引擎竞价', roi: 4.12 },
        { channel: '信息流广告', roi: 3.85 },
        { channel: '社媒精准种草', roi: 3.42 },
        { channel: '视频内容投流', roi: 2.15 },
      ],
      colSpan: 1,
    },
  ],

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
    }),
    {
      name: 'analytics-store',
      version: 1,
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
