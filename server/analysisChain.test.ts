/**
 * M3 中间表清洗链单测：复杂度评估解析、敏感列剔除、列类型推断、
 * 链编排、物化（配额/敏感列）、应用库 SQL 校验、TTL 清理。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('./db', () => ({ getPool: () => ({ query: queryMock }) }));
vi.mock('./sqlExecutor', async () => {
  const actual: any = await vi.importActual('./sqlExecutor');
  return { ...actual, executeSafeSql: vi.fn() };
});
vi.mock('./llmClient', () => ({ callLLMJson: vi.fn(), sqlStageRoute: () => null }));

import {
  parseAssessment,
  hasMultiStepSignal,
  assessComplexity,
  pickSafeColumns,
  inferColumnType,
  extractAitRefs,
  executeOnAppDb,
  materializeIntermediateTable,
  runAnalysisChain,
  cleanupExpiredIntermediateTables,
  describeIntermediateTables,
} from './analysisChain';
import { executeSafeSql } from './sqlExecutor';
import { callLLMJson } from './llmClient';

/** 按 SQL 关键词路由的 mock：模拟 mysql2 pool.query */
function routeMock(handlers: { match: RegExp; result: (sql: string, params?: any) => any }[]) {
  queryMock.mockImplementation(async (sqlOrOpts: any, params?: any) => {
    const sql = typeof sqlOrOpts === 'string' ? sqlOrOpts : String(sqlOrOpts?.sql || '');
    for (const h of handlers) {
      if (h.match.test(sql)) return h.result(sql, params);
    }
    throw new Error(`未预期的 SQL: ${sql}`);
  });
}

beforeEach(() => {
  queryMock.mockReset();
});

describe('parseAssessment', () => {
  it('合法 multi-step 输出被解析（步骤上限 3、非法步骤剔除）', () => {
    const text = JSON.stringify({
      complexity: 'multi-step',
      steps: [
        { purpose: '去重', sql: 'SELECT DISTINCT * FROM t' },
        { purpose: '过滤异常', sql: 'SELECT * FROM t WHERE amount > 0' },
        { purpose: '危险', sql: 'DROP TABLE t' },
        { purpose: '缺SQL' },
        { purpose: '多余', sql: 'SELECT 1' },
      ],
    });
    const a = parseAssessment(text);
    expect(a.complexity).toBe('multi-step');
    // 前 3 步中「危险」（非 SELECT）被剔除，剩 2 步
    expect(a.steps).toHaveLength(2);
    expect(a.steps.every((s) => /^select/i.test(s.sql))).toBe(true);
  });

  it('simple/非法输出一律按 simple 处理', () => {
    expect(parseAssessment(JSON.stringify({ complexity: 'simple' })).complexity).toBe('simple');
    expect(parseAssessment('garbage').complexity).toBe('simple');
    expect(parseAssessment(JSON.stringify({ complexity: 'multi-step', steps: [] })).complexity).toBe('simple');
  });
});

describe('hasMultiStepSignal / assessComplexity 预门控', () => {
  it('识别多步清洗信号（正例/反例）', () => {
    expect(hasMultiStepSignal('先去重再统计各机构投放金额')).toBe(true);
    expect(hasMultiStepSignal('剔除异常值后的逾期余额')).toBe(true);
    expect(hasMultiStepSignal('对金额做标准化后分组')).toBe(true);
    expect(hasMultiStepSignal('各机构本年投放金额排名')).toBe(false);
    expect(hasMultiStepSignal('')).toBe(false);
  });

  it('无清洗信号时不调 LLM 直接判 simple', async () => {
    (callLLMJson as any).mockClear();
    const a = await assessComplexity('各机构本年投放金额排名', []);
    expect(a).toEqual({ complexity: 'simple', steps: [] });
    expect(callLLMJson).not.toHaveBeenCalled();
  });

  it('有信号或 force 时走 LLM 评估', async () => {
    (callLLMJson as any).mockResolvedValue(JSON.stringify({ complexity: 'simple' }));
    await assessComplexity('先去重再统计', []);
    expect(callLLMJson).toHaveBeenCalledTimes(1);
    await assessComplexity('普通问题', [], { force: true });
    expect(callLLMJson).toHaveBeenCalledTimes(2);
  });
});

