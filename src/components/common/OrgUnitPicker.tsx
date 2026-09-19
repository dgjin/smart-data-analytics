/**
 * 组织架构树选择器（单选，可折叠）：总部→机构→部门→团队。
 * 用于「用户归属节点」选择；点击行选中，再点取消选择。
 * 层级元数据与组树函数见 ./orgTreeMeta（供组织架构面板共用）。
 */
import React, { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { OrgUnit } from '../../types/analytics';
import { buildOrgTree, ORG_LEVEL_LABELS, ORG_LEVEL_COLORS, ORG_LEVEL_BADGES, ORG_LEVEL_ICONS } from './orgTreeMeta';
import type { OrgTreeNode } from './orgTreeMeta';

export interface OrgUnitPickerProps {
  /** 扁平节点列表（useOrgUnits 拉取；组件内组树） */
  units: OrgUnit[];
  /** 已选节点 ID；null = 未选择 */
  selectedId: number | null;
  /** 选择变化：回传节点 ID 或 null（取消选择） */
  onChange: (id: number | null) => void;
  loading?: boolean;
  /** 滚动区高度类（默认 max-h-56） */
  listClassName?: string;
  /** 空列表占位文案 */
  emptyText?: string;
  disabled?: boolean;
}

export const OrgUnitPicker: React.FC<OrgUnitPickerProps> = ({
  units,
  selectedId,
  onChange,
  loading = false,
  listClassName = 'max-h-56',
  emptyText = '暂无组织节点，请先到「系统管理 → 组织架构」维护',
  disabled = false,
}) => {
  // 折叠状态用「收起集合」表达：默认全部展开，数据异步到达后无需再初始化
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const tree = useMemo(() => buildOrgTree(units), [units]);

  const toggleSelect = (u: OrgUnit) => {
    if (disabled) return;
    onChange(selectedId === u.id ? null : u.id);
  };

  const toggleCollapse = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderNode = (node: OrgTreeNode, depth: number): React.ReactNode => {
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    const isSelected = node.id === selectedId;
    const LevelIcon = ORG_LEVEL_ICONS[node.level];
    return (
      <div key={node.id}>
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          onClick={() => toggleSelect(node)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleSelect(node);
            }
          }}
          title={node.name}
          style={{ paddingLeft: depth * 16 + 8 }}
          className={`flex items-center gap-1.5 rounded-lg py-1.5 pr-2 text-xs transition-colors ${
            disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:bg-slate-800/40'
          } ${isSelected ? 'bg-indigo-500/10 ring-1 ring-inset ring-indigo-500/40' : ''}`}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(node.id);
              }}
              title={isCollapsed ? '展开下级' : '收起下级'}
              className="p-0.5 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
            >
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
            </button>
          ) : (
            <span className="shrink-0" style={{ width: 18 }} />
          )}
          <LevelIcon className={`w-3.5 h-3.5 shrink-0 ${ORG_LEVEL_COLORS[node.level]}`} />
          <span className={`truncate ${isSelected ? 'text-slate-100 font-semibold' : 'text-slate-300'}`}>{node.name}</span>
          <span className={`shrink-0 px-1.5 py-px rounded border text-[10px] ${ORG_LEVEL_BADGES[node.level]}`}>
            {ORG_LEVEL_LABELS[node.level]}
          </span>
          {node.dataCode && (
            <code className="shrink-0 px-1.5 py-px rounded bg-slate-950/80 border border-slate-700 text-[10px] text-slate-400">
              {node.dataCode}
            </code>
          )}
        </div>
        {hasChildren && !isCollapsed && <div>{node.children.map((c) => renderNode(c, depth + 1))}</div>}
      </div>
    );
  };

  return (
    <div className={`bg-slate-950 border border-slate-700 rounded-lg overflow-y-auto ${listClassName}`}>
      {tree.length === 0 ? (
        <div className="px-3 py-6 text-center text-[11px] text-slate-500">{loading ? '加载中...' : emptyText}</div>
      ) : (
        <div className="py-1">{tree.map((n) => renderNode(n, 0))}</div>
      )}
    </div>
  );
};
