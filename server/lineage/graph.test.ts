import { describe, expect, it } from 'vitest';
import { buildLineageGraph, type LineageGraph, type LineageGraphInput, type LineageDsInput } from './graph';
import { tablesOfSql } from './sqlRefs';

const dsNpa: LineageDsInput = {
  id: 'ds-1',
  name: '数据资源',
  type: 'greenplum',
  lastSyncedAt: '2026-09-20T00:00:00.000Z',
  tables: [{ name: 'fct_jc_asset' }, { name: 'fct_jc_finance' }, { name: 'dim_org' }],
};

const dsCrm: LineageDsInput = {
  id: 'ds-2',
  name: '客户经营',
  type: 'mysql',
  tables: [{ name: 'orders' }, { name: 'customers' }],
};

const emptyInput: LineageGraphInput = { dataSources: [], reports: [], widgets: [], metrics: [] };

function edgeOf(graph: LineageGraph, from: string, to: string, kind: string) {
  return graph.edges.find((e) => e.from === from && e.to === to && e.kind === kind);
}

describe('tablesOfSql', () => {
  it('提取 FROM/JOIN 表名（去库名前缀与引号，小写去重）', () => {
    const sql = 'SELECT a.id FROM `crm`.`orders` o LEFT JOIN customers c ON o.cid = c.id';
    expect(tablesOfSql(sql).sort()).toEqual(['customers', 'orders']);
  });

  it('排除 CTE 名与系统表（dual）', () => {
    const sql = 'WITH slim AS (SELECT * FROM fct_jc_asset) SELECT * FROM slim JOIN dual';
    const refs = tablesOfSql(sql);
    expect(refs).toContain('fct_jc_asset');
    expect(refs).not.toContain('slim');
    expect(refs).not.toContain('dual');
  });

  it('剥离注释与字符串字面量中的伪表名', () => {
    const sql = "SELECT 1 FROM orders -- from fake_table\n WHERE name = 'from evil_table'";
    expect(tablesOfSql(sql)).toEqual(['orders']);
  });
});

