/**
 * 金额单位全局偏好 store 测试：全局默认 + 模块覆盖优先级 + 老共享键迁移。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AMOUNT_UNITS,
  AMOUNT_UNIT_DIVISORS,
  LEGACY_AMOUNT_UNIT_KEY,
  isAmountUnit,
  resolveAmountUnit,
  useAmountUnitStore,
} from './useAmountUnitStore';

const resetStore = () => {
  useAmountUnitStore.setState({ globalUnit: '亿元', moduleUnits: {} });
};

describe('useAmountUnitStore: 全局金额单位与模块覆盖', () => {
  beforeEach(() => {
    resetStore();
  });

  it('单位白名单与除数约定（亿 1e8 / 百万 1e6 / 万 1e4 / 元 1）', () => {
    expect(AMOUNT_UNITS).toEqual(['亿元', '百万元', '万元', '元']);
    expect(AMOUNT_UNIT_DIVISORS['亿元']).toBe(100000000);
    expect(AMOUNT_UNIT_DIVISORS['百万元']).toBe(1000000);
    expect(AMOUNT_UNIT_DIVISORS['万元']).toBe(10000);
    expect(AMOUNT_UNIT_DIVISORS['元']).toBe(1);
  });

  it('isAmountUnit 白名单校验', () => {
    for (const u of AMOUNT_UNITS) expect(isAmountUnit(u)).toBe(true);
    expect(isAmountUnit('万亿元')).toBe(false);
    expect(isAmountUnit('')).toBe(false);
    expect(isAmountUnit(undefined)).toBe(false);
  });

  it('默认全局单位为亿元，模块未覆盖时跟随全局', () => {
    expect(useAmountUnitStore.getState().globalUnit).toBe('亿元');
    expect(resolveAmountUnit('query')).toBe('亿元');
    expect(resolveAmountUnit('report')).toBe('亿元');
    expect(resolveAmountUnit('flexquery')).toBe('亿元');
    // v0.9.21 决策数据看板（语义指标直查）纳入模块单位体系
    expect(resolveAmountUnit('dashboard')).toBe('亿元');
  });

  it('全局单位变更后各模块跟随新口径', () => {
    useAmountUnitStore.getState().setGlobalUnit('万元');
    expect(resolveAmountUnit('query')).toBe('万元');
    expect(resolveAmountUnit('report')).toBe('万元');
  });

  it('模块覆盖优先于全局；清除覆盖（空串）后回落全局', () => {
    useAmountUnitStore.getState().setGlobalUnit('亿元');
    useAmountUnitStore.getState().setModuleUnit('query', '元');
    expect(resolveAmountUnit('query')).toBe('元');
    // 其他模块不受影响，仍跟随全局
    expect(resolveAmountUnit('report')).toBe('亿元');
    expect(resolveAmountUnit('flexquery')).toBe('亿元');
    // 清除覆盖 → 回落全局
    useAmountUnitStore.getState().setModuleUnit('query', '');
    expect(resolveAmountUnit('query')).toBe('亿元');
    // 全局变更后被覆盖模块不受影响
    useAmountUnitStore.getState().setModuleUnit('flexquery', '百万元');
    useAmountUnitStore.getState().setGlobalUnit('万元');
    expect(resolveAmountUnit('flexquery')).toBe('百万元');
    expect(resolveAmountUnit('report')).toBe('万元');
  });

  it('v0.9.21 dashboard 模块：覆盖优先于全局，清除后回落全局', () => {
    useAmountUnitStore.getState().setGlobalUnit('亿元');
    useAmountUnitStore.getState().setModuleUnit('dashboard', '元');
    expect(resolveAmountUnit('dashboard')).toBe('元');
    // 其他模块不受影响
    expect(resolveAmountUnit('query')).toBe('亿元');
    useAmountUnitStore.getState().setModuleUnit('dashboard', '');
    expect(resolveAmountUnit('dashboard')).toBe('亿元');
  });

  it('非法单位值被拒绝（全局与模块均不生效）', () => {
    useAmountUnitStore.getState().setGlobalUnit('万亿元' as never);
    expect(useAmountUnitStore.getState().globalUnit).toBe('亿元');
    useAmountUnitStore.getState().setModuleUnit('query', 'YI' as never);
    expect(useAmountUnitStore.getState().moduleUnits.query).toBe('');
  });

  it('老共享键 app-amount-unit 迁移为全局单位并清除老键', async () => {
    localStorage.removeItem('app-amount-unit-prefs');
    localStorage.setItem(LEGACY_AMOUNT_UNIT_KEY, '万元');
    vi.resetModules();
    const mod = await import('./useAmountUnitStore');
    expect(mod.useAmountUnitStore.getState().globalUnit).toBe('万元');
    expect(localStorage.getItem(LEGACY_AMOUNT_UNIT_KEY)).toBeNull();
    localStorage.removeItem('app-amount-unit-prefs');
    vi.resetModules();
  });

  it('老共享键为非法值时回落默认亿元', async () => {
    localStorage.removeItem('app-amount-unit-prefs');
    localStorage.setItem(LEGACY_AMOUNT_UNIT_KEY, '万亿元');
    vi.resetModules();
    const mod = await import('./useAmountUnitStore');
    expect(mod.useAmountUnitStore.getState().globalUnit).toBe('亿元');
    localStorage.removeItem(LEGACY_AMOUNT_UNIT_KEY);
    localStorage.removeItem('app-amount-unit-prefs');
    vi.resetModules();
  });
});
