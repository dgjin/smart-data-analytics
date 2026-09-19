/**
 * v0.9.66 组织架构树选择器（可折叠）：总部→机构→部门→团队。
 * - mode='single'：点击行选中该节点（再点取消选择）
 * - mode='multi'：复选框多选；含可选下级的节点提供「全选下级 / 取消下级」快捷项
 * - allowedLevels：限定可选层级（不传 = 全部可选）；requireDataCode：dataCode 为空的节点置灰
 * 跨层级组合的合法性（如机构与部门/团队混选）由调用方校验，本组件只负责选择交互与置灰。
 */
import React, { useMemo, useState } from 'react';
import { ChevronRight, Landmark, Building2, FolderTree, Users2 } from 'lucide-react';
import type { OrgUnit, OrgUnitLevel } from '../../types/analytics';

/** 组织树节点（由扁平列表组树，children 已按 sortOrder 排序） */
export interface OrgTreeNode extends OrgUnit {
  children: OrgTreeNode[];
}

export const ORG_LEVEL_LABELS: Record<OrgUnitLevel, string> = {
  HQ: '总部',
  BRANCH: '机构',
  DEPT: '部门',
  TEAM: '团队',
};

/** 层级图标色（沿用项目分类色系；html.light 翻转表已覆盖） */
export const ORG_LEVEL_COLORS: Record<OrgUnitLevel, string> = {
  HQ: 'text-violet-400',
  BRANCH: 'text-cyan-400',
  DEPT: 'text-emerald-400',
  TEAM: 'text-amber-400',
};

export const ORG_LEVEL_BADGES: Record<OrgUnitLevel, string> = {
  HQ: 'text-violet-300 bg-violet-500/10 border-violet-500/30',
  BRANCH: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30',
  DEPT: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  TEAM: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
};

export const ORG_LEVEL_ICONS: Record<OrgUnitLevel, React.ComponentType<{ className?: string }>> = {
  HQ: Landmark,
  BRANCH: Building2,
  DEPT: FolderTree,
  TEAM: Users2,
};

