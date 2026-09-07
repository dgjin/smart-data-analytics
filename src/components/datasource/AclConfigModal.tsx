// P0-1 拆分：P2-11 ACL 访问控制弹窗——配置可访问数据源的部门与个人授权清单
// （两组均留空 = 不限制全员可见；管理员不受限；ds 为 null 时不渲染）
import React from 'react';
import { RefreshCw, ShieldCheck, X } from 'lucide-react';
import { DataSource } from '../../types/analytics';

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
  if (!ds) return null;
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
          <div className="space-y-1">
            <label className="text-slate-300 font-medium">授权部门（逗号分隔，与「系统管理 → 用户」中的部门一致）:</label>
            <textarea
              value={depts}
              onChange={(e) => onDeptsChange(e.target.value.slice(0, 2000))}
              placeholder="例如：风险部, 财务部"
              rows={2}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-emerald-500"
            />
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
