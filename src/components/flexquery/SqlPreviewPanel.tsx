// P0-1 拆分：生成 SQL 实时预览（v0.4.11 可折叠，收起时单行摘要；失败时红色错误文本）
import React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { FlexBuildResult } from '../../utils/flexQueryBuilder';

export interface SqlPreviewPanelProps {
  /** buildFlexQuerySql 实时构建结果；未选表时为 null */
  built: FlexBuildResult | null;
  sqlOpen: boolean;
  onToggle: () => void;
}

export const SqlPreviewPanel: React.FC<SqlPreviewPanelProps> = ({ built, sqlOpen, onToggle }) => {
  return (
    <div className="rounded-xl bg-slate-950 border border-slate-800 p-2.5">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase"
      >
        <span>生成 SQL（实时预览）</span>
        {sqlOpen ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
      </button>
      {sqlOpen ? (
        <code className="block mt-1 text-[11px] text-emerald-300 font-mono break-all whitespace-pre-wrap">
          {built?.ok === true ? built.sql : (built?.ok === false ? built.error : '选择数据表并拖入字段后自动生成')}
        </code>
      ) : (
        <code
          className={`block mt-1 text-[10px] font-mono truncate ${
            built?.ok ? 'text-slate-500' : 'text-rose-400'
          }`}
        >
          {built?.ok === true ? built.sql : (built?.ok === false ? built.error : '选择数据表并拖入字段后自动生成')}
        </code>
      )}
    </div>


  );
};
