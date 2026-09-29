/**
 * v0.9.86 首启向导 Phase 2 —— 内置演示数据集一键加载（设计见 docs/首启初始化向导交互设计20260929.md §四 Step③）：
 * - 在应用库创建 3 张演示物理表（upl_ 前缀，复用文件数据源白名单与真实执行链路）；
 * - 确定性样本数据（固定种子 LCG 生成，任何环境/任何时刻结果完全一致，测试可精确断言）；
 * - 注册演示数据源 ds_setup_demo（type=csv → fileBacked 判定，问数/报表/灵活查询全部走应用库真实执行）；
 * - 治理配置（executeAutoConfig：能力画像 + 知识骨架 + 铁律模板）与向量化（runAutoKnowledgeSync）复用既有接入闭环；
 * - 重复加载幂等：物理表 DROP 重建、数据源 UPSERT、知识条目/铁律按确定性键覆盖、few-shot 跳过已存在。
 * 任务包装见 taskHandlers（setup_demo_data），路由见 routes/setup（POST /demo-data）。
 */
import type mysql from 'mysql2/promise';
import { getPool } from './infra/db';
import { createFileTable } from './query/fileDataSource';
import { invalidateSchemaCache } from './query/schemaContext';
import type { SchemaTable } from './query/schemaTypes';
import { executeAutoConfig } from './datasource/autoConfig';
import { runAutoKnowledgeSync } from './knowledge/autoKnowledgeSync';

/** 演示数据源固定 ID（Step① 环境自检「内置演示数据」判定依据；UPSERT 幂等键） */
export const DEMO_DS_ID = 'ds_setup_demo';
export const DEMO_DS_NAME = '内置演示数据集（销售/营销/库存）';

interface DemoColumnSpec {
  name: string;
  /** schema_json 呈现给模型的语义类型 */
  type: string;
  /** 应用库物理列类型（与文件数据源推断域一致） */
  sqlType: 'TEXT' | 'DOUBLE';
  description: string;
  isPrimaryKey?: boolean;
  isDimension?: boolean;
  isMetric?: boolean;
}

export interface DemoTableSpec {
  /** 应用库物理表名（upl_ 前缀白名单） */
  physical: string;
  displayName: string;
  description: string;
  columns: DemoColumnSpec[];
  /** 确定性行生成（固定种子，重复调用结果一致） */
  rows: () => unknown[][];
}

/** 确定性伪随机（固定种子 LCG）：同一种子在任何进程/时刻生成完全相同的数据序列 */
function makeRand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** 月份序列（2025-01 .. 2026-06，共 18 个月），取每月 15 日 */
function monthDates(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const year = 2025 + Math.floor(i / 12);
    const month = String((i % 12) + 1).padStart(2, '0');
    out.push(`${year}-${month}-15`);
  }
  return out;
}

const SALES_REGIONS = ['华东', '华南', '华北', '西南'];
const SALES_CHANNELS = ['线上电商', '线下门店', '企业直供'];
const SALES_CATEGORIES = ['智能硬件', '云服务', '企业软件', '咨询'];

/** 全渠道销售业绩：18 月 × 4 区域 × 3 渠道 × 4 类目 = 864 行 */
export function demoSalesRows(): unknown[][] {
  const rand = makeRand(20250101);
  const rows: unknown[][] = [];
  for (const date of monthDates(18)) {
    for (const region of SALES_REGIONS) {
      for (const channel of SALES_CHANNELS) {
        for (const category of SALES_CATEGORIES) {
          const revenue = Math.round(180000 + rand() * 420000);
          const orders = Math.max(1, Math.round(revenue / (900 + rand() * 500)));
          const profit = Math.round(revenue * (0.1 + rand() * 0.18));
          const discount = Math.round((2 + rand() * 8) * 100) / 100;
          rows.push([date, region, channel, category, revenue, orders, profit, discount]);
        }
      }
    }
  }
  return rows;
}

