import { describe, expect, it, vi, beforeEach } from 'vitest';

// 队列式 mock：按 SQL 调用顺序返回预设 [rows, fields]（与 skillLibrary.test.ts 同模式）
const queue: any[] = [];
const querySpy = vi.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('metrics.test: 队列为空，SQL 调用次数超出预期');
  return next;
});
vi.mock('./db', () => ({ getPool: () => ({ query: (...args: any[]) => querySpy(...args) }) }));

import {
  sanitizeMetricInput,
  matchMetrics,
  createMetric,
  updateMetric,
  approveMetric,
  rejectMetric,
  reproposeMetric,
  listMetricVersions,
  restoreMetricVersion,
  loadActiveMetrics,
} from './metrics';

function metricRow(overrides: Record<string, any> = {}) {
  return {
    id: 7,
    data_source_id: 'ds1',
    name: '有效客户数',
    aliases_json: '["有效客户"]',
    description: 'd',
    expr: 'COUNT(DISTINCT id)',
    table_name: 'customer',
    filters: '',
    status: 'ACTIVE',
    version: 2,
    approved_by: 'admin',
    approved_at: '2026-08-21 10:00:00',
    created_by: 'alice',
    ...overrides,
  };
}

const validInput = {
  dataSourceId: 'ds1',
  name: '有效客户数',
  aliases: ['有效客户'],
  description: 'd',
  expr: 'COUNT(DISTINCT id)',
  tableName: 'customer',
  filters: '',
};

beforeEach(() => {
  queue.length = 0;
  querySpy.mockClear();
});

describe('sanitizeMetricInput: 入参校验', () => {
  it('合法输入通过；status 仅接受 ACTIVE/DISABLED（PENDING 由流程驱动）', () => {
    const r = sanitizeMetricInput(validInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.metric.status).toBe('ACTIVE');
    const p = sanitizeMetricInput({ ...validInput, status: 'PENDING' });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.metric.status).toBe('ACTIVE'); // 外部直填 PENDING 被忽略
  });

  it('非法表达式/表名拒绝', () => {
    expect(sanitizeMetricInput({ ...validInput, expr: 'x; DROP TABLE t' }).ok).toBe(false);
    expect(sanitizeMetricInput({ ...validInput, tableName: 'not-valid-name!' }).ok).toBe(false);
  });
});

describe('matchMetrics: 子串命中', () => {
  it('指标名或同义词出现在问题中即命中', () => {
    const m = [{ ...validInput, status: 'ACTIVE' as const }];
    expect(matchMetrics('各机构的有效客户数是多少', m)).toHaveLength(1);
    expect(matchMetrics('统计有效客户总量', m)).toHaveLength(1);
    expect(matchMetrics('拜访次数是多少', m)).toHaveLength(0);
  });
});

describe('P1-8 治理：创建（提议 vs 直接生效）', () => {
  it('ADMIN 创建直接 ACTIVE 且写版本快照', async () => {
    queue.push([[]], [{ insertId: 9 }], [{}]);
    const r = await createMetric({ ...validInput, status: 'ACTIVE' } as any, 'admin', { autoApprove: true });
    expect(r.ok).toBe(true);
    const insertSql = String(querySpy.mock.calls[1][0]);
    expect(insertSql).toContain('metric_definitions');
    expect(String(querySpy.mock.calls[1][1][7])).toBe('ACTIVE');
    // 版本历史快照（recordVersion 参数序：metricId, version, snapshot, action, actor）
    expect(String(querySpy.mock.calls[2][0])).toContain('metric_versions');
    expect(querySpy.mock.calls[2][1][1]).toBe(1);
    expect(querySpy.mock.calls[2][1][3]).toBe('CREATE');
  });

  it('分析师创建为提议 PENDING，不进生产 linking', async () => {
    queue.push([[]], [{ insertId: 10 }], [{}]);
    const r = await createMetric(validInput as any, 'analyst1');
    expect(r.ok).toBe(true);
    expect(String(querySpy.mock.calls[1][1][7])).toBe('PENDING');
    expect(querySpy.mock.calls[1][1][8]).toBe(''); // 未审批无 approved_by
  });

  it('同名指标冲突返回 409 语义', async () => {
    queue.push([[{ id: 1 }]]);
    const r = await createMetric(validInput as any, 'admin', { autoApprove: true });
    expect(r.ok).toBe(false);
  });
});