describe('敏感列剔除与列类型推断', () => {
  it('pickSafeColumns 剔除敏感列（裸名匹配）与非法标识符', () => {
    const rows = [{ id: 1, phone: '138', 'bad-name': 1, team: 'A' }];
    expect(pickSafeColumns(rows, ['tbl.phone', 'id_card'])).toEqual(['id', 'team']);
  });

  it('inferColumnType 数值占多为 DOUBLE，否则 TEXT', () => {
    const rows = [
      { amount: 10, name: 'a' },
      { amount: '20.5', name: 'b' },
      { amount: 30, name: 'c' },
    ];
    expect(inferColumnType(rows, 'amount')).toBe('DOUBLE');
    expect(inferColumnType(rows, 'name')).toBe('TEXT');
  });
});

describe('extractAitRefs / executeOnAppDb', () => {
  it('提取 ait_* 引用', () => {
    expect(extractAitRefs('SELECT * FROM ait_abc JOIN ait_def ON 1=1')).toEqual(['ait_abc', 'ait_def']);
    expect(extractAitRefs('SELECT * FROM tbl_visits')).toEqual([]);
  });

  it('拒绝未注册中间表、非 SELECT、混入源表', async () => {
    const reg = new Set(['ait_ok']);
    expect((await executeOnAppDb('SELECT * FROM ait_bad', reg)).ok).toBe(false);
    expect((await executeOnAppDb('DELETE FROM ait_ok', reg)).ok).toBe(false);
    expect((await executeOnAppDb('SELECT * FROM ait_ok JOIN tbl_visits ON 1=1', reg)).ok).toBe(false);
    expect((await executeOnAppDb('', reg)).ok).toBe(false);
  });

  it('合法查询执行并补齐 LIMIT', async () => {
    routeMock([{ match: /^select/i, result: () => [[{ a: 1 }]] }]);
    const res = await executeOnAppDb('SELECT a FROM ait_ok', new Set(['ait_ok']));
    expect(res.ok).toBe(true);
    if (res.ok === true) {
      expect(res.result.rows).toEqual([{ a: 1 }]);
      expect(res.result.finalSql).toMatch(/LIMIT 500$/i);
    }
  });
});

describe('materializeIntermediateTable', () => {
  const meta = { userId: 1, dataSourceId: 'ds_a', traceId: 'tr_x', purpose: '去重清洗' };

  it('建表/写入/注册且剔除敏感列', async () => {
    const executed: string[] = [];
    routeMock([
      { match: /SELECT id, table_name .*analysis_intermediate_tables/, result: () => [[]] }, // 配额检查：无存量
      { match: /^CREATE TABLE/i, result: (sql) => { executed.push(sql); return [{}]; } },
      { match: /^INSERT INTO `ait_/i, result: (_sql, params) => { executed.push(`INSERT:${JSON.stringify(params[0])}`); return [{}]; } },
      { match: /INSERT INTO analysis_intermediate_tables/, result: () => [{}] },
    ]);
    const info = await materializeIntermediateTable(
      [{ team: 'A', amount: 10, phone: '138' }],
      meta,
      ['phone']
    );
    expect(info).not.toBeNull();
    expect(info!.tableName).toMatch(/^ait_/);
    expect(info!.columns).toEqual(['team', 'amount']);
    const create = executed.find((s) => s.startsWith('CREATE'));
    expect(create).toContain('`team` TEXT');
    expect(create).toContain('`amount` DOUBLE');
    expect(create).not.toContain('phone');
    // 写入值不含敏感列
    const insert = executed.find((s) => s.startsWith('INSERT:'));
    expect(insert).toBe('INSERT:[["A",10]]');
  });

  it('空结果返回 null', async () => {
    expect(await materializeIntermediateTable([], meta)).toBeNull();
  });

  it('超出配额删除最旧中间表', async () => {
    const dropped: string[] = [];
    routeMock([
      {
        match: /SELECT id, table_name .*analysis_intermediate_tables/,
        result: () => [Array.from({ length: 10 }, (_, i) => ({ id: `id${i}`, table_name: `ait_old${i}` }))],
      },
      { match: /^DROP TABLE/i, result: (sql) => { dropped.push(sql); return [{}]; } },
      { match: /^DELETE FROM analysis_intermediate_tables/, result: () => [{}] },
      { match: /^CREATE TABLE/i, result: () => [{}] },
      { match: /^INSERT INTO `ait_/i, result: () => [{}] },
      { match: /INSERT INTO analysis_intermediate_tables/, result: () => [{}] },
    ]);
    await materializeIntermediateTable([{ x: 1 }], meta);
    expect(dropped.length).toBe(1);
    expect(dropped[0]).toContain('ait_old0');
  });
});

