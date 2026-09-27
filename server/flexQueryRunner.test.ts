/**
 * v0.9.77 P2-15 固定报表服务端执行器单测：Schema 适配 / 配置重建执行分支 / 保存报表重放读取。
 * schemaContext 与 sqlExecutor 以桩替代（隔离数据源加载与执行引擎），buildFlexQuerySql 保留真实
 * 实现，验证「配置 → SQL」集成路径（含维度白名单校验错误透传）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./infra/db', () => ({ getPool: vi.fn() }));
vi.mock('./infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./query/schemaContext', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./query/schemaContext')>();
  return { ...orig, loadSchemaContext: vi.fn() };
});
vi.mock('./query/sqlExecutor', () => ({ executeSafeSql: vi.fn(), dialectOfDsType: vi.fn(), MAX_ROWS: 100000 }));

import { getPool } from './infra/db';
import { loadSchemaContext, type SchemaContext } from './query/schemaContext';
import { dialectOfDsType, executeSafeSql } from './query/sqlExecutor';
import { runFlexQueryConfig, runSavedFlexQuery, toFlexTableSchema } from './flexQueryRunner';
import type { FlexQueryConfig } from '../src/utils/flexQueryBuilder';
import type { SchemaTable } from './query/schemaTypes';

/** 落库 SchemaTable 桩（DB 原生类型 VARCHAR 用于验证归一） */
const schemaTable = (over: Record<string, unknown> = {}): SchemaTable =>
  ({
    name: 'fct_demo',
    displayName: '演示宽表',
    rowCount: 42,
    columns: [
      { name: 'YWFL', type: 'string' },
      { name: 'JE', type: 'number' },
    ],
    ...over,
  }) as unknown as SchemaTable;

/** SchemaContext 桩：缺省 mysql 在线数据源 */
const ctx = (over: Record<string, unknown> = {}): SchemaContext =>
  ({
    schema: [schemaTable()],
    guidance: '',
    status: 'connected',
    dsType: 'mysql',
    sensitiveRemoved: [],
    allowIntrospection: false,
    rowFilters: {},
    dataSourceName: '演示数据源',
    fileBacked: false,
    ...over,
  }) as unknown as SchemaContext;

/** 最小合法配置：fct_demo 单维度 + SUM(JE) */
const config = (over: Partial<FlexQueryConfig> = {}): FlexQueryConfig => ({
  table: 'fct_demo',
  dimensions: ['YWFL'],
  measures: [{ column: 'JE', agg: 'SUM' }],
  filters: [],
  havings: [],
  orderBys: [],
  limit: 100,
  ...over,
});

/** executeSafeSql 成功返回（行集可定制） */
const execOk = (rows: Record<string, unknown>[] = [{ YWFL: 'A', sum_je: 10 }]) => ({
  ok: true as const,
  result: { rows, rowCount: rows.length, truncated: false, finalSql: 'SELECT 1' },
});

/** getPool 桩：runSavedFlexQuery 读取 flex_queries 行 */
const poolReturning = (rows: unknown[]) => {
  const query = vi.fn(async () => [rows]);
  vi.mocked(getPool).mockReturnValue({ query } as never);
  return query;
};

beforeEach(() => {
  vi.mocked(getPool).mockReset();
  vi.mocked(loadSchemaContext).mockReset();
  vi.mocked(dialectOfDsType).mockReset();
  vi.mocked(executeSafeSql).mockReset();
});

describe('toFlexTableSchema：落库 SchemaTable → 前端 TableSchema', () => {
  it('字段映射与列类型归一（DB 原生类型/未知类型 → string）', () => {
    const out = toFlexTableSchema(
      schemaTable({
        id: 't-1',
        columns: [
          { name: 'A', type: 'number', description: '金额', isMetric: true },
          { name: 'B', type: 'VARCHAR' },
          { name: 'C', type: 'category', isDimension: true },
          { name: 'D', type: 'date' },
        ],
      }),
    );
    expect(out.id).toBe('t-1');
    expect(out.name).toBe('fct_demo');
    expect(out.displayName).toBe('演示宽表');
    expect(out.rowCount).toBe(42);
    expect(out.columns.map((c) => c.type)).toEqual(['number', 'string', 'category', 'date']);
    expect(out.columns[0].isMetric).toBe(true);
    expect(out.columns[2].isDimension).toBe(true);
    expect(out.columns[1].isMetric).toBe(false);
  });

  it('缺省兜底：id/displayName 回退 name、rowCount 非数字 → 0、columns 缺失 → 空数组', () => {
    const out = toFlexTableSchema({ name: 't2', rowCount: 'x', columns: [{ name: 'C1' }] } as unknown as SchemaTable);
    expect(out.id).toBe('t2');
    expect(out.displayName).toBe('t2');
    expect(out.description).toBe('');
    expect(out.rowCount).toBe(0);
    expect(out.columns[0].type).toBe('string');
    const empty = toFlexTableSchema({ name: 't3' } as unknown as SchemaTable);
    expect(empty.columns).toEqual([]);
  });
});

