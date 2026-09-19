// P0-1 拆分：P2-11 ACL 访问控制弹窗——配置可访问数据源的部门与个人授权清单
// （两组均留空 = 不限制全员可见；管理员不受限；ds 为 null 时不渲染）
import React, { useState } from 'react';
import { RefreshCw, ShieldCheck, X } from 'lucide-react';
import { DataSource } from '../../types/analytics';
// v0.9.66 部门清单支持组织树多选（与「系统管理 → 组织架构」树一致）
import { useOrgUnits } from '../../hooks/useOrgUnits';
import { OrgUnitPicker } from '../common/OrgUnitPicker';

export interface AclConfigModalProps {
  /** 目标数据源；null 时不渲染 */
  ds: DataSource | null;
  /** 授权部门（逗号分隔文本） */
  depts: string;
  onDeptsChange: (v: string) => void;
  /** 授权用户 ID（逗号分隔数字文本） */
  userIds: string;
  onUserIdsChange: (v: string) => void;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}

/** 逗号/中文逗号/空白分隔的部门文本 → 名称数组（与保存逻辑一致） */
const splitDeptNames = (s: string) =>
  s
    .split(/[,\uFF0C\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);

export const AclConfigModal: React.FC<AclConfigModalProps> = ({
  ds,
  depts,
  onDeptsChange,
  userIds,
  onUserIdsChange,
  saving,
  onSave,
  onClose,
}) => {
  // v0.9.66：部门清单按名称与组织节点匹配回显；未匹配的存量文本自动落到「手动粘贴」模式
  const { units, loading: unitsLoading } = useOrgUnits(!!ds);
  const [modeOverride, setModeOverride] = useState<'tree' | 'manual' | null>(null);
  if (!ds) return null;
  const names = splitDeptNames(depts);
  const allNamesMatch = names.every((n) => units.some((u) => u.name === n));
  const mode = modeOverride ?? (allNamesMatch ? 'tree' : 'manual');
  const selectedIds = names.map((n) => units.find((u) => u.name === n)?.id).filter((v): v is number => v !== undefined);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg flex flex-col bg-slate-900 border border-emerald-500/40 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="space-y-0.5">
            <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>访问控制：{ds.name}</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              配置可访问该数据源的部门与个人；两组均留空 = 不限制（全员可见）。管理员不受限。
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-xs">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-slate-300 font-medium">授权部门（与「系统管理 → 组织架构」树一致；留空 = 不限部门）:</label>
              {/* v0.9.66：树多选 / 手动粘贴双模式（存量文本可能不对应任何节点） */}
              <div className="flex gap-0.5 bg-slate-950 border border-slate-800 rounded-lg p-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setModeOverride('tree')}
                  className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors ${
                    mode === 'tree' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  组织树
                </button>
                <button
                  type="button"
                  onClick={() => setModeOverride('manual')}
                  className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors ${
                    mode === 'manual' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  手动粘贴
                </button>
              </div>
            </div>
            {mode === 'tree' ? (
              <>
                <OrgUnitPicker
                  units={units}
                  loading={unitsLoading}
                  mode="multi"
                  selectedIds={selectedIds}
                  onChange={(ids) =>
                    onDeptsChange(ids.map((id) => units.find((u) => u.id === id)?.name ?? '').filter(Boolean).join(', '))
                  }
                  listClassName="max-h-40"
                />
                <p className="text-[10px] text-slate-500">
                  {names.length > 0 ? `已选 ${names.length} 个部门：${names.join('、')}` : '未选择部门（该维度不限制）'}
                  ；保存仍提交部门名称文本（与用户「部门」字段同源匹配）。
                </p>
              </>
            ) : (
              <textarea
                value={depts}
                onChange={(e) => onDeptsChange(e.target.value.slice(0, 2000))}
                placeholder="例如：风险部, 财务部"
                rows={2}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            )}
          </div>
          <div className="space-y-1">
            <label className="text-slate-300 font-medium">授权用户 ID（逗号分隔数字；审批通过的申请会自动并入此清单）:</label>
            <textarea
              value={userIds}
              onChange={(e) => onUserIdsChange(e.target.value.slice(0, 2000))}
              placeholder="例如：3, 7, 12"
              rows={2}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
            />
          </div>
          <p className="text-[11px] text-slate-500 leading-relaxed">
            命中任一清单即可访问；无权用户在数据源列表中仅看到名称并可通过头部「申请权限」入口发起申请。
          </p>
        </div>

        <div className="flex items-center justify-end space-x-2 px-5 py-3.5 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700"
          >
            取消
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1"
          >
            {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            <span>{saving ? '保存中...' : '保存访问控制'}</span>
          </button>
        </div>
      </div>
    </div>

  );
};