const MKT_CAMPAIGNS = ['AI硬件新品造势', '云服务企业试用月', '年中智造狂欢节', 'B2B峰会定向引流', '品牌高管访谈PR', '年末客户答谢季'];
const MKT_CHANNELS = ['信息流广告', '搜索引擎竞价', '社媒精准种草', '行业垂直媒体', '视频内容投流'];

/** 营销投流与转化：6 活动 × 5 平台 = 30 行 */
export function demoMarketingRows(): unknown[][] {
  const rand = makeRand(20250202);
  const rows: unknown[][] = [];
  for (const campaign of MKT_CAMPAIGNS) {
    for (const channel of MKT_CHANNELS) {
      const cost = Math.round(80000 + rand() * 420000);
      const impressions = Math.round(cost * (20 + rand() * 40));
      const clicks = Math.round(impressions * (0.015 + rand() * 0.035));
      const leads = Math.max(1, Math.round(clicks * (0.02 + rand() * 0.05)));
      const roi = Math.round((1.2 + rand() * 4.5) * 100) / 100;
      rows.push([campaign, channel, cost, impressions, clicks, leads, roi]);
    }
  }
  return rows;
}

const INV_PRODUCTS = [
  'AI边缘计算网关 Pro',
  '企业智能决策系统 V3',
  '智能高精传感器终端',
  '工业级PLC控制器',
  '数据中心智能PDU',
  '边缘推理一体机 X2',
  '智能仓储分拣机器人',
  '云原生数据库一体机',
];
const INV_WAREHOUSES = ['华东1号仓', '华南2号仓', '华北1号仓', '西南仓'];

/** 供应链与库存风险：8 商品 × 4 仓库 = 32 行 */
export function demoInventoryRows(): unknown[][] {
  const rand = makeRand(20250303);
  const rows: unknown[][] = [];
  let idx = 0;
  for (const product of INV_PRODUCTS) {
    for (const warehouse of INV_WAREHOUSES) {
      idx += 1;
      const sku = `SKU-DEMO-${3000 + idx}`;
      const stock = Math.round(rand() * 1200);
      const safety = Math.round(100 + rand() * 600);
      const turnover = Math.round((1 + rand() * 70) * 10) / 10;
      rows.push([sku, product, warehouse, stock, safety, turnover]);
    }
  }
  return rows;
}