describe('buildLineageGraph', () => {
  it('报表 executedSqls 解析出 parsed 消费边 + 数据源结构边', () => {
    const graph = buildLineageGraph({
      ...emptyInput,
      dataSources: [dsCrm],
      reports: [
        {
          id: 'r1',
          title: '客户经营简报',
          dataSourceId: 'ds-2',
          createdAt: '2026-09-21T00:00:00.000Z',
          sqls: ['SELECT a FROM orders o JOIN customers c ON o.cid = c.id'],
        },
      ],
    });

    // 节点：数据源 + 两张表 + 报表
    expect(graph.nodes.find((n) => n.id === 'ds:ds-2')).toBeTruthy();
    expect(graph.nodes.find((n) => n.id === 'tbl:ds-2:orders')).toBeTruthy();
    expect(graph.nodes.find((n) => n.id === 'tbl:ds-2:customers')).toBeTruthy();
    expect(graph.nodes.find((n) => n.id === 'report:r1')).toBeTruthy();

    // 结构边（contains）+ 消费边（consumes, parsed）
    expect(edgeOf(graph, 'ds:ds-2', 'tbl:ds-2:orders', 'contains')).toBeTruthy();
    const consume = edgeOf(graph, 'tbl:ds-2:orders', 'report:r1', 'consumes');
    expect(consume?.sourceType).toBe('parsed');
    expect(consume?.status).toBe('active');
    expect(consume?.evidence).toContain('报表 SQL #1');

    // 数据源计数回填
    const dsNode = graph.nodes.find((n) => n.id === 'ds:ds-2');
    expect(dsNode?.meta?.tablesReferenced).toBe(2);

    // 统计：parsed=2 / declared=0 / 覆盖率 1
    expect(graph.stats.parsedEdges).toBe(2);
    expect(graph.stats.declaredEdges).toBe(0);
    expect(graph.stats.staleEdges).toBe(0);
    expect(graph.stats.parseCoverage).toBe(1);
  });

  it('无 SQL 报表生成 declared 声明边（待验证）', () => {
    const graph = buildLineageGraph({
      ...emptyInput,
      dataSources: [dsNpa],
      reports: [{ id: 'r2', title: '演示简报', dataSourceId: 'ds-1', createdAt: '2026-09-10T00:00:00.000Z', sqls: [] }],
    });
    const edge = edgeOf(graph, 'ds:ds-1', 'report:r2', 'consumes');
    expect(edge?.sourceType).toBe('declared');
    expect(edge?.status).toBe('active');
    expect(graph.stats.declaredEdges).toBe(1);
    expect(graph.stats.parseCoverage).toBe(0);
  });

  it('SQL 引用不在 Schema 的表 → stale 边 + unresolved 节点', () => {
    const graph = buildLineageGraph({
      ...emptyInput,
      dataSources: [dsCrm],
      reports: [
        { id: 'r3', title: '旧报表', dataSourceId: 'ds-2', sqls: ['SELECT * FROM legacy_table'] },
      ],
    });
    const tableNode = graph.nodes.find((n) => n.id === 'tbl:ds-2:legacy_table');
    expect(tableNode?.meta?.unresolved).toBe(true);
    const edge = edgeOf(graph, 'tbl:ds-2:legacy_table', 'report:r3', 'consumes');
    expect(edge?.status).toBe('stale');
    expect(graph.stats.staleEdges).toBe(1);
    // unresolved 表不建 contains 结构边
    expect(edgeOf(graph, 'ds:ds-2', 'tbl:ds-2:legacy_table', 'contains')).toBeFalsy();
  });

  it('出厂内置图表（无 dataSourceId 无 SQL）按数据资源库特征推演归属', () => {
    const graph = buildLineageGraph({
      ...emptyInput,
      dataSources: [dsCrm, dsNpa],
      widgets: [{ id: 'widget-1', title: '逐月投放金额走势', chartType: 'area' }],
    });
    const edge = edgeOf(graph, 'ds:ds-1', 'widget:widget-1', 'consumes');
    expect(edge?.sourceType).toBe('declared');
    expect(edge?.evidence).toContain('数据资源库推演');
    // 按推演结果回填节点归属
    expect(graph.nodes.find((n) => n.id === 'widget:widget-1')?.dataSourceId).toBe('ds-1');
  });

  it('缺 dataSourceId 的图表按 SQL 引用表匹配推演数据源', () => {
    const graph = buildLineageGraph({
      ...emptyInput,
      dataSources: [dsNpa, dsCrm],
      widgets: [
        {
          id: 'widget-9',
          title: '订单数趋势',
          sql: 'SELECT COUNT(*) FROM orders',
        },
      ],
    });
    const edge = edgeOf(graph, 'tbl:ds-2:orders', 'widget:widget-9', 'consumes');
    expect(edge?.sourceType).toBe('parsed');
    expect(edge?.status).toBe('active');
    expect(graph.nodes.find((n) => n.id === 'widget:widget-9')?.dataSourceId).toBe('ds-2');
  });

  it('指标归属表建立 derives 边；失配表标记 stale', () => {
    const graph = buildLineageGraph({
      ...emptyInput,
      dataSources: [dsNpa],
      metrics: [
        { id: '11', name: '本年投放金额', dataSourceId: 'ds-1', tableName: 'fct_jc_asset', expr: 'SUM(tfje)', status: 'ACTIVE' },
        { id: '12', name: '失配指标', dataSourceId: 'ds-1', tableName: 'missing_table' },
      ],
    });
    const active = edgeOf(graph, 'tbl:ds-1:fct_jc_asset', 'metric:11', 'derives');
    expect(active?.sourceType).toBe('parsed');
    expect(active?.status).toBe('active');
    const stale = edgeOf(graph, 'tbl:ds-1:missing_table', 'metric:12', 'derives');
    expect(stale?.status).toBe('stale');
    // 指标节点 meta 保留表达式与状态（前端展示）
    const metricNode = graph.nodes.find((n) => n.id === 'metric:11');
    expect(metricNode?.meta?.expr).toBe('SUM(tfje)');
    expect(metricNode?.meta?.metricStatus).toBe('ACTIVE');
  });

  it('空输入返回空图且覆盖率为 1（无消费边）', () => {
    const graph = buildLineageGraph(emptyInput, '2026-09-24T00:00:00.000Z');
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.stats.parseCoverage).toBe(1);
    expect(graph.generatedAt).toBe('2026-09-24T00:00:00.000Z');
  });

  it('报表 dataSourceId 指向已删除数据源时按 SQL 推演并保持节点可见', () => {
    const graph = buildLineageGraph({
      ...emptyInput,
      dataSources: [dsNpa],
      reports: [
        {
          id: 'r9',
          title: '跨源报表',
          dataSourceId: 'ds-removed',
          sqls: ['SELECT * FROM fct_jc_finance'],
        },
      ],
    });
    const edge = edgeOf(graph, 'tbl:ds-1:fct_jc_finance', 'report:r9', 'consumes');
    expect(edge?.sourceType).toBe('parsed');
    expect(graph.nodes.find((n) => n.id === 'report:r9')?.dataSourceId).toBe('ds-1');
  });

  it('同一报表多条 SQL 引用同一表只建一条边（去重）', () => {
    const graph = buildLineageGraph({
      ...emptyInput,
      dataSources: [dsCrm],
      reports: [
        {
          id: 'r5',
          title: '多图报表',
          dataSourceId: 'ds-2',
          sqls: ['SELECT * FROM orders', 'SELECT o.id FROM orders o JOIN customers c ON o.cid = c.id'],
        },
      ],
    });
    const consumeEdges = graph.edges.filter(
      (e) => e.to === 'report:r5' && e.sourceType === 'parsed',
    );
    expect(consumeEdges).toHaveLength(2); // orders + customers，各一条
    expect(graph.stats.parsedEdges).toBe(2);
  });
});