describe('runFlexQueryConfig：配置重建执行', () => {
  it('入参守卫：空数据源 / 缺失配置直接拒绝（不触达 Schema 加载）', async () => {
    expect(await runFlexQueryConfig('', config())).toEqual({ ok: false, error: '固定报表未绑定数据源' });
    expect(await runFlexQueryConfig('ds-1', null as never)).toEqual({ ok: false, error: '查询配置缺失' });
    expect(loadSchemaContext).not.toHaveBeenCalled();
  });

  it('Schema 加载抛错 → 收敛为执行失败（不向外抛）', async () => {
    vi.mocked(loadSchemaContext).mockRejectedValue(new Error('boom'));
    const out = await runFlexQueryConfig('ds-1', config());
    expect(out.ok).toBe(false);
    if (out.ok !== true) expect(out.error).toBe('固定报表执行失败');
  });

  it('数据源停用 / 非实时执行类型 → 拒绝', async () => {
    vi.mocked(loadSchemaContext).mockResolvedValue(ctx({ status: 'disconnected' }));
    expect(await runFlexQueryConfig('ds-1', config())).toEqual({ ok: false, error: '该数据源已被管理员停用' });
    vi.mocked(loadSchemaContext).mockResolvedValue(ctx({ dsType: 'csv', fileBacked: false }));
    expect(await runFlexQueryConfig('ds-1', config())).toEqual({ ok: false, error: '该数据源类型不支持服务端执行' });
  });

  it('主表不在 Schema → 明确提示表名', async () => {
    vi.mocked(loadSchemaContext).mockResolvedValue(ctx());
    expect(await runFlexQueryConfig('ds-1', config({ table: 'nope' }))).toEqual({
      ok: false,
      error: '数据表「nope」不在数据源 Schema 中',
    });
  });

  it('buildFlexQuerySql 校验失败 → 错误原文透传（维度列不在表）', async () => {
    vi.mocked(loadSchemaContext).mockResolvedValue(ctx());
    const out = await runFlexQueryConfig('ds-1', config({ dimensions: ['nope'] }));
    expect(out.ok).toBe(false);
    if (out.ok !== true) expect(out.error).toContain('不存在于该表');
  });

  it('pg 方言：双引号标识符（方言透传 SQL 生成）', async () => {
    vi.mocked(loadSchemaContext).mockResolvedValue(ctx({ dsType: 'postgresql' }));
    vi.mocked(dialectOfDsType).mockReturnValue('pg');
    vi.mocked(executeSafeSql).mockResolvedValue(execOk());
    await runFlexQueryConfig('ds-1', config());
    expect(vi.mocked(executeSafeSql).mock.calls[0][1]).toContain('"fct_demo"');
  });

  it('成功路径：默认 maxRows=MAX_ROWS / scenario=export，敏感列与行过滤透传', async () => {
    vi.mocked(loadSchemaContext).mockResolvedValue(ctx({ sensitiveRemoved: ['SECRET'], rowFilters: { fct_demo: 'org_id = 1' } }));
    vi.mocked(dialectOfDsType).mockReturnValue('mysql');
    vi.mocked(executeSafeSql).mockResolvedValue(execOk());
    const out = await runFlexQueryConfig('ds-1', config());
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.columns).toEqual(['YWFL', 'sum_je']);
      expect(out.data.rowCount).toBe(1);
      expect(out.data.truncated).toBe(false);
    }
    expect(executeSafeSql).toHaveBeenCalledWith(
      'ds-1',
      expect.stringContaining('`fct_demo`'),
      expect.any(Array),
      ['SECRET'],
      100000,
      { fct_demo: 'org_id = 1' },
      'export',
    );
  });

  it('opts 定制：maxRows/scenario 透传执行层', async () => {
    vi.mocked(loadSchemaContext).mockResolvedValue(ctx());
    vi.mocked(dialectOfDsType).mockReturnValue('mysql');
    vi.mocked(executeSafeSql).mockResolvedValue(execOk([{ a: 1 }, { a: 2 }]));
    const out = await runFlexQueryConfig('ds-1', config(), { maxRows: 50, scenario: 'interactive' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.rowCount).toBe(2);
    expect(executeSafeSql).toHaveBeenCalledWith('ds-1', expect.any(String), expect.any(Array), [], 50, {}, 'interactive');
  });

  it('执行层失败 → 原因透传；空结果集 → columns 为空数组', async () => {
    vi.mocked(loadSchemaContext).mockResolvedValue(ctx());
    vi.mocked(executeSafeSql).mockResolvedValue({ ok: false, reason: 'SQL 含禁止语句' });
    const blocked = await runFlexQueryConfig('ds-1', config());
    expect(blocked.ok).toBe(false);
    if (blocked.ok !== true) expect(blocked.error).toBe('SQL 含禁止语句');
    vi.mocked(executeSafeSql).mockResolvedValue(execOk([]));
    const empty = await runFlexQueryConfig('ds-1', config());
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.data.columns).toEqual([]);
      expect(empty.data.rowCount).toBe(0);
    }
  });
});

