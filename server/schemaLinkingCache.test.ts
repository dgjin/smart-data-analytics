import { describe, expect, it, beforeEach, vi } from 'vitest';

// mock embedding 远程调用：验证缓存命中/失效语义，不发真实请求
vi.mock('./llmClient', () => ({
  callEmbedding: vi.fn(async () => [1, 0]),
  callEmbeddingBatch: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
}));

import { callEmbedding, callEmbeddingBatch } from './llmClient';
import {
  selectRelevantTablesAsync,
  pruneWideTableColumnsAsync,
  clearSchemaLinkingCachesForTest,
  WIDE_TABLE_COLUMN_THRESHOLD,
} from './schemaLinking';

/**
 * P2-3 schemaLinking embedding 缓存版本号测试：
 * 缓存 key = 表名/列名 + sha1(digest) 前 16 位内容指纹（替代旧的 digest 截断前缀）。
 * 验收：编辑数据源 schema（digest 覆盖内容）后旧向量自动失效——按表/列粒度仅重算被编辑项；
 * 回归：digest 前 200 字符相同、之后不同的两张表不得共享缓存键（旧截断方案的碰撞缺陷）。
 */

const embedMock = vi.mocked(callEmbedding);
const batchMock = vi.mocked(callEmbeddingBatch);

beforeEach(() => {
  clearSchemaLinkingCachesForTest();
  embedMock.mockClear();
  batchMock.mockClear();
});

function makeTable(name: string, displayName: string, opts: { description?: string; businessNote?: string; colDescs?: string[] } = {}) {
  return {
    name,
    displayName,
    description: opts.description ?? '',
    businessNote: opts.businessNote ?? '',
    columns: (opts.colDescs ?? []).map((d, i) => ({ name: `col_${i}`, description: d })),
  };
}

/** 批量请求收集的全部文本（跨多次调用展开） */
function batchedTexts(): string[] {
  return batchMock.mock.calls.flatMap((c) => c[0] as string[]);
}

describe('selectRelevantTablesAsync: 表摘要向量缓存', () => {
  const schema = () => [
    makeTable('t1', '客户表', { colDescs: ['客户类型'] }),
    makeTable('t2', '订单表', { colDescs: ['订单金额'] }),
    makeTable('f1', '无关一'),
    makeTable('f2', '无关二'),
    makeTable('f3', '无关三'),
  ];

  it('schema 不变时第二次调用全部缓存命中（零新增 embedding 请求）', async () => {
    await selectRelevantTablesAsync(schema(), '客户类型与订单金额', 4);
    expect(batchMock).toHaveBeenCalledTimes(1);
    expect(batchedTexts()).toHaveLength(5); // 5 张候选表一次批量

    batchMock.mockClear();
    await selectRelevantTablesAsync(schema(), '客户类型与订单金额', 4);
    expect(batchMock).not.toHaveBeenCalled(); // 全部命中
  });

  it('编辑单表描述后仅该表向量重算（按表粒度自动失效）', async () => {
    await selectRelevantTablesAsync(schema(), '客户类型与订单金额', 4);
    batchMock.mockClear();

    const edited = schema().map((t) => (t.name === 't1' ? { ...t, description: '新增：含客户分层信息' } : t));
    await selectRelevantTablesAsync(edited, '客户类型与订单金额', 4);
    expect(batchMock).toHaveBeenCalledTimes(1);
    const texts = batchedTexts();
    expect(texts).toHaveLength(1); // 仅被编辑的 t1 未命中
    expect(texts[0]).toContain('新增：含客户分层信息');
  });

  it('回归：digest 前 200 字符相同、之后不同的表不共享缓存键（修复截断碰撞）', async () => {
    const sharedHead = '长描述'.repeat(60); // 180 字，超出旧方案 200 字符截断点的主体
    const t1 = makeTable('t1', '报表甲', { description: sharedHead, businessNote: '口径甲' });
    const t2 = makeTable('t2', '报表乙', { description: sharedHead, businessNote: '口径乙' });
    const fillers = [makeTable('f1', '无关一'), makeTable('f2', '无关二'), makeTable('f3', '无关三')];
    await selectRelevantTablesAsync([t1, t2, ...fillers], '报表口径', 4);
    expect(batchedTexts()).toHaveLength(5); // 两表各自独立计算，未因键碰撞而共享

    // 编辑 t2 超出旧截断点的尾部内容（businessNote）：新方案指纹变化重算，旧方案键不变将陈旧命中
    batchMock.mockClear();
    const t2Edited = { ...t2, businessNote: '口径乙-修订' };
    await selectRelevantTablesAsync([t1, t2Edited, ...fillers], '报表口径', 4);
    const texts = batchedTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('口径乙-修订');
  });
});

describe('pruneWideTableColumnsAsync: 列摘要向量缓存', () => {
  function makeWideTable(descMap: Record<number, string> = {}) {
    return {
      name: 'fin',
      displayName: '财务宽表',
      columns: Array.from({ length: WIDE_TABLE_COLUMN_THRESHOLD + 10 }, (_, i) => ({
        name: `col_${i}`,
        type: 'string',
        description: descMap[i] ?? `字段${i}`,
      })),
    };
  }

  it('列缓存命中后第二次调用零新增请求；编辑单列描述仅重算该列', async () => {
    const wide = makeWideTable({ 10: '投放金额' });
    await pruneWideTableColumnsAsync([wide], '投放金额');
    const firstTexts = batchedTexts();
    expect(firstTexts.length).toBeGreaterThan(0);
    expect(firstTexts.some((t) => t.includes('投放金额'))).toBe(true);

    batchMock.mockClear();
    await pruneWideTableColumnsAsync([makeWideTable({ 10: '投放金额' })], '投放金额');
    expect(batchMock).not.toHaveBeenCalled(); // 全部命中

    // 编辑 col_10 描述：仅该列指纹变化 → 只重算 1 段文本
    batchMock.mockClear();
    await pruneWideTableColumnsAsync([makeWideTable({ 10: '投放金额（含税）' })], '投放金额');
    const texts = batchedTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('投放金额（含税）');
  });
});
