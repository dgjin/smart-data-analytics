import { DataSource, TableSchema } from '../types/analytics';

export const DEMO_TABLE_SALES: TableSchema = {
  id: 'sales_performance',
  name: 'sales_performance',
  displayName: '全渠道销售业绩表',
  description: '包含各区域、各渠道、产品类目的月度销售额、订单量与利润数据',
  rowCount: 12500,
  columns: [
    { name: 'date', type: 'date', description: '交易日期', isDimension: true },
    { name: 'region', type: 'category', description: '大区 (华东/华南/华北/西南)', isDimension: true },
    { name: 'channel', type: 'category', description: '销售渠道 (线上电商/线下门店/企业直供)', isDimension: true },
    { name: 'category', type: 'category', description: '产品类目 (智能硬件/云服务/企业软件/咨询)', isDimension: true },
    { name: 'revenue', type: 'number', description: '销售金额(元)', isMetric: true },
    { name: 'orders', type: 'number', description: '订单数(笔)', isMetric: true },
    { name: 'profit', type: 'number', description: '净利润(元)', isMetric: true },
    { name: 'discount_rate', type: 'number', description: '平均折扣率(%)', isMetric: true },
  ],
};

export const DEMO_TABLE_MARKETING: TableSchema = {
  id: 'marketing_funnel',
  name: 'marketing_funnel',
  displayName: '营销投流与客户转化表',
  description: '投放渠道广告消耗、曝光量、点击率及最终转化ROI',
  rowCount: 4800,
  columns: [
    { name: 'campaign', type: 'string', description: '活动名称', isDimension: true },
    { name: 'channel', type: 'category', description: '广告平台 (信息流/搜索引擎/社媒种草)', isDimension: true },
    { name: 'cost', type: 'number', description: '广告消耗金额(元)', isMetric: true },
    { name: 'impressions', type: 'number', description: '曝光量(次)', isMetric: true },
    { name: 'clicks', type: 'number', description: '点击量(次)', isMetric: true },
    { name: 'leads', type: 'number', description: '线索生成数', isMetric: true },
    { name: 'roi', type: 'number', description: '投资回报率ROI', isMetric: true },
  ],
};

export const DEMO_TABLE_INVENTORY: TableSchema = {
  id: 'product_inventory',
  name: 'product_inventory',
  displayName: '供应链与库存风险表',
  description: '仓库存货量、周转天数、周转率及缺货预警',
  rowCount: 680,
  columns: [
    { name: 'product_sku', type: 'string', description: '商品SKU编码', isPrimaryKey: true },
    { name: 'product_name', type: 'string', description: '商品名称', isDimension: true },
    { name: 'warehouse', type: 'category', description: '所属仓库', isDimension: true },
    { name: 'stock_qty', type: 'number', description: '当前库存数量', isMetric: true },
    { name: 'safety_stock', type: 'number', description: '安全库存阈值', isMetric: true },
    { name: 'turnover_days', type: 'number', description: '库存周转天数', isMetric: true },
  ],
};

export const INITIAL_DATA_SOURCES: DataSource[] = [
  {
    id: 'ds_enterprise_demo',
    name: '企业综合运营数仓 (Demo)',
    type: 'demo',
    status: 'connected',
    config: {
      database: 'enterprise_dw_prod',
      host: 'dw-cluster.internal.net',
      port: 5432,
    },
    tables: [DEMO_TABLE_SALES, DEMO_TABLE_MARKETING, DEMO_TABLE_INVENTORY],
    lastSyncedAt: new Date().toISOString(),
  },
  {
    id: 'ds_pg_analytics',
    name: 'PostgreSQL 生产电商数据库',
    type: 'postgresql',
    status: 'connected',
    config: {
      host: '10.0.4.12',
      port: 5432,
      database: 'ecommerce_prod',
      username: 'readonly_bi',
    },
    tables: [DEMO_TABLE_SALES],
    lastSyncedAt: new Date().toISOString(),
  },
  {
    id: 'ds_csv_upload',
    name: '2026年Q2运营财报 (CSV)',
    type: 'csv',
    status: 'connected',
    config: {
      fileName: 'Q2_Financial_Metrics.csv',
      fileSize: '2.4 MB',
    },
    tables: [DEMO_TABLE_MARKETING],
    lastSyncedAt: new Date().toISOString(),
  },
];