describe('P1-8 治理：审批 / 驳回 / 重新提议', () => {
  it('approveMetric：PENDING → ACTIVE，记审批人与版本历史', async () => {
    queue.push([[metricRow({ status: 'PENDING', version: 1 })]], [{}], [{}]);
    const r = await approveMetric(7, 'admin');
    expect(r.ok).toBe(true);
    expect(String(querySpy.mock.calls[1][0])).toContain("status = 'ACTIVE'");
    expect(querySpy.mock.calls[1][1][0]).toBe('admin');
    expect(querySpy.mock.calls[2][1][3]).toBe('APPROVE');
  });

  it('approveMetric：非 PENDING 拒绝', async () => {
    queue.push([[metricRow({ status: 'ACTIVE' })]]);
    const r = await approveMetric(7, 'admin');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.status).toBe(400);
  });

  it('rejectMetric：PENDING → REJECTED', async () => {
    queue.push([[metricRow({ status: 'PENDING' })]], [{}]);
    const r = await rejectMetric(7, 'admin');
    expect(r.ok).toBe(true);
    expect(String(querySpy.mock.calls[1][0])).toContain("status = 'REJECTED'");
  });

  it('reproposeMetric：REJECTED → PENDING，其他状态拒绝', async () => {
    queue.push([[metricRow({ status: 'REJECTED' })]], [{}]);
    expect((await reproposeMetric(7, 'analyst1')).ok).toBe(true);
    queue.push([[metricRow({ status: 'ACTIVE' })]]);
    const r = await reproposeMetric(7, 'analyst1');
    expect(r.ok).toBe(false);
  });
});

describe('P1-8 治理：变更留历史与回溯', () => {
  it('updateMetric：version+1 并写 UPDATE 快照；待审批指标不可改', async () => {
    queue.push([[metricRow({ version: 2 })]], [[]], [{}], [{}]);
    const r = await updateMetric(7, { ...validInput, dataSourceId: undefined } as any, 'admin');
    expect(r.ok).toBe(true);
    // UPDATE 语句中 version=3
    expect(String(querySpy.mock.calls[2][0])).toContain('version = ?');
    expect(querySpy.mock.calls[2][1][7]).toBe(3);
    expect(querySpy.mock.calls[3][1][3]).toBe('UPDATE');

    queue.push([[metricRow({ status: 'PENDING' })]]);
    const r2 = await updateMetric(7, { ...validInput } as any, 'admin');
    expect(r2.ok).toBe(false);
  });

  it('listMetricVersions：新到旧返回快照', async () => {
    queue.push([[{ version: 2, action: 'UPDATE', actor: 'admin', created_at: 't2', snapshot_json: JSON.stringify(validInput) }]]);
    const list = await listMetricVersions(7);
    expect(list).toHaveLength(1);
    expect(list[0].version).toBe(2);
    expect(list[0].snapshot.name).toBe('有效客户数');
  });

  it('restoreMetricVersion：应用旧快照并 version+1 记 RESTORE', async () => {
    const snap = { ...validInput, expr: 'COUNT(id)' };
    queue.push(
      [[metricRow({ version: 3 })]],
      [[{ snapshot_json: JSON.stringify(snap) }]],
      [{}],
      [{}]
    );
    const r = await restoreMetricVersion(7, 1, 'admin');
    expect(r.ok).toBe(true);
    const updateCall = querySpy.mock.calls[2][1];
    expect(updateCall[3]).toBe('COUNT(id)'); // expr 回到旧口径
    expect(updateCall[7]).toBe(4); // version 3 → 4
    expect(querySpy.mock.calls[3][1][3]).toBe('RESTORE');
  });

  it('restoreMetricVersion：版本不存在返回 404', async () => {
    queue.push([[metricRow()]], [[]]);
    const r = await restoreMetricVersion(7, 99, 'admin');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.status).toBe(404);
  });
});

describe('生产 linking 只取 ACTIVE', () => {
  it('loadActiveMetrics SQL 强制 status = ACTIVE（未审批指标不进 linking）', async () => {
    queue.push([[]]);
    await loadActiveMetrics('ds1');
    expect(String(querySpy.mock.calls[0][0])).toContain("status = 'ACTIVE'");
  });
});
