/**
 * 数据源自动化知识同步单测（v0.9.83 开箱即用闭环）：
 * 覆盖断点1（条目→RAG）/断点2（Schema→RAG）/断点3（样例种子）的纯函数与同步入口，
 * 以及统一入口 runAutoKnowledgeSync 的「单步失败不阻断其余」容错聚合。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_FEWSHOT_SEEDS,
  MAX_SCHEMA_DOCS,
  autoEntryDocId,
  buildSchemaFewShotExamples,
  buildSchemaTableDoc,
  runAutoKnowledgeSync,
  schemaTableDocId,
  seedSchemaFewShotExamples,
  stableHash8,
  syncKnowledgeEntriesToRag,
  syncSchemaMetadataToRag,
} from './autoKnowledgeSync';
import { getPool } from '../infra/db';
import { saveKnowledgeDoc } from './knowledgeBase';
import { createSqlExample } from '../query/queryFeedback';
import type { SchemaTable } from '../query/schemaTypes';

vi.mock('../infra/db', () => ({ getPool: vi.fn() }));
vi.mock('../infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./knowledgeBase', () => ({ saveKnowledgeDoc: vi.fn() }));
vi.mock('../query/queryFeedback', () => ({
  normalizeSql: (sql: string) => String(sql || '').replace(/\s+/g, ' ').trim(),
  createSqlExample: vi.fn(),
}));

/** 通用池 mock：handler 返回值非 undefined 时优先使用，否则默认「空结果」；返回 query 供断言 */
function mockPool(handler?: (sql: string, params?: unknown[]) => unknown) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const out = handler ? handler(sql, params) : undefined;
    if (out !== undefined) return out;
    if (String(sql).includes('SELECT DISTINCT doc_id')) return [[]];
    return [[{ cnt: 0 }]];
  });
  (getPool as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({ query });
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  (saveKnowledgeDoc as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
    docId: 'x',
    chunkCount: 2,
  });
  (createSqlExample as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({});
});

/** 时序 + 维度 + 指标 + 业务编号（借贷场景典型表） */
const loanTable: SchemaTable = {
  name: 'report_loan_data',
  displayName: '贷款数据表',
  description: '每日贷款明细报表',
  businessNote: '仅含已核销前的存量数据',
  rowCount: 12000,
  columns: [
    { name: 'dt', type: 'date', description: '数据日期', isDimension: true },
    { name: 'team', type: 'category', description: '所属分行', isDimension: true },
    { name: 'amt', type: 'number', description: '贷款余额', isMetric: true },
    { name: 'contract_no', type: 'string', description: '合同编号' },
  ],
};

/** 快照表（表名含 snapshot） */
const snapshotTable: SchemaTable = {
  name: 'balance_snapshot',
  displayName: '余额快照表',
  columns: [
    { name: 'snap_date', type: 'date', description: '快照日期', isDimension: true },
    { name: 'balance_amt', type: 'number', description: '余额', isMetric: true },
  ],
};

/** 版本字段表（bb 列触发版本过滤范式） */
const versionTable: SchemaTable = {
  name: 'risk_month_report',
  displayName: '风险月报',
  columns: [
    { name: 'bb', type: 'string', description: '版本（1=正式）' },
    { name: 'risk_amt', type: 'number', description: '风险金额', isMetric: true },
  ],
};

