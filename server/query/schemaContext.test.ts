/**
 * v0.9.34 分流判定单测：isLiveCapableType 统一收口问数/计划/报表/异步任务 7 处分流点
 * （数据库型真实执行；文件型须已落物理表 fileBacked 才走真实执行，否则演示模式）。
 * 仅覆盖纯判定函数，不触碰真实数据库与缓存。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../infra/db', () => ({ getPool: vi.fn() }));
vi.mock('../infra/stateStore', () => ({ getStateStore: vi.fn() }));

import { isLiveCapableType } from './schemaContext';

describe('isLiveCapableType: 真实执行能力统一判定', () => {
  it('数据库型（mysql/postgresql/greenplum）直接具备真实执行能力', () => {
    expect(isLiveCapableType('mysql')).toBe(true);
    expect(isLiveCapableType('postgresql')).toBe(true);
    expect(isLiveCapableType('greenplum')).toBe(true);
  });

  it('文件型（csv/json/excel）未落库时不具备真实执行能力', () => {
    for (const t of ['csv', 'json', 'excel']) expect(isLiveCapableType(t)).toBe(false);
    expect(isLiveCapableType('excel', false)).toBe(false);
    expect(isLiveCapableType('excel', undefined)).toBe(false);
  });

  it('文件型已落库（fileBacked=true）放行真实执行', () => {
    expect(isLiveCapableType('csv', true)).toBe(true);
    expect(isLiveCapableType('excel', true)).toBe(true);
  });

  it('demo/api/null/undefined 永不真实执行（fileBacked 也不放行未知类型语义）', () => {
    expect(isLiveCapableType('demo')).toBe(false);
    expect(isLiveCapableType('api')).toBe(false);
    expect(isLiveCapableType(null)).toBe(false);
    expect(isLiveCapableType(undefined)).toBe(false);
    // fileBacked 为 true 时判定仅按布尔放行（调用方保证 fileBacked 仅对文件型置真）
    expect(isLiveCapableType('demo', true)).toBe(true);
  });
});