describe('runAnalysisChain', () => {
  it('逐步执行：成功落表，失败步骤留痕不阻断', async () => {
    (executeSafeSql as any)
      .mockResolvedValueOnce({ ok: true, result: { rows: [{ team: 'A', n: 1 }], rowCount: 1, truncated: false, finalSql: 'SELECT team, COUNT(*) n FROM t GROUP BY team LIMIT 5000' } })
      .mockResolvedValueOnce({ ok: false, reason: 'SQL 引用了问数范围外的表' });
    routeMock([
      { match: /SELECT id, table_name .*analysis_intermediate_tables/, result: () => [[]] },
      { match: /^CREATE TABLE/i, result: () => [{}] },
      { match: /^INSERT INTO `ait_/i, result: () => [{}] },
      { match: /INSERT INTO analysis_intermediate_tables/, result: () => [{}] },
    ]);
    const traces: any[] = [];
    const out = await runAnalysisChain({
      question: 'q',
      dataSourceId: 'ds_a',
      schema: [],
      sensitiveRemoved: [],
      assessment: {
        complexity: 'multi-step',
        steps: [
          { purpose: '聚合清洗', sql: 'SELECT team, COUNT(*) n FROM t GROUP BY team' },
          { purpose: '非法步', sql: 'SELECT * FROM secret' },
        ],
      },
      userId: 1,
      traceId: 'tr_x',
      onTrace: (s) => traces.push(s),
    });
    expect(out.tables).toHaveLength(1);
    expect(out.stepSummaries[0].ok).toBe(true);
    expect(out.stepSummaries[1].ok).toBe(false);
    expect(traces.some((t) => t.stepType === 'intermediate' && t.status === 'fail')).toBe(true);
    expect(traces.some((t) => t.stepType === 'intermediate' && t.status !== 'fail')).toBe(true);
  });
});

describe('cleanupExpiredIntermediateTables', () => {
  it('删除过期注册并 DROP 物理表', async () => {
    const dropped: string[] = [];
    routeMock([
      { match: /WHERE expires_at <= NOW/, result: () => [[{ id: 'i1', table_name: 'ait_exp1' }]] },
      { match: /^DROP TABLE/i, result: (sql) => { dropped.push(sql); return [{}]; } },
      { match: /^DELETE FROM analysis_intermediate_tables/, result: () => [{}] },
    ]);
    const n = await cleanupExpiredIntermediateTables();
    expect(n).toBe(1);
    expect(dropped[0]).toContain('ait_exp1');
  });
});

describe('describeIntermediateTables', () => {
  it('生成 prompt 描述段落，空列表返回空串', () => {
    expect(describeIntermediateTables([])).toBe('');
    const text = describeIntermediateTables([
      { id: 'x', tableName: 'ait_x', purpose: '去重', columns: ['a', 'b'], rowCount: 10 },
    ]);
    expect(text).toContain('ait_x');
    expect(text).toContain('去重');
    expect(text).toContain('a, b');
  });
});
