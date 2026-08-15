import { beforeEach, describe, expect, it, vi } from 'vitest';

// 注入假连接池：验证写入参数与读取映射，不依赖真实 MySQL
const queryMock = vi.fn();
vi.mock('./db', () => ({
  getPool: () => ({ query: queryMock }),
}));

import { getTraceSteps, newTraceId, recordTraceStep, TraceMeta } from './queryTrace';

const meta: TraceMeta = { userId: 1, username: 'admin', dataSourceId: 'ds1', question: '总销售额是多少' };

describe('queryTrace', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue([[], []]);
  });

  it('newTraceId 生成 tr_ 前缀且满足路由校验格式', () => {
    const id = newTraceId();
    expect(id).toMatch(/^tr_[A-Za-z0-9_]{6,40}$/);
    expect(newTraceId()).not.toBe(id);
  });

  it('recordTraceStep 写入完整步骤字段并截断超长文本', () => {
    const longText = 'x'.repeat(3000);
    return recordTraceStep('tr_a_b', meta, {
      stepType: 'execution',
      title: '安全执行 SQL',
      inputSummary: longText,
      sqlText: 'SELECT 1',
      rowCount: 3,
      durationMs: 12.6,
    }).then(() => {
      expect(queryMock).toHaveBeenCalledTimes(1);
      const [sql, params] = queryMock.mock.calls[0];
      expect(sql).toContain('INSERT INTO query_trace');
      expect(params[0]).toBe('tr_a_b');
      expect(params[1]).toBe(1);
      expect(params[5]).toBe('execution');
      // input_summary 截断到 1000 字并带省略号
      expect(String(params[7]).length).toBe(1001);
      expect(String(params[7]).endsWith('…')).toBe(true);
      expect(params[9]).toBe('SELECT 1');
      expect(params[10]).toBe(3);
      expect(params[11]).toBe(13); // 四舍五入
      expect(params[12]).toBe('ok');
    });
  });

  it('recordTraceStep 失败状态标记为 fail，缺省数值给默认值', () => {
    return recordTraceStep('tr_a_b', meta, { stepType: 'sql_gen', title: 'SQL 生成', status: 'fail' }).then(() => {
      const [, params] = queryMock.mock.calls[0];
      expect(params[10]).toBe(-1);
      expect(params[11]).toBe(0);
      expect(params[12]).toBe('fail');
    });
  });

  it('recordTraceStep 写库异常不抛出（旁路容错）', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(recordTraceStep('tr_a_b', meta, { stepType: 'analysis', title: 'x' })).resolves.toBeUndefined();
  });

  it('getTraceSteps 空记录返回空链与 null 属主', async () => {
    const r = await getTraceSteps('tr_none');
    expect(r).toEqual({ steps: [], ownerUserId: null });
  });

  it('getTraceSteps 按序映射字段并返回属主用户', async () => {
    queryMock.mockResolvedValueOnce([
      [
        { step_type: 'linking', title: '圈表', input_summary: 'q', output_summary: 't1', sql_text: '', row_count: -1, duration_ms: 10, status: 'ok', user_id: 7, created_at: '2026-08-13' },
        { step_type: 'execution', title: '执行', input_summary: '', output_summary: '', sql_text: 'SELECT 1', row_count: 2, duration_ms: 5, status: 'fail', user_id: 7, created_at: '2026-08-13' },
      ],
      [],
    ]);
    const { steps, ownerUserId } = await getTraceSteps('tr_x');
    expect(ownerUserId).toBe(7);
    expect(steps.length).toBe(2);
    expect(steps[0].stepIndex).toBe(1);
    expect(steps[0].stepType).toBe('linking');
    expect(steps[1].status).toBe('fail');
    expect(steps[1].rowCount).toBe(2);
  });
});