/** 扁平列表 → 树（parentId 不存在的节点按根处理；同级按 sortOrder,id 稳定排序） */
export function buildOrgTree(units: OrgUnit[]): OrgTreeNode[] {
  const sorted = [...units].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const map = new Map<number, OrgTreeNode>();
  const roots: OrgTreeNode[] = [];
  for (const u of sorted) map.set(u.id, { ...u, children: [] });
  for (const u of sorted) {
    const node = map.get(u.id)!;
    if (u.parentId !== null && map.has(u.parentId)) map.get(u.parentId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** 收集节点的全部后代（不含自身） */
export function collectDescendants(node: OrgTreeNode): OrgTreeNode[] {
  const out: OrgTreeNode[] = [];
  const walk = (n: OrgTreeNode) => {
    for (const c of n.children) {
      out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export interface OrgUnitPickerProps {
  /** 扁平节点列表（useOrgUnits 拉取；组件内组树） */
  units: OrgUnit[];
  mode?: 'single' | 'multi';
  /** 已选节点 ID 列表（single 模式取 [id] 或空数组） */
  selectedIds: number[];
  /** 选择变化：回传新的 ID 列表（按树序）与对应节点对象 */
  onChange: (ids: number[], nodes: OrgUnit[]) => void;
  /** 允许选择的层级；不传 = 全部可选 */
  allowedLevels?: OrgUnitLevel[];
  /** 仅 dataCode 非空的节点可选（空节点置灰并提示补数据标识） */
  requireDataCode?: boolean;
  loading?: boolean;
  /** 滚动区高度类（默认 max-h-56） */
  listClassName?: string;
  /** 空列表占位文案 */
  emptyText?: string;
  disabled?: boolean;
}

export const OrgUnitPicker: React.FC<OrgUnitPickerProps> = ({
  units,
  mode = 'single',
  selectedIds,
  onChange,
  allowedLevels,
  requireDataCode = false,
  loading = false,
  listClassName = 'max-h-56',
  emptyText = '暂无组织节点，请先到「系统管理 → 组织架构」维护',
  disabled = false,
}) => {
  // 折叠状态用「收起集合」表达：默认全部展开，数据异步到达后无需再初始化
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const tree = useMemo(() => buildOrgTree(units), [units]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const byId = useMemo(() => {
    const m = new Map<number, OrgUnit>();
    for (const u of units) m.set(u.id, u);
    return m;
  }, [units]);

  const selectable = (u: OrgUnit): boolean => {
    if (disabled) return false;
    if (allowedLevels && !allowedLevels.includes(u.level)) return false;
    // HQ（总部）代表「全辖不限制」，不要求数据标识；其余层级缺数据标识则置灰
    if (requireDataCode && !u.dataCode && u.level !== 'HQ') return false;
    return true;
  };

  const emit = (ids: number[]) => {
    const ordered = units.filter((u) => ids.includes(u.id)).map((u) => u.id);
    onChange(ordered, ordered.map((id) => byId.get(id)!).filter(Boolean));
  };

  const toggleSelect = (u: OrgUnit) => {
    if (!selectable(u)) return;
    if (mode === 'single') {
      emit(selected.has(u.id) ? [] : [u.id]);
      return;
    }
    const next = new Set(selected);
    if (next.has(u.id)) next.delete(u.id);
    else next.add(u.id);
    emit([...next]);
  };

  /** 多选：节点全部可选后代的批量选择/取消（快捷项） */
  const toggleDescendants = (node: OrgTreeNode) => {
    const targets = collectDescendants(node).filter(selectable);
    if (targets.length === 0) return;
    const allSelected = targets.every((t) => selected.has(t.id));
    const next = new Set(selected);
    for (const t of targets) {
      if (allSelected) next.delete(t.id);
      else next.add(t.id);
    }
    emit([...next]);
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
    const canSelect = selectable(node);
    const isSelected = selected.has(node.id);
    const LevelIcon = ORG_LEVEL_ICONS[node.level];
    const descendantTargets = mode === 'multi' ? collectDescendants(node).filter(selectable) : [];
    const descendantsAllSelected = descendantTargets.length > 0 && descendantTargets.every((t) => selected.has(t.id));
    return (
      <div key={node.id}>
        <div
          role="button"
          tabIndex={canSelect ? 0 : -1}
          onClick={() => toggleSelect(node)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggleSelect(node);
            }
          }}
          title={
            !canSelect && requireDataCode && !node.dataCode
              ? '该节点未配置数据标识，请先到组织架构面板补充'
              : !canSelect && allowedLevels
              ? `该场景仅允许选择：${allowedLevels.map((l) => ORG_LEVEL_LABELS[l]).join('/')}`
              : node.name
          }
          style={{ paddingLeft: depth * 16 + 8 }}
          className={`group flex items-center gap-1.5 rounded-lg py-1.5 pr-2 text-xs transition-colors ${
            canSelect ? 'cursor-pointer hover:bg-slate-800/40' : 'cursor-not-allowed opacity-45'
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
          {mode === 'multi' && (
            <input
              type="checkbox"
              checked={isSelected}
              disabled={!canSelect}
              onChange={() => toggleSelect(node)}
              onClick={(e) => e.stopPropagation()}
              className="accent-indigo-500 shrink-0"
            />
          )}
          <LevelIcon className={`w-3.5 h-3.5 shrink-0 ${ORG_LEVEL_COLORS[node.level]}`} />
          <span className={`truncate ${isSelected ? 'text-slate-100 font-semibold' : 'text-slate-300'}`}>{node.name}</span>
          <span className={`shrink-0 px-1.5 py-px rounded border text-[10px] ${ORG_LEVEL_BADGES[node.level]}`}>
            {ORG_LEVEL_LABELS[node.level]}
          </span>
          {node.dataCode ? (
            <code className="shrink-0 px-1.5 py-px rounded bg-slate-950/80 border border-slate-700 text-[10px] text-slate-400">
              {node.dataCode}
            </code>
          ) : (
            requireDataCode && <span className="shrink-0 text-[10px] text-slate-600">未配置数据标识</span>
          )}
          {descendantTargets.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleDescendants(node);
              }}
              className="ml-auto shrink-0 px-1.5 py-px rounded border border-slate-700 text-[10px] text-slate-400 opacity-0 group-hover:opacity-100 hover:text-slate-200 hover:bg-slate-800 transition-all"
            >
              {descendantsAllSelected ? '取消下级' : '全选下级'}
            </button>
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
