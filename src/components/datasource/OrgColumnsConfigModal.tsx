// 组织权限模型：数据源「组织隔离列」配置弹窗——登记机构/团队/责任人列名，
// 与用户的数据范围（系统管理 → 用户 → 数据范围）相乘后生成行级过滤谓词，执行层强制注入。
// 三列均留空 = 该数据源不做组织隔离（ds 为 null 时不渲染）。
import React from 'react';
import { RefreshCw, Users, X } from 'lucide-react';
import { DataSource } from '../../types/analytics';

export interface OrgColumnsConfigModalProps {
  /** 目标数据源；null 时不渲染 */
  ds: DataSource | null;
  /** 机构列名（如 JGBH） */
  org: string;
  onOrgChange: (v: string) => void;
  /** 团队列名（如 SSTD） */
  team: string;
  onTeamChange: (v: string) => void;
  /** 责任人列名（如 XMJBRBH） */
  owner: string;
  onOwnerChange: (v: string) => void;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}

/** 该数据源出现频次最高的候选列（供快速点选，避免手输错列名） */
function candidateColumns(ds: DataSource, keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of ds.tables) {
    for (const c of t.columns) {
      if (seen.has(c.name)) continue;
      if (keywords.some((k) => c.name.toUpperCase().includes(k))) {
        seen.add(c.name);
        out.push(c.name);
        if (out.length >= 8) return out;
      }
    }
  }
  return out;
}

const Field: React.FC<{
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  candidates: string[];
  accent: string;
}> = ({ label, hint, value, onChange, candidates, accent }) => (
  <div className="space-y-1">
    <label className="text-slate-300 font-medium">
      {label} <span className="text-slate-500 font-normal">{hint}</span>
    </label>
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value.slice(0, 64))}
      placeholder="留空表示不使用该维度"
      className={`w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none font-mono ${accent}`}
    />
    {candidates.length > 0 && (
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {candidates.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className="px-1.5 py-0.5 rounded border border-slate-700 text-[10px] font-mono text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
          >
            {c}
          </button>
        ))}
      </div>
    )}
  </div>
);

export const OrgColumnsConfigModal: React.FC<OrgColumnsConfigModalProps> = ({
  ds,
  org,
  onOrgChange,
  team,
  onTeamChange,
  owner,
  onOwnerChange,
  saving,
  onSave,
  onClose,
}) => {
  if (!ds) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg flex flex-col bg-slate-900 border border-indigo-500/40 rounded-2xl shadow-2xl max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <div className="space-y-0.5">
            <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
              <Users className="w-4 h-4 text-indigo-400" />
              <span>组织隔离：{ds.name}</span>
            </h3>
            <p className="text-[11px] text-slate-400">
              登记该数据源的机构/团队/责任人列名（需真实存在于表结构）；用户的数据范围据此生效，三列均留空 = 不隔离。
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-xs overflow-y-auto">
          <Field
            label="机构列"
            hint="（分公司 = 用户档位「本机构」）"
            value={org}
            onChange={onOrgChange}
            candidates={candidateColumns(ds, ['JGBH', 'JGID', 'ORG', 'BRANCH'])}
            accent="focus:border-indigo-500"
          />
          <Field
            label="团队列"
            hint="（部门/团队 = 用户档位「本项目团队」）"
            value={team}
            onChange={onTeamChange}
            candidates={candidateColumns(ds, ['SSTD', 'TEAM', 'DEPT', 'BM'])}
            accent="focus:border-indigo-500"
          />
          <Field
            label="责任人列"
            hint="（经办人 = 用户档位「仅本人」）"
            value={owner}
            onChange={onOwnerChange}
            candidates={candidateColumns(ds, ['XMJBRBH', 'OWNER', 'USER', 'EMP'])}
            accent="focus:border-indigo-500"
          />
          <p className="text-[11px] text-slate-500 leading-relaxed bg-slate-950/60 border border-slate-800 rounded-lg p-3">
            隔离由执行层在 SQL 的 FROM 表上强制包裹过滤（fail-closed），LLM 无法绕过；表内不存在所登记列时该表不受约束。
            保存后问数结果缓存会立即失效，按新范围重新计算。
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
            className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1"
          >
            {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            <span>{saving ? '保存中...' : '保存组织隔离'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
