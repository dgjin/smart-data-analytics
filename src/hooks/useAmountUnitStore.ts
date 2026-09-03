/**
 * 金额单位全局偏好 store（zustand + persist）：
 * - globalUnit：全局默认单位（Header 全局选择器维护），各模块默认跟随该口径分析统计；
 * - moduleUnits：模块级覆盖（query 问数 / report 报表 / flexquery 灵活查询），
 *   模块内选择具体单位后按模块单位生效，优先级高于全局；'' 或缺省表示跟随全局。
 *
 * 迁移：老 localStorage 键 app-amount-unit（v0.5.1 问数页引入的共享键）一次性并入
 * globalUnit 初始值并清除老键，避免双写分叉；zustand persist 数据存在时以其为准。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const AMOUNT_UNITS = ['亿元', '百万元', '万元', '元'] as const;
export type AmountUnit = (typeof AMOUNT_UNITS)[number];

/** 单位换算除数（与后端 server/liveQuery.ts AMOUNT_UNIT_OPTIONS 保持一致） */
export const AMOUNT_UNIT_DIVISORS: Record<AmountUnit, number> = {
  亿元: 100000000,
  百万元: 1000000,
  万元: 10000,
  元: 1,
};

/** 支持模块级金额单位覆盖的模块标识（dashboard = 决策数据看板·语义指标直查，v0.9.21 起） */
export type AmountUnitModule = 'query' | 'report' | 'flexquery' | 'dashboard';

/** 老版本问数页共享键（迁移来源） */
export const LEGACY_AMOUNT_UNIT_KEY = 'app-amount-unit';

export function isAmountUnit(v: unknown): v is AmountUnit {
  return (AMOUNT_UNITS as readonly string[]).includes(String(v));
}

/** 读取老共享键作为全局单位初始值，随后清除老键（存储不可用时静默回落默认亿元） */
function readLegacyGlobalUnit(): AmountUnit {
  try {
    const v = localStorage.getItem(LEGACY_AMOUNT_UNIT_KEY);
    if (isAmountUnit(v)) {
      localStorage.removeItem(LEGACY_AMOUNT_UNIT_KEY);
      return v;
    }
  } catch {
    // 存储不可用时使用默认
  }
  return '亿元';
}

interface AmountUnitState {
  /** 全局默认金额单位（各模块跟随） */
  globalUnit: AmountUnit;
  /** 模块级覆盖：缺省/'' 表示跟随全局 */
  moduleUnits: Partial<Record<AmountUnitModule, AmountUnit | ''>>;
  setGlobalUnit: (u: AmountUnit) => void;
  setModuleUnit: (m: AmountUnitModule, u: AmountUnit | '') => void;
}

export const useAmountUnitStore = create<AmountUnitState>()(
  persist(
    (set) => ({
      globalUnit: readLegacyGlobalUnit(),
      moduleUnits: {},
      setGlobalUnit: (u) => {
        if (isAmountUnit(u)) set({ globalUnit: u });
      },
      setModuleUnit: (m, u) =>
        set((s) => ({
          moduleUnits: { ...s.moduleUnits, [m]: u === '' || isAmountUnit(u) ? u : '' },
        })),
    }),
    { name: 'app-amount-unit-prefs' },
  ),
);

/** 解析模块生效单位（React 响应式 hook）：模块覆盖优先，未覆盖时跟随全局 */
export function useEffectiveAmountUnit(module: AmountUnitModule): AmountUnit {
  return useAmountUnitStore((s) => s.moduleUnits[module] || s.globalUnit);
}

/** 非组件环境（事件回调/纯函数）读取模块生效单位：getState 实时读取，无闭包过期问题 */
export function resolveAmountUnit(module: AmountUnitModule): AmountUnit {
  const s = useAmountUnitStore.getState();
  return s.moduleUnits[module] || s.globalUnit;
}
