import { describe, expect, it } from 'vitest';
import { parseMysqlTableStats, parsePgTableStats, buildDataVersion } from './dataVersion';

describe('dataVersion: 数据版本指纹（v0.4.8 自主更新探测层）', () => {
  it('parseMysqlTableStats 归一化 information_schema 结果并按表名排序', () => {
    const out = parseMysqlTableStats([
      { TABLE_NAME: 'b_table', TABLE_ROWS: 20, UPDATE_TIME: '2026-08-18 10:00:00' },
      { TABLE_NAME: 'a_table', TABLE_ROWS: 10, CREATE_TIME: '2026-08-01 09:00:00' },
      null,
      { TABLE_ROWS: 5 }, // 无表名行应被过滤
    ]);
    expect(out).toEqual([
      { name: 'a_table', rows: 10, ts: '2026-08-01 09:00:00' },
      { name: 'b_table', rows: 20, ts: '2026-08-18 10:00:00' },
    ]);
  });

  it('parsePgTableStats 归一化 pg_stat_user_tables 结果（行数 + vacuum/analyze 时间戳）', () => {
    const out = parsePgTableStats([
      { relname: 't2', n_live_tup: 3, mx_ts: '2026-08-19 00:30:00' },
      { relname: 't1', n_live_tup: null, mx_ts: null },
      {},
    ]);
    expect(out).toEqual([
      { name: 't1', rows: 0, ts: '' },
      { name: 't2', rows: 3, ts: '2026-08-19 00:30:00' },
    ]);
  });

  it('buildDataVersion 对相同统计生成稳定指纹', () => {
    const tables = parseMysqlTableStats([{ TABLE_NAME: 't', TABLE_ROWS: 1 }]);
    expect(buildDataVersion(tables)).toBe(buildDataVersion([...tables]));
  });

  it('buildDataVersion 行数变化 → 指纹变化', () => {
    const v1 = buildDataVersion(parseMysqlTableStats([{ TABLE_NAME: 't', TABLE_ROWS: 1 }]));
    const v2 = buildDataVersion(parseMysqlTableStats([{ TABLE_NAME: 't', TABLE_ROWS: 2 }]));
    expect(v1).not.toBe(v2);
  });

  it('buildDataVersion 更新时间变化（INSERT 新增数据场景）→ 指纹变化', () => {
    const v1 = buildDataVersion(
      parseMysqlTableStats([{ TABLE_NAME: 't', TABLE_ROWS: 0, UPDATE_TIME: null }])
    );
    const v2 = buildDataVersion(
      parseMysqlTableStats([{ TABLE_NAME: 't', TABLE_ROWS: 2, UPDATE_TIME: '2026-08-19 00:31:39' }])
    );
    expect(v1).not.toBe(v2);
  });

  it('buildDataVersion 空库返回 null（前端跳过自动更新）', () => {
    expect(buildDataVersion([])).toBeNull();
  });
});