// Seed raw mock data generator for interactive query results
export const MOCK_SALES_DATA = [
  { date: '2026-01', region: '华东', channel: '线上电商', category: '智能硬件', revenue: 1420000, orders: 3200, profit: 420000, discount_rate: 8.8 },
  { date: '2026-01', region: '华南', channel: '线下门店', category: '云服务', revenue: 980000, orders: 1800, profit: 310000, discount_rate: 9.5 },
  { date: '2026-01', region: '华北', channel: '企业直供', category: '企业软件', revenue: 2100000, orders: 450, profit: 890000, discount_rate: 9.0 },
  { date: '2026-02', region: '华东', channel: '线上电商', category: '智能硬件', revenue: 1680000, orders: 3800, profit: 510000, discount_rate: 8.5 },
  { date: '2026-02', region: '华南', channel: '线下门店', category: '云服务', revenue: 1120000, orders: 2100, profit: 360000, discount_rate: 9.2 },
  { date: '2026-02', region: '华北', channel: '企业直供', category: '企业软件', revenue: 2350000, orders: 510, profit: 980000, discount_rate: 8.9 },
  { date: '2026-03', region: '华东', channel: '线上电商', category: '智能硬件', revenue: 1950000, orders: 4200, profit: 620000, discount_rate: 8.2 },
  { date: '2026-03', region: '华南', channel: '线下门店', category: '云服务', revenue: 1350000, orders: 2400, profit: 450000, discount_rate: 9.0 },
  { date: '2026-03', region: '华北', channel: '企业直供', category: '企业软件', revenue: 2780000, orders: 620, profit: 1150000, discount_rate: 8.7 },
  { date: '2026-04', region: '华东', channel: '线上电商', category: '智能硬件', revenue: 2150000, orders: 4600, profit: 710000, discount_rate: 8.0 },
  { date: '2026-04', region: '华南', channel: '线下门店', category: '云服务', revenue: 1480000, orders: 2600, profit: 490000, discount_rate: 8.8 },
  { date: '2026-04', region: '华北', channel: '企业直供', category: '企业软件', revenue: 3100000, orders: 680, profit: 1320000, discount_rate: 8.5 },
  { date: '2026-05', region: '华东', channel: '线上电商', category: '智能硬件', revenue: 2420000, orders: 5100, profit: 820000, discount_rate: 7.9 },
  { date: '2026-05', region: '华南', channel: '线下门店', category: '云服务', revenue: 1620000, orders: 2850, profit: 540000, discount_rate: 8.7 },
  { date: '2026-05', region: '华北', channel: '企业直供', category: '企业软件', revenue: 3450000, orders: 740, profit: 1480000, discount_rate: 8.3 },
  { date: '2026-06', region: '华东', channel: '线上电商', category: '智能硬件', revenue: 2890000, orders: 5900, profit: 980000, discount_rate: 7.8 },
  { date: '2026-06', region: '华南', channel: '线下门店', category: '云服务', revenue: 1850000, orders: 3100, profit: 610000, discount_rate: 8.5 },
  { date: '2026-06', region: '华北', channel: '企业直供', category: '企业软件', revenue: 3880000, orders: 810, profit: 1650000, discount_rate: 8.1 },
];

export const MOCK_MARKETING_DATA = [
  { campaign: '春季AI智能硬件首发', channel: '信息流广告', cost: 350000, impressions: 12000000, clicks: 380000, leads: 14500, roi: 3.85 },
  { campaign: '云服务企业试用月', channel: '搜索引擎竞价', cost: 220000, impressions: 4500000, clicks: 210000, leads: 9200, roi: 4.12 },
  { campaign: '618年中智造狂欢节', channel: '社媒精准种草', cost: 480000, impressions: 18500000, clicks: 620000, leads: 22800, roi: 3.42 },
  { campaign: 'B2B软件峰会定向引流', channel: '行业垂直媒体', cost: 150000, impressions: 1200000, clicks: 85000, leads: 4800, roi: 5.20 },
  { campaign: '品牌高管深度访谈品牌PR', channel: '视频内容投流', cost: 180000, impressions: 6800000, clicks: 140000, leads: 3100, roi: 2.15 },
];

export const MOCK_INVENTORY_DATA = [
  { product_sku: 'SKU-AI-1001', product_name: 'AI边缘计算网关 Pro', warehouse: '华东1号仓', stock_qty: 320, safety_stock: 500, turnover_days: 14 },
  { product_sku: 'SKU-SW-2002', product_name: '企业智能决策系统V3', warehouse: '云服务虚拟仓', stock_qty: 9999, safety_stock: 100, turnover_days: 2 },
  { product_sku: 'SKU-HW-3003', product_name: '智能高精传感器终端', warehouse: '华南2号仓', stock_qty: 120, safety_stock: 400, turnover_days: 48 },
  { product_sku: 'SKU-HW-3004', product_name: '工业级PLC控制器', warehouse: '华北1号仓', stock_qty: 850, safety_stock: 300, turnover_days: 22 },
  { product_sku: 'SKU-HW-3005', product_name: '数据中心智能PDU', warehouse: '西南仓', stock_qty: 45, safety_stock: 150, turnover_days: 62 },
];