/** 三张演示表定义（列顺序即行数据顺序；displayName/description 供 prompt 与表头中文化） */
export const DEMO_TABLE_SPECS: DemoTableSpec[] = [
  {
    physical: 'upl_setup_demo_sales',
    displayName: '全渠道销售业绩表',
    description: '演示数据：各区域/渠道/类目月度销售额、订单量与利润（内置确定性样本，可真实查询）',
    columns: [
      { name: 'date', type: 'date', sqlType: 'TEXT', description: '交易日期', isDimension: true },
      { name: 'region', type: 'category', sqlType: 'TEXT', description: '大区（华东/华南/华北/西南）', isDimension: true },
      { name: 'channel', type: 'category', sqlType: 'TEXT', description: '销售渠道（线上电商/线下门店/企业直供）', isDimension: true },
      { name: 'category', type: 'category', sqlType: 'TEXT', description: '产品类目（智能硬件/云服务/企业软件/咨询）', isDimension: true },
      { name: 'revenue', type: 'number', sqlType: 'DOUBLE', description: '销售金额(元)', isMetric: true },
      { name: 'orders', type: 'number', sqlType: 'DOUBLE', description: '订单数(笔)', isMetric: true },
      { name: 'profit', type: 'number', sqlType: 'DOUBLE', description: '净利润(元)', isMetric: true },
      { name: 'discount_rate', type: 'number', sqlType: 'DOUBLE', description: '平均折扣率(%)', isMetric: true },
    ],
    rows: demoSalesRows,
  },
  {
    physical: 'upl_setup_demo_marketing',
    displayName: '营销投流与客户转化表',
    description: '演示数据：投放渠道广告消耗、曝光量、点击率及最终转化ROI（内置确定性样本，可真实查询）',
    columns: [
      { name: 'campaign', type: 'string', sqlType: 'TEXT', description: '活动名称', isDimension: true },
      { name: 'channel', type: 'category', sqlType: 'TEXT', description: '广告平台（信息流/搜索引擎/社媒种草/垂直媒体/视频投流）', isDimension: true },
      { name: 'cost', type: 'number', sqlType: 'DOUBLE', description: '广告消耗金额(元)', isMetric: true },
      { name: 'impressions', type: 'number', sqlType: 'DOUBLE', description: '曝光量(次)', isMetric: true },
      { name: 'clicks', type: 'number', sqlType: 'DOUBLE', description: '点击量(次)', isMetric: true },
      { name: 'leads', type: 'number', sqlType: 'DOUBLE', description: '线索生成数', isMetric: true },
      { name: 'roi', type: 'number', sqlType: 'DOUBLE', description: '投资回报率ROI', isMetric: true },
    ],
    rows: demoMarketingRows,
  },
  {
    physical: 'upl_setup_demo_inventory',
    displayName: '供应链与库存风险表',
    description: '演示数据：仓库存货量、周转天数及缺货预警（内置确定性样本，可真实查询）',
    columns: [
      { name: 'product_sku', type: 'string', sqlType: 'TEXT', description: '商品SKU编码', isPrimaryKey: true },
      { name: 'product_name', type: 'string', sqlType: 'TEXT', description: '商品名称', isDimension: true },
      { name: 'warehouse', type: 'category', sqlType: 'TEXT', description: '所属仓库（华东1号仓/华南2号仓/华北1号仓/西南仓）', isDimension: true },
      { name: 'stock_qty', type: 'number', sqlType: 'DOUBLE', description: '当前库存数量', isMetric: true },
      { name: 'safety_stock', type: 'number', sqlType: 'DOUBLE', description: '安全库存阈值', isMetric: true },
      { name: 'turnover_days', type: 'number', sqlType: 'DOUBLE', description: '库存周转天数', isMetric: true },
    ],
    rows: demoInventoryRows,
  },
];

/** 数据源 config_json：physicalTable 为 fileBacked 判定与执行改道的白名单锚点，physicalTables 供删除级联清理 */
export const DEMO_DS_CONFIG: Record<string, unknown> = {
  fileName: 'setup-demo-dataset.csv',
  fileType: 'csv',
  fileSize: '内置确定性样本',
  demo: true,
  physicalTable: DEMO_TABLE_SPECS[0].physical,
  physicalTables: DEMO_TABLE_SPECS.map((s) => s.physical),
};

/** 表定义 + 行数 → schema_json 表条目（与文件导入 / 数据库接入同构） */
export function toSchemaTable(spec: DemoTableSpec, rowCount: number): SchemaTable {
  return {
    id: `tbl_${spec.physical}`,
    name: spec.physical,
    displayName: spec.displayName,
    description: spec.description,
    rowCount,
    columns: spec.columns.map((c) => ({
      name: c.name,
      type: c.type,
      description: c.description,
      ...(c.isPrimaryKey ? { isPrimaryKey: true } : {}),
      ...(c.isDimension ? { isDimension: true } : {}),
      ...(c.isMetric ? { isMetric: true } : {}),
    })),
  };
}

/** 演示数据集是否已加载（Step① 环境自检 / 前端卡片状态判定） */
export async function isDemoDataSetLoaded(): Promise<boolean> {
  const [rows] = await getPool().query<mysql.RowDataPacket[]>('SELECT 1 FROM data_sources WHERE id = ? LIMIT 1', [DEMO_DS_ID]);
  return rows.length > 0;
}

export interface DemoLoadResult {
  dataSourceId: string;
  /** 物理表数与总行数 */
  tables: number;
  rows: number;
  knowledgeEntries: number;
  ironRules: number;
  /** 向量切片总块数（知识条目 + Schema） */
  vectorChunks: number;
  fewShotSeeded: number;
  /** 向量化/样例环节降级说明（Embedding 不可用等；空数组 = 全链路成功） */
  degraded: string[];
}

