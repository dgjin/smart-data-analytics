import React from 'react';
import { Coins } from 'lucide-react';
import {
  AMOUNT_UNITS,
  AmountUnit,
  AmountUnitModule,
  useAmountUnitStore,
} from '../../hooks/useAmountUnitStore';

interface AmountUnitSelectProps {
  /** 模块标识：该选择器写入对应模块的单位覆盖 */
  module: AmountUnitModule;
  disabled?: boolean;
  /** 追加到外层 span 的布局类（如 ml-auto / border-l 分隔） */
  className?: string;
}

/**
 * 模块级金额单位选择器：默认「跟随全局」（显示当前全局单位），
 * 选择具体单位后本模块的分析统计按所选单位换算，优先于 Header 的全局设置。
 */
export const AmountUnitSelect: React.FC<AmountUnitSelectProps> = ({ module, disabled, className }) => {
  const globalUnit = useAmountUnitStore((s) => s.globalUnit);
  const moduleUnit = useAmountUnitStore((s) => s.moduleUnits[module] || '');
  const setModuleUnit = useAmountUnitStore((s) => s.setModuleUnit);

  return (
    <span className={`shrink-0 flex items-center space-x-1 ${className || ''}`}>
      <Coins className="w-3 h-3 text-amber-400" />
      <select
        data-testid={`amount-unit-select-${module}`}
        value={moduleUnit}
        onChange={(e) => setModuleUnit(module, e.target.value as AmountUnit | '')}
        disabled={disabled}
        title={`金额输出单位：默认跟随全局（当前全局为「${globalUnit}」）；选择具体单位后本模块按所选单位换算，优先于全局设置`}
        className="bg-slate-950 border border-slate-700 rounded-lg px-1.5 py-0.5 text-[11px] text-slate-300 focus:outline-none focus:border-amber-500 cursor-pointer disabled:opacity-50"
      >
        <option value="">跟随全局（{globalUnit}）</option>
        {AMOUNT_UNITS.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </span>
  );
};
