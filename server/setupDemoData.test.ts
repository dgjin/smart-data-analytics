/**
 * v0.9.86 向导 Phase 2 演示数据集单测（server/setupDemoData.ts）：
 * 确定性行生成（固定种子，两次调用完全一致）/ 表规格与 schema 转换 / Step① 检测 /
 * 加载编排（建表 3 张 → 数据源 UPSERT → 治理配置 → 向量化）与 counters 汇总 / Embedding 降级不阻断。
 * mock 约定与 setupWizard.test.ts 一致（vi.mock infra / 建表 / autoConfig / knowledgeSync）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const querySpy = vi.fn();
vi.mock('./infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));
vi.mock('./infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const createFileTableMock = vi.fn();
vi.mock('./query/fileDataSource', () => ({ createFileTable: (...args: unknown[]) => createFileTableMock(...args) }));
vi.mock('./query/schemaContext', () => ({ invalidateSchemaCache: vi.fn() }));
const executeAutoConfigMock = vi.fn();
vi.mock('./datasource/autoConfig', () => ({ executeAutoConfig: (...args: unknown[]) => executeAutoConfigMock(...args) }));
const runAutoKnowledgeSyncMock = vi.fn();
vi.mock('./knowledge/autoKnowledgeSync', () => ({ runAutoKnowledgeSync: (...args: unknown[]) => runAutoKnowledgeSyncMock(...args) }));

import {
  DEMO_DS_CONFIG,
  DEMO_DS_ID,
  DEMO_DS_NAME,
  DEMO_TABLE_SPECS,
  demoInventoryRows,
  demoMarketingRows,
  demoSalesRows,
  isDemoDataSetLoaded,
  loadDemoDataSet,
  toSchemaTable,
} from './setupDemoData';

beforeEach(() => {
  querySpy.mockReset();
});

describe('确定性样本行生成（固定种子 LCG）', () => {
  it('销量表：18 月 × 4 区 × 3 渠道 × 4 类目 = 864 行；两次调用完全一致', () => {
    const a = demoSalesRows();
    const b = demoSalesRows();
    expect(a).toHaveLength(864);
    expect(b).toEqual(a);
    expect(a[0]?.slice(0, 4)).toEqual(['2025-01-15', '华东', '线上电商', '智能硬件']);
    expect(a[a.length - 1]?.[0]).toBe('2026-06-15');
    for (const row of [a[0], a[a.length - 1]]) {
      expect(Number(row?.[4])).toBeGreaterThan(0); // revenue
      expect(Number(row?.[5])).toBeGreaterThanOrEqual(1); // orders
      expect(Number(row?.[6])).toBeGreaterThan(0); // profit
    }
  });

  it('营销表：6 活动 × 5 平台 = 30 行；ROI/消耗为正', () => {
    const rows = demoMarketingRows();
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r[0])).size).toBe(6);
    expect(new Set(rows.map((r) => r[1])).size).toBe(5);
    for (const r of rows) {
      expect(Number(r[2])).toBeGreaterThan(0); // cost
      expect(Number(r[6])).toBeGreaterThan(0); // roi
    }
  });

  it('库存表：8 商品 × 4 仓库 = 32 行；SKU 唯一且编号连续', () => {
    const rows = demoInventoryRows();
    expect(rows).toHaveLength(32);
    const skus = rows.map((r) => String(r[0]));
    expect(new Set(skus).size).toBe(32);
    expect(skus[0]).toBe('SKU-DEMO-3001');
    expect(skus[31]).toBe('SKU-DEMO-3032');
  });
});

describe('表规格与 schema 转换', () => {
  it('3 张表：物理表名匹配 upl_ 白名单；行数据列数与列定义逐一一致', () => {
    expect(DEMO_TABLE_SPECS).toHaveLength(3);
    for (const spec of DEMO_TABLE_SPECS) {
      expect(spec.physical).toMatch(/^upl_[a-z0-9_]+$/);
      const rows = spec.rows();
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r).toHaveLength(spec.columns.length);
      for (const c of spec.columns) expect(['TEXT', 'DOUBLE']).toContain(c.sqlType);
    }
  });

  it('DEMO_DS_CONFIG：physicalTable 锚点 + physicalTables 全量（供 fileBacked 判定与删除级联）', () => {
    expect(DEMO_DS_CONFIG.physicalTable).toBe(DEMO_TABLE_SPECS[0]?.physical);
    expect(DEMO_DS_CONFIG.physicalTables).toEqual(DEMO_TABLE_SPECS.map((s) => s.physical));
    expect(DEMO_DS_CONFIG.demo).toBe(true);
  });

  it('toSchemaTable：与接入链路同构 + 维度/指标/主键标记透传', () => {
    const spec = DEMO_TABLE_SPECS[2]!;
    const t = toSchemaTable(spec, 32);
    expect(t).toMatchObject({ id: `tbl_${spec.physical}`, name: spec.physical, displayName: spec.displayName, rowCount: 32 });
    const sku = (t.columns ?? []).find((c) => c.name === 'product_sku');
    expect(sku?.isPrimaryKey).toBe(true);
    expect((t.columns ?? []).find((c) => c.name === 'stock_qty')?.isMetric).toBe(true);
    expect((t.columns ?? []).find((c) => c.name === 'warehouse')?.isDimension).toBe(true);
  });
});

describe('isDemoDataSetLoaded：Step① 环境自检判定', () => {
  it('行存在 → true；不存在 → false；查询固定 ID', async () => {
    querySpy.mockResolvedValue([[{ hit: 1 }]]);
    expect(await isDemoDataSetLoaded()).toBe(true);
    expect(querySpy).toHaveBeenCalledWith(expect.stringContaining('FROM data_sources WHERE id = ?'), [DEMO_DS_ID]);

    querySpy.mockResolvedValue([[]]);
    expect(await isDemoDataSetLoaded()).toBe(false);
  });
});

describe('loadDemoDataSet：加载编排（建表 → 注册 → 治理 → 向量化）', () => {
  const syncOk = {
    entries: { docs: 2, chunks: 5, pruned: 0 },
    schema: { docs: 3, chunks: 3, pruned: 0 },
    fewShot: { seeded: 4, skipped: 1 },
    errors: [] as string[],
  };

  beforeEach(() => {
    createFileTableMock.mockReset().mockResolvedValue(undefined);
    executeAutoConfigMock.mockReset().mockReturnValue({
      dataSourceId: DEMO_DS_ID,
      analysisSummary: [],
      capabilities: { timeSeriesRecalc: { enabled: true } },
      ironRuleTemplates: [{ title: '铁律A', content: 'c1' }],
      knowledgeEntries: [
        { title: '数据源概览', content: 'x', category: '自动生成', tags: ['a'] },
        { title: '口径说明', content: 'y', category: '自动生成', tags: ['b'] },
      ],
      suggestions: [],
    });
    runAutoKnowledgeSyncMock.mockReset().mockResolvedValue(syncOk);
    querySpy.mockResolvedValue([{ affectedRows: 1 }]);
  });

  it('全链路成功 → counters 汇总 + 进度三段 + 幂等 SQL', async () => {
    const progress: string[] = [];
    const result = await loadDemoDataSet('admin', async (t) => {
      progress.push(t);
    });

    // 建表 3 张：表名/列数/行数与规格一致
    expect(createFileTableMock).toHaveBeenCalledTimes(3);
    const firstCall = createFileTableMock.mock.calls[0] as unknown[];
    expect(firstCall[0]).toBe(DEMO_TABLE_SPECS[0]?.physical);
    expect(firstCall[1]).toHaveLength(DEMO_TABLE_SPECS[0]!.columns.length);
    expect(firstCall[2]).toEqual(DEMO_TABLE_SPECS[0]?.columns.map((c) => c.sqlType));
    expect(firstCall[3]).toHaveLength(864);

    // 数据源注册：UPSERT 幂等（ON DUPLICATE KEY UPDATE）+ 固定 ID/名称
    const upsertCall = querySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO data_sources'));
    expect(String(upsertCall?.[0])).toContain('ON DUPLICATE KEY UPDATE');
    const upsertParams = upsertCall?.[1] as unknown[];
    expect(upsertParams[0]).toBe(DEMO_DS_ID);
    expect(upsertParams[1]).toBe(DEMO_DS_NAME);

    // 治理配置：能力画像 UPDATE + 知识骨架 2 条 + 铁律 1 条（均确定性键幂等）
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes('anomaly_capabilities_json'))).toBe(true);
    const kbInserts = querySpy.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO knowledge_base_entries'));
    expect(kbInserts).toHaveLength(2);
    expect(String(kbInserts[0]?.[0])).toContain('ON DUPLICATE KEY UPDATE');
    expect((kbInserts[0]?.[1] as unknown[])[0]).toBe(`kb_auto_${DEMO_DS_ID}_1`);
    expect(querySpy.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO iron_rules'))).toHaveLength(1);

    // 向量化入口参数（表结构数组为 3 张表）
    expect(runAutoKnowledgeSyncMock).toHaveBeenCalledWith(DEMO_DS_ID, DEMO_DS_NAME, expect.any(Array), 'admin', expect.any(Array));
    const syncTables = runAutoKnowledgeSyncMock.mock.calls[0]?.[2] as unknown[];
    expect(syncTables).toHaveLength(3);

    // 进度三段按序上报
    expect(progress).toHaveLength(3);
    expect(progress[0]).toContain('步骤 1/3');
    expect(progress[2]).toContain('步骤 3/3');

    // 汇总数字：864+30+32=926 行；向量块 5+3=8
    expect(result).toEqual({
      dataSourceId: DEMO_DS_ID,
      tables: 3,
      rows: 926,
      knowledgeEntries: 2,
      ironRules: 1,
      vectorChunks: 8,
      fewShotSeeded: 4,
      degraded: [],
    });
  });

  it('Embedding 降级（sync.errors 非空）→ 整体仍成功，degraded 如实透出', async () => {
    runAutoKnowledgeSyncMock.mockResolvedValue({
      ...syncOk,
      entries: { docs: 0, chunks: 0, pruned: 0 },
      schema: { docs: 0, chunks: 0, pruned: 0 },
      fewShot: { seeded: 0, skipped: 0 },
      errors: ['知识条目向量入库失败：model not found'],
    });
    const result = await loadDemoDataSet('admin', async () => undefined);
    expect(result.degraded).toEqual(['知识条目向量入库失败：model not found']);
    expect(result.rows).toBe(926);
    expect(result.vectorChunks).toBe(0);
  });
});
