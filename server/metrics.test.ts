import { describe, expect, it, vi } from 'vitest';
import {
  sanitizeMetricInput,
  matchMetrics,
  buildMetricPrompt,
  createMetric,
  updateMetric,
  deleteMetric,
  loadActiveMetrics,
  MetricDefinition,
} from './metrics';
import { getPool } from './db';

vi.mock('./db', () => ({ getPool: vi.fn() }));

function mockPool(queryImpl: (...args: any[]) => any) {
  (getPool as any).mockReturnValue({ query: vi.fn(queryImpl) });
}

const baseInput = {
  dataSourceId: 'ds_1',
  name: '有效客户数',
  aliases: ['活跃客户', '在效客户'],
  description: '状态为 active 的客户去重计数',
  expr: 'COUNT(DISTINCT id)',
  tableName: 'clients',
  filters: "status = 'active'",
};

describe('sanitizeMetricInput: 指标输入校验', () => {
  it('合法输入原样通过（字段 trim）', () => {
    const r = sanitizeMetricInput({ ...baseInput, name: ' 有效客户数 ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.metric.name).toBe('有效客户数');
      expect(r.metric.status).toBe('ACTIVE');
      expect(r.metric.aliases).toEqual(['活跃客户', '在效客户']);
    }
  });

  it('缺少必填字段时拒绝', () => {
    expect(sanitizeMetricInput({ ...baseInput, dataSourceId: '' }).ok).toBe(false);
    expect(sanitizeMetricInput({ ...baseInput, name: '' }).ok).toBe(false);
    expect(sanitizeMetricInput({ ...baseInput, expr: '' }).ok).toBe(false);
  });

  it('归属表名必须是合法标识符（防注入拼接）', () => {
    expect(sanitizeMetricInput({ ...baseInput, tableName: 'clients; DROP TABLE x' }).ok).toBe(false);
    expect(sanitizeMetricInput({ ...baseInput, tableName: '1abc' }).ok).toBe(false);
  });

  it('表达式/过滤条件禁止多语句', () => {
    expect(sanitizeMetricInput({ ...baseInput, expr: 'COUNT(*); DELETE FROM clients' }).ok).toBe(false);
    expect(sanitizeMetricInput({ ...baseInput, filters: "status='active'; UPDATE x SET y=1" }).ok).toBe(false);
  });

  it('同义词与指标名相同被拒绝；别名超量截断', () => {
    expect(sanitizeMetricInput({ ...baseInput, aliases: ['有效客户数'] }).ok).toBe(false);
    const many = Array.from({ length: 15 }, (_, i) => `别名${i}`);
    const r = sanitizeMetricInput({ ...baseInput, aliases: many });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.metric.aliases).toHaveLength(10);
  });

  it('status 仅认 DISABLED，其余归一 ACTIVE', () => {
    const r1 = sanitizeMetricInput({ ...baseInput, status: 'DISABLED' });
    const r2 = sanitizeMetricInput({ ...baseInput, status: 'hacked' });
    if (r1.ok) expect(r1.metric.status).toBe('DISABLED');
    if (r2.ok) expect(r2.metric.status).toBe('ACTIVE');
  });
});

describe('matchMetrics: 问题命中匹配', () => {
  const m1: MetricDefinition = { ...baseInput, id: 1, status: 'ACTIVE' };
  const m2: MetricDefinition = { ...baseInput, id: 2, name: '拜访次数', aliases: ['拜访量'], expr: 'COUNT(*)', tableName: 'visits', filters: '', status: 'ACTIVE' };

  it('命中指标名', () => {
    expect(matchMetrics('有效客户数按行业分布', [m1, m2])).toEqual([m1]);
  });

  it('命中同义词', () => {
    expect(matchMetrics('各区域的活跃客户有多少', [m1, m2])).toEqual([m1]);
  });

  it('多指标同时命中', () => {
    expect(matchMetrics('有效客户数与拜访次数的对比', [m1, m2])).toHaveLength(2);
  });

  it('无命中或空问题返回空数组', () => {
    expect(matchMetrics('客户总数是多少', [m1, m2])).toEqual([]);
    expect(matchMetrics('', [m1, m2])).toEqual([]);
  });
});

describe('buildMetricPrompt: 模板化口径注入', () => {
  it('无命中返回空串', () => {
    expect(buildMetricPrompt([])).toBe('');
  });

  it('命中时输出含表达式/归属表/固定过滤的口径段', () => {
    const m: MetricDefinition = { ...baseInput, id: 1, status: 'ACTIVE' };
    const text = buildMetricPrompt([m]);
    expect(text).toContain('语义指标层定义');
    expect(text).toContain("有效客户数（同义词：活跃客户、在效客户） = COUNT(DISTINCT id)，基于表 clients，固定过滤条件：WHERE status = 'active'");
  });

  it('无过滤条件时不输出 WHERE 段', () => {
    const m: MetricDefinition = { ...baseInput, id: 1, filters: '', aliases: [], description: '', status: 'ACTIVE' };
    const text = buildMetricPrompt([m]);
    expect(text).not.toContain('WHERE');
    expect(text).not.toContain('同义词');
  });
});

describe('指标 CRUD（mock pool）', () => {
  it('createMetric：同名冲突拒绝，成功时返回新 ID', async () => {
    mockPool(() => Promise.resolve([[{ id: 7 }]]));
    expect(await createMetric(baseInput as any, 'admin')).toEqual({ ok: false, error: '同名指标已存在' });

    mockPool((sql: string) => {
      if (/^SELECT/.test(sql.trim())) return Promise.resolve([[]]);
      return Promise.resolve([{ insertId: 42 }]);
    });
    expect(await createMetric(baseInput as any, 'admin')).toEqual({ ok: true, id: 42 });
  });

  it('updateMetric：指标不存在返回 notFound', async () => {
    mockPool(() => Promise.resolve([[]]));
    const r = await updateMetric(999, baseInput as any);
    expect(r).toEqual({ ok: false, error: '指标不存在', notFound: true });
  });

  it('deleteMetric：按 affectedRows 判定', async () => {
    mockPool(() => Promise.resolve([{ affectedRows: 1 }]));
    expect(await deleteMetric(1)).toBe(true);
    mockPool(() => Promise.resolve([{ affectedRows: 0 }]));
    expect(await deleteMetric(1)).toBe(false);
  });

  it('loadActiveMetrics：aliases_json 解析容错', async () => {
    mockPool(() =>
      Promise.resolve([
        [
          { id: 1, data_source_id: 'ds_1', name: '客户数', aliases_json: '["客户总量"]', expr: 'COUNT(*)', table_name: 'clients', filters: '', description: '', status: 'ACTIVE', created_by: 'admin' },
          { id: 2, data_source_id: 'ds_1', name: '坏数据', aliases_json: '{broken', expr: 'COUNT(*)', table_name: 'visits', filters: '', description: '', status: 'ACTIVE', created_by: 'admin' },
        ],
      ])
    );
    const list = await loadActiveMetrics('ds_1');
    expect(list[0].aliases).toEqual(['客户总量']);
    expect(list[1].aliases).toEqual([]);
  });
});
