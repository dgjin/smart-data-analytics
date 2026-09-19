/**
 * 组织树共用元数据与纯函数（非组件模块；供 OrgUnitPicker / OrgStructurePanel 共享）。
 * 拆出独立文件以满足 react-refresh/only-export-components（组件文件只导出组件）。
 */
import type React from 'react';
import { Landmark, Building2, FolderTree, Users2 } from 'lucide-react';
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