describe('stableHash8 / doc_id：确定性幂等标识', () => {
  it('同输入同输出且为 8 位十六进制', () => {
    expect(stableHash8('report_loan_data')).toBe(stableHash8('report_loan_data'));
    expect(stableHash8('report_loan_data')).toMatch(/^[0-9a-f]{8}$/);
    expect(stableHash8('a')).not.toBe(stableHash8('b'));
  });

  it('条目 doc_id 带 autokb_ 前缀、幂等、长度 ≤ 64（超长数据源截断）', () => {
    const id = autoEntryDocId('ds_1786620486498', '指标口径-贷款余额');
    expect(id).toBe(autoEntryDocId('ds_1786620486498', '指标口径-贷款余额'));
    expect(id.startsWith('autokb_ds_1786620486498_')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(autoEntryDocId('d'.repeat(200), '标题').length).toBeLessThanOrEqual(64);
    // 数据源隔离：同标题不同数据源不冲突
    expect(autoEntryDocId('ds_a', '标题')).not.toBe(autoEntryDocId('ds_b', '标题'));
  });

  it('表结构 doc_id 带 autosch_ 前缀、长度 ≤ 64', () => {
    const id = schemaTableDocId('ds_1786620486498', 'report_loan_data');
    expect(id).toBe(schemaTableDocId('ds_1786620486498', 'report_loan_data'));
    expect(id.startsWith('autosch_')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(64);
  });
});

describe('buildSchemaTableDoc: 表结构知识文档（断点 2）', () => {
  it('标题含表名与业务名，内容含说明/口径/规模/列角色清单', () => {
    const doc = buildSchemaTableDoc(loanTable, '数据资源库');
    expect(doc).not.toBeNull();
    expect(doc?.title).toBe('表结构-report_loan_data-贷款数据表');
    const content = doc?.content || '';
    expect(content).toContain('数据源：数据资源库');
    expect(content).toContain('表说明：每日贷款明细报表');
    expect(content).toContain('业务口径：仅含已核销前的存量数据');
    expect(content).toContain('数据规模：约 12000 行');
    expect(content).toContain('- dt｜维度｜数据日期');
    expect(content).toContain('- team｜维度｜所属分行');
    expect(content).toContain('- amt｜指标｜贷款余额');
    expect(content).toContain('- contract_no｜合同编号');
  });

  it('displayName 与表名相同不重复拼接', () => {
    const doc = buildSchemaTableDoc({ name: 't1', displayName: 't1', columns: [{ name: 'c', type: 'string' }] });
    expect(doc?.title).toBe('表结构-t1');
  });

  it('无列/空表名返回 null，不产生空文档', () => {
    expect(buildSchemaTableDoc({ name: 'empty', columns: [] })).toBeNull();
    expect(buildSchemaTableDoc({ name: '  ', columns: [{ name: 'c', type: 'string' }] })).toBeNull();
  });
});

describe('buildSchemaFewShotExamples: 样例种子六类范式（断点 3）', () => {
  it('无表返回空数组', () => {
    expect(buildSchemaFewShotExamples([])).toEqual([]);
  });

  it('时序趋势范式：日期分组 + 指标 SUM', () => {
    const seeds = buildSchemaFewShotExamples([loanTable]);
    expect(seeds.some((s) => s.sql === 'SELECT dt, SUM(amt) AS total FROM report_loan_data GROUP BY dt ORDER BY dt')).toBe(true);
  });

  it('维度排名范式：分组 + 指标降序 LIMIT 10', () => {
    const seeds = buildSchemaFewShotExamples([loanTable]);
    expect(seeds.some((s) => s.sql === 'SELECT team, SUM(amt) AS total FROM report_loan_data GROUP BY team ORDER BY total DESC LIMIT 10')).toBe(true);
  });

  it('业务编号去重计数范式：COUNT(DISTINCT ...)', () => {
    const seeds = buildSchemaFewShotExamples([loanTable]);
    expect(seeds.some((s) => s.sql === 'SELECT COUNT(DISTINCT contract_no) AS total FROM report_loan_data')).toBe(true);
  });

  it('快照最新期范式：MAX 子查询锁定', () => {
    const seeds = buildSchemaFewShotExamples([snapshotTable]);
    expect(
      seeds.some((s) => s.sql === 'SELECT COUNT(*) AS total FROM balance_snapshot WHERE snap_date = (SELECT MAX(snap_date) FROM balance_snapshot)')
    ).toBe(true);
  });

  it('版本过滤范式：正式版本条件', () => {
    const seeds = buildSchemaFewShotExamples([versionTable]);
    expect(seeds.some((s) => s.sql === "SELECT COUNT(*) AS total FROM risk_month_report WHERE BB = '1'")).toBe(true);
  });

  it('基础计数兜底：结构极简表至少产生 1 条可执行样例', () => {
    const seeds = buildSchemaFewShotExamples([{ name: 'plain_table', columns: [{ name: 'id', type: 'number', isPrimaryKey: true }] }]);
    expect(seeds.length).toBeGreaterThanOrEqual(1);
    expect(seeds.some((s) => s.sql === 'SELECT COUNT(*) AS total FROM plain_table')).toBe(true);
  });

  it('重复表输入去重，同 SQL 只保留一条', () => {
    const seeds = buildSchemaFewShotExamples([loanTable, loanTable]);
    const trend = seeds.filter((s) => s.sql.includes('FROM report_loan_data') && s.sql.includes('GROUP BY dt'));
    expect(trend.length).toBe(1);
  });

  it('种子数不超过上限且全部为 SELECT、引用真实表名', () => {
    const seeds = buildSchemaFewShotExamples([loanTable, snapshotTable, versionTable]);
    expect(seeds.length).toBeLessThanOrEqual(MAX_FEWSHOT_SEEDS);
    expect(seeds.length).toBeGreaterThanOrEqual(5);
    const tableNames = ['report_loan_data', 'balance_snapshot', 'risk_month_report'];
    for (const s of seeds) {
      expect(s.sql).toMatch(/^select\b/i);
      expect(tableNames.some((t) => s.sql.includes(t))).toBe(true);
      expect(s.question.length).toBeGreaterThan(0);
    }
  });
});

describe('syncKnowledgeEntriesToRag: 断点 1 条目向量入库', () => {
  it('确定性 doc_id 先删后写，返回块数统计', async () => {
    const query = mockPool();
    const out = await syncKnowledgeEntriesToRag(
      'ds_test',
      [
        { title: '指标定义', content: 'amt 为贷款余额', category: 'metric', tags: ['指标'] },
        { title: '业务口径', content: 'bb=1 为正式版本', category: 'caliber', tags: [] },
      ],
      'admin'
    );
    expect(out).toEqual({ docs: 2, chunks: 4, pruned: 0 });
    const docId = autoEntryDocId('ds_test', '指标定义');
    expect(query).toHaveBeenCalledWith('DELETE FROM knowledge_base WHERE doc_id = ? AND data_source_id = ?', [docId, 'ds_test']);
    expect(saveKnowledgeDoc).toHaveBeenCalledWith('ds_test', '指标定义', 'amt 为贷款余额', 'admin', docId);
  });

  it('前缀下已不存在的旧 doc_id 被清理', async () => {
    const staleDocId = 'autokb_ds_test_deadbeef';
    const query = mockPool((sql) => {
      if (String(sql).includes('SELECT DISTINCT doc_id')) return [[{ doc_id: staleDocId }]];
    });
    const out = await syncKnowledgeEntriesToRag('ds_test', [{ title: '新标题', content: 'c', category: 'x', tags: [] }], 'admin');
    expect(out.pruned).toBe(1);
    expect(query).toHaveBeenCalledWith('DELETE FROM knowledge_base WHERE doc_id = ?', [staleDocId]);
  });
});

describe('syncSchemaMetadataToRag: 断点 2 Schema 向量入库', () => {
  it('按表生成文档入库，无列表跳过', async () => {
    mockPool();
    const out = await syncSchemaMetadataToRag('ds_test', '数据资源库', [loanTable, { name: 'empty_table', columns: [] }], 'admin');
    expect(out).toEqual({ docs: 1, chunks: 2, pruned: 0 });
    expect(saveKnowledgeDoc).toHaveBeenCalledWith(
      'ds_test',
      '表结构-report_loan_data-贷款数据表',
      expect.stringContaining('report_loan_data'),
      'admin',
      schemaTableDocId('ds_test', 'report_loan_data')
    );
  });

  it('超过 MAX_SCHEMA_DOCS 张表时截断（防拖慢接入）', async () => {
    mockPool();
    const many: SchemaTable[] = Array.from({ length: MAX_SCHEMA_DOCS + 5 }, (_, i) => ({
      name: `t_${i}`,
      columns: [{ name: 'c', type: 'string' }],
    }));
    const out = await syncSchemaMetadataToRag('ds_test', 'n', many, 'admin');
    expect(out.docs).toBe(MAX_SCHEMA_DOCS);
  });
});

describe('seedSchemaFewShotExamples: 断点 3 样例种子', () => {
  it('已存在的样例跳过，新样例以 IMPORT 来源写入', async () => {
    let dupCall = 0;
    mockPool((sql) => {
      if (String(sql).includes('FROM sql_examples')) {
        dupCall++;
        return [[{ cnt: dupCall === 1 ? 1 : 0 }]];
      }
    });
    const out = await seedSchemaFewShotExamples('ds_test', [loanTable], 'admin');
    expect(out).toEqual({ seeded: 2, skipped: 1 });
    expect(createSqlExample).toHaveBeenCalledTimes(2);
    expect(createSqlExample).toHaveBeenCalledWith(
      expect.objectContaining({ dataSourceId: 'ds_test', question: expect.any(String), sql: expect.any(String) }),
      'admin',
      'IMPORT'
    );
  });
});

describe('runAutoKnowledgeSync: 统一入口容错', () => {
  it('单步失败不阻断其余步骤，错误聚合并返回', async () => {
    mockPool();
    (saveKnowledgeDoc as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(
      new Error('embedding 服务超时')
    );
    const result = await runAutoKnowledgeSync('ds_test', '数据资源库', [loanTable], 'admin', [
      { title: 't1', content: 'c1', category: 'x', tags: [] },
    ]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('知识条目向量入库失败');
    // Schema 向量化与样例种子不受第一步失败影响
    expect(result.schema.docs).toBe(1);
    expect(result.fewShot.seeded + result.fewShot.skipped).toBeGreaterThan(0);
  });

  it('全部成功时返回三步统计且无错误', async () => {
    mockPool();
    const result = await runAutoKnowledgeSync('ds_test', '数据资源库', [loanTable, snapshotTable], 'admin', [
      { title: 't1', content: 'c1', category: 'x', tags: [] },
      { title: 't2', content: 'c2', category: 'y', tags: [] },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual({ docs: 2, chunks: 4, pruned: 0 });
    expect(result.schema).toEqual({ docs: 2, chunks: 4, pruned: 0 });
    expect(result.fewShot.seeded + result.fewShot.skipped).toBeGreaterThan(0);
  });
});