describe('runSavedFlexQuery：按 queryId 重放执行', () => {
  const savedRow = (queryData: string, dataSourceId = 'ds-1') => ({
    query_id: 'flex-1',
    data_source_id: dataSourceId,
    query_data: queryData,
  });

  it('行不存在 → notFound 标记（调用方 404）', async () => {
    poolReturning([]);
    expect(await runSavedFlexQuery('flex-1')).toEqual({ ok: false, error: '固定报表不存在', notFound: true });
  });

  it('读取抛错 / query_data 坏 JSON → 读取失败', async () => {
    vi.mocked(getPool).mockReturnValue({
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as never);
    const out = await runSavedFlexQuery('flex-1');
    expect(out.ok).toBe(false);
    if (out.ok !== true) expect(out.error).toBe('固定报表读取失败');
    poolReturning([savedRow('{bad json')]);
    const out2 = await runSavedFlexQuery('flex-1');
    expect(out2.ok).toBe(false);
    if (out2.ok !== true) expect(out2.error).toBe('固定报表读取失败');
  });

  it('query_data 缺 config → 明确拒绝（不触达执行）', async () => {
    poolReturning([savedRow(JSON.stringify({ name: 'X' }))]);
    expect(await runSavedFlexQuery('flex-1')).toEqual({ ok: false, error: '固定报表缺少查询配置' });
  });

  it('成功路径：执行链 + meta（name/dataSourceId），opts 透传', async () => {
    poolReturning([savedRow(JSON.stringify({ name: '月度报表', dataSourceId: 'ds-fallback', config: config() }))]);
    vi.mocked(loadSchemaContext).mockResolvedValue(ctx());
    vi.mocked(dialectOfDsType).mockReturnValue('mysql');
    vi.mocked(executeSafeSql).mockResolvedValue(execOk());
    const out = await runSavedFlexQuery('flex-1', { maxRows: 50 });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.name).toBe('月度报表');
      expect(out.data.dataSourceId).toBe('ds-1');
      expect(out.data.rowCount).toBe(1);
    }
    expect(executeSafeSql).toHaveBeenCalledWith('ds-1', expect.any(String), expect.any(Array), [], 50, {}, 'export');
  });

  it('data_source_id 为空 → 回退 query_data.dataSourceId', async () => {
    poolReturning([savedRow(JSON.stringify({ name: 'X', dataSourceId: 'ds-fallback', config: config() }), '')]);
    vi.mocked(loadSchemaContext).mockResolvedValue(ctx());
    vi.mocked(dialectOfDsType).mockReturnValue('mysql');
    vi.mocked(executeSafeSql).mockResolvedValue(execOk());
    const out = await runSavedFlexQuery('flex-1');
    expect(out.ok).toBe(true);
    expect(loadSchemaContext).toHaveBeenCalledWith('ds-fallback', undefined);
  });
});