/**
 * 一键加载内置演示数据集（幂等）：
 * 1) 建物理表 + 写确定性样本数据；2) UPSERT 数据源 + 治理配置落库；3) 向量入库 + few-shot 种子。
 * actor 记入 created_by；reportProgress 供异步任务进度展示。
 */
export async function loadDemoDataSet(
  actor: string,
  reportProgress: (text: string) => Promise<void>,
): Promise<DemoLoadResult> {
  const pool = getPool();
  const datasets = DEMO_TABLE_SPECS.map((spec) => ({ spec, rows: spec.rows() }));

  // 步骤 1/3：创建演示物理表（DROP 重建）并写入确定性样本数据
  await reportProgress('步骤 1/3：创建演示表与样本数据');
  for (const { spec, rows } of datasets) {
    await createFileTable(
      spec.physical,
      spec.columns.map((c) => ({ name: c.name })),
      spec.columns.map((c) => c.sqlType),
      rows,
    );
  }
  const totalRows = datasets.reduce((n, d) => n + d.rows.length, 0);
  const tables = datasets.map(({ spec, rows }) => toSchemaTable(spec, rows.length));

  // 步骤 2/3：注册数据源（UPSERT 幂等）+ 治理配置（能力画像 + 知识骨架 + 铁律模板）
  await reportProgress('步骤 2/3：注册演示数据源与治理配置');
  await pool.query(
    `INSERT INTO data_sources (id, name, type, config_json, schema_json, status, created_by)
     VALUES (?, ?, 'csv', ?, ?, 'connected', ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), config_json = VALUES(config_json),
       schema_json = VALUES(schema_json), status = 'connected', created_by = VALUES(created_by)`,
    [DEMO_DS_ID, DEMO_DS_NAME, JSON.stringify(DEMO_DS_CONFIG), JSON.stringify(tables), actor],
  );
  const report = executeAutoConfig(DEMO_DS_ID, DEMO_DS_NAME, tables);
  await pool.query('UPDATE data_sources SET anomaly_capabilities_json = ? WHERE id = ?', [
    JSON.stringify(report.capabilities),
    DEMO_DS_ID,
  ]);
  for (let i = 0; i < report.knowledgeEntries.length; i++) {
    const entry = report.knowledgeEntries[i];
    await pool.query(
      `INSERT INTO knowledge_base_entries (entry_id, data_source_id, title, content, tags, category, version, is_preset, created_by)
       VALUES (?, ?, ?, ?, ?, ?, '1.0', 0, ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content), title = VALUES(title), tags = VALUES(tags)`,
      [`kb_auto_${DEMO_DS_ID}_${i + 1}`, DEMO_DS_ID, entry.title, entry.content, JSON.stringify(entry.tags), entry.category, actor],
    );
  }
  for (const tpl of report.ironRuleTemplates) {
    await pool.query(
      `INSERT INTO iron_rules (data_source_id, title, content, status, created_by)
       VALUES (?, ?, ?, 'PENDING', ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content)`,
      [DEMO_DS_ID, tpl.title, tpl.content, actor],
    );
  }

  // 步骤 3/3：知识条目/Schema 向量入库 + few-shot 样例种子（分步容错，Embedding 不可用不阻断）
  await reportProgress('步骤 3/3：知识向量入库与样例种子');
  const sync = await runAutoKnowledgeSync(DEMO_DS_ID, DEMO_DS_NAME, tables, actor, report.knowledgeEntries);

  // 重建表后失效 Schema 缓存（重复加载时确保下游读到最新结构）
  void invalidateSchemaCache(DEMO_DS_ID);

  return {
    dataSourceId: DEMO_DS_ID,
    tables: datasets.length,
    rows: totalRows,
    knowledgeEntries: report.knowledgeEntries.length,
    ironRules: report.ironRuleTemplates.length,
    vectorChunks: sync.entries.chunks + sync.schema.chunks,
    fewShotSeeded: sync.fewShot.seeded,
    degraded: sync.errors,
  };
}
