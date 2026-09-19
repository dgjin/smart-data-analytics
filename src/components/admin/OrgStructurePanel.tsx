/**
 * 组织架构面板（仅 ADMIN）：总部→机构→部门→团队 四级树维护。
 * - 折叠 / 全部展开收起；行内操作：添加下级 / 重命名 / 上移 / 下移 / 删除
 * - 新增与重命名用弹窗（不用 window.prompt）；新增下级时按层级约束自动限定节点类型
 * - 节点名 = 用户「所属部门」文本（改名由服务端同步用户与数据源授权清单）
 * - 数据标识：节点在业务数据中的取值（机构编号如 AH、团队名如「投资一部」）。
 *   新增下级弹窗按层级路径预填（BR01 / BR01-D01 / BR01-D01-T01），面板可一键补全缺失节点
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Network,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Plus,
  Pencil,
  ArrowUp,
  ArrowDown,
  Trash2,
  RefreshCw,
  Wand2,
  AlertCircle,
  CheckCircle2,
  X,
} from 'lucide-react';
import { apiFetch } from '../../api/client';
import { getErrorMessage } from '../../utils/errorUtils';
import type { OrgUnit, OrgUnitLevel } from '../../types/analytics';
import {
  buildOrgTree,
  ORG_LEVEL_LABELS,
  ORG_LEVEL_COLORS,
  ORG_LEVEL_BADGES,
  ORG_LEVEL_ICONS,
} from '../common/orgTreeMeta';
import type { OrgTreeNode } from '../common/orgTreeMeta';
import { suggestOrgDataCode } from '../../utils/orgDataCode';

/** 各层级允许的下级（与 server/routes/orgUnits.ts 的 CHILD_LEVEL 对齐；团队为末级） */
const CHILD_LEVEL: Record<OrgUnitLevel, OrgUnitLevel | null> = { HQ: 'BRANCH', BRANCH: 'DEPT', DEPT: 'TEAM', TEAM: null };

export interface OrgStructurePanelProps {
  units: OrgUnit[];
  loading: boolean;
  refresh: () => Promise<OrgUnit[]>;
}

type DialogState = { mode: 'create'; parent: OrgUnit } | { mode: 'edit'; node: OrgUnit };

export const OrgStructurePanel: React.FC<OrgStructurePanelProps> = ({ units, loading, refresh }) => {
  const tree = useMemo(() => buildOrgTree(units), [units]);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [dataCodeInput, setDataCodeInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [filling, setFilling] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const showNotice = (type: 'success' | 'error', text: string) => setNotice({ type, text });

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** 含下级的节点 ID（全部展开/收起用） */
  const expandableIds = useMemo(() => {
    const out: number[] = [];
    const walk = (n: OrgTreeNode) => {
      if (n.children.length > 0) {
        out.push(n.id);
        n.children.forEach(walk);
      }
    };
    tree.forEach(walk);
    return out;
  }, [tree]);

  /** 未配置数据标识的节点数（总部不参与自动编码） */
  const missingCodeCount = useMemo(() => units.filter((u) => u.level !== 'HQ' && !u.dataCode.trim()).length, [units]);

  /** 同级列表（按 sortOrder,id 排序；用于上下移边界禁用的前后判定） */
  const siblingIdsOf = (node: OrgUnit): number[] =>
    units
      .filter((u) => u.parentId === node.parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
      .map((u) => u.id);

  const openCreate = (parent: OrgUnit) => {
    setDialog({ mode: 'create', parent });
    setNameInput('');
    // 数据标识按层级路径自动编码预填（服务端创建时同规则兜底）
    const childLevel = CHILD_LEVEL[parent.level];
    setDataCodeInput(childLevel ? suggestOrgDataCode(units, parent, childLevel) : '');
  };

  const openEdit = (node: OrgUnit) => {
    setDialog({ mode: 'edit', node });
    setNameInput(node.name);
    setDataCodeInput(node.dataCode);
  };

  const handleSaveDialog = async () => {
    if (!dialog || saving) return;
    const name = nameInput.trim();
    if (!name) {
      showNotice('error', '请填写节点名称');
      return;
    }
    setSaving(true);
    try {
      const headers = { 'Content-Type': 'application/json' };
      const res =
        dialog.mode === 'create'
          ? await apiFetch('/api/admin/org-units', {
              method: 'POST',
              headers,
              body: JSON.stringify({
                parentId: dialog.parent.id,
                level: CHILD_LEVEL[dialog.parent.level],
                name,
                dataCode: dataCodeInput.trim(),
              }),
            })
          : await apiFetch(`/api/admin/org-units/${dialog.node.id}`, {
              method: 'PUT',
              headers,
              body: JSON.stringify({ name, dataCode: dataCodeInput.trim() }),
            });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '保存失败');
      if (dialog.mode === 'create') {
        const childLevel = CHILD_LEVEL[dialog.parent.level];
        const savedCode = typeof data.unit?.dataCode === 'string' ? data.unit.dataCode : '';
        showNotice('success', `已新增${childLevel ? ORG_LEVEL_LABELS[childLevel] : '节点'}「${name}」${savedCode ? `（数据标识 ${savedCode}）` : ''}`);
      } else {
        const synced =
          typeof data.syncedUsers === 'number'
            ? `（同步 ${data.syncedUsers} 个用户部门文本${data.syncedDataSources ? `、${data.syncedDataSources} 个数据源授权清单` : ''}）`
            : '';
        showNotice('success', `节点已更新${synced}`);
      }
      setDialog(null);
      await refresh();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleMove = async (node: OrgUnit, direction: 'up' | 'down') => {
    if (busyId !== null) return;
    setBusyId(node.id);
    try {
      const res = await apiFetch(`/api/admin/org-units/${node.id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '移动失败');
      await refresh();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  /** 一键为未配置数据标识的节点按层级路径生成编码（服务端 POST /auto-code） */
  const handleFillCodes = async () => {
    if (filling) return;
    setFilling(true);
    try {
      const res = await apiFetch('/api/admin/org-units/auto-code', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '补全失败');
      showNotice('success', data.filled > 0 ? `已为 ${data.filled} 个节点自动生成数据标识` : '所有节点均已配置数据标识');
      await refresh();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setFilling(false);
    }
  };

  const handleDelete = async (node: OrgUnit) => {
    const hints = [
      node.childCount > 0 ? `该节点包含 ${node.childCount} 个下级节点，需先删除下级。` : '',
      node.userCount > 0 ? `当前有 ${node.userCount} 个用户归属该节点，需先调整归属。` : '',
      '删除后不可恢复；数据源授权清单中的同名部门文本不会被自动清理，请删除后自行核对。',
    ]
      .filter(Boolean)
      .join('\n');
    if (!window.confirm(`确认删除节点「${node.name}」？\n${hints}`)) return;
    setBusyId(node.id);
    try {
      const res = await apiFetch(`/api/admin/org-units/${node.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '删除失败');
      showNotice('success', `已删除节点「${node.name}」`);
      await refresh();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const toggleCollapse = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const opBtn = 'p-1.5 rounded-lg border border-slate-700/70 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

  const renderNode = (node: OrgTreeNode, depth: number): React.ReactNode => {
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    const LevelIcon = ORG_LEVEL_ICONS[node.level];
    const childLevel = CHILD_LEVEL[node.level];
    const siblings = siblingIdsOf(node);
    const isFirst = siblings[0] === node.id;
    const isLast = siblings[siblings.length - 1] === node.id;
    const isRoot = node.level === 'HQ';
    const busy = busyId === node.id;
    return (
      <div key={node.id}>
        <div
          style={{ paddingLeft: depth * 20 + 8 }}
          className="group flex items-center gap-2 rounded-lg py-2 pr-3 text-xs hover:bg-slate-800/30 transition-colors"
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggleCollapse(node.id)}
              title={isCollapsed ? '展开下级' : '收起下级'}
              className="p-0.5 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors"
            >
              <ChevronRight className={`w-4 h-4 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
            </button>
          ) : (
            <span className="shrink-0" style={{ width: 20 }} />
          )}
          <LevelIcon className={`w-4 h-4 shrink-0 ${ORG_LEVEL_COLORS[node.level]}`} />
          <span className="text-sm font-medium text-slate-200 truncate">{node.name}</span>
          <span className={`shrink-0 px-1.5 py-px rounded border text-[10px] ${ORG_LEVEL_BADGES[node.level]}`}>
            {ORG_LEVEL_LABELS[node.level]}
          </span>
          {node.dataCode ? (
            <code className="shrink-0 px-1.5 py-px rounded bg-slate-950/80 border border-slate-700 text-[10px] text-slate-400">
              {node.dataCode}
            </code>
          ) : (
            !isRoot && <span className="shrink-0 text-[10px] text-slate-600">未配置数据标识</span>
          )}
          {node.userCount > 0 && (
            <span className="shrink-0 px-1.5 py-px rounded bg-indigo-500/10 border border-indigo-500/30 text-[10px] text-indigo-300">
              {node.userCount} 个用户
            </span>
          )}
          <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {childLevel && (
              <button type="button" onClick={() => openCreate(node)} title={`添加下级${ORG_LEVEL_LABELS[childLevel]}`} className={opBtn}>
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
            <button type="button" onClick={() => openEdit(node)} title="重命名 / 修改数据标识" className={opBtn}>
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleMove(node, 'up')}
              disabled={busy || isFirst}
              title={isFirst ? '已是同级首位' : '上移'}
              className={opBtn}
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleMove(node, 'down')}
              disabled={busy || isLast}
              title={isLast ? '已是同级末位' : '下移'}
              className={opBtn}
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleDelete(node)}
              disabled={busy || isRoot}
              title={isRoot ? '总部为系统内置根节点，不可删除' : '删除节点'}
              className={`${opBtn} text-rose-400 hover:text-rose-300 hover:bg-rose-950/30 border-rose-900/50`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        {hasChildren && !isCollapsed && <div>{node.children.map((c) => renderNode(c, depth + 1))}</div>}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {notice && (
        <div
          className={`p-4 rounded-xl border flex items-center gap-2 ${
            notice.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 className="w-5 h-5 shrink-0" /> : <AlertCircle className="w-5 h-5 shrink-0" />}
          <span className="text-sm">{notice.text}</span>
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-xl overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <Network className="w-5 h-5 text-emerald-400" />
              组织架构
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              总部 → 机构 → 部门 → 团队；用户「所属部门」与数据源授权均以此树为准
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleFillCodes()}
              disabled={filling || missingCodeCount === 0}
              title={missingCodeCount === 0 ? '所有节点均已配置数据标识' : `为 ${missingCodeCount} 个未配置的节点按层级路径自动编号`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Wand2 className="w-3.5 h-3.5" />
              {filling ? '生成中…' : `补全数据标识${missingCodeCount > 0 ? `（${missingCodeCount}）` : ''}`}
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(new Set())}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs font-medium transition-colors"
            >
              <ChevronsDown className="w-3.5 h-3.5" />
              全部展开
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(new Set(expandableIds))}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs font-medium transition-colors"
            >
              <ChevronsUp className="w-3.5 h-3.5" />
              全部收起
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              title="刷新"
              className="p-2 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors disabled:opacity-40"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="p-3">
          {tree.length === 0 ? (
            <div className="px-6 py-12 text-center">
              {loading ? (
                <>
                  <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-emerald-400" />
                  <p className="text-sm text-slate-500">加载中...</p>
                </>
              ) : (
                <>
                  <Network className="w-10 h-10 mx-auto mb-3 text-slate-600" />
                  <p className="text-sm text-slate-500">暂无组织节点（总部根节点在服务启动时自动创建）</p>
                </>
              )}
            </div>
          ) : (
            <div>{tree.map((n) => renderNode(n, 0))}</div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-slate-800">
          <p className="text-[11px] leading-relaxed text-slate-500">
            数据标识记录该节点在业务数据中的取值（机构编号 / 部门与团队在数据中的取值）。新增节点按层级路径自动编号（机构 BR01、部门 BR01-D01、团队 BR01-D01-T01），可用上方「补全数据标识」为缺失节点一键生成，也可按业务实际取值修改。
            重命名节点会自动同步已归属用户的部门文本与数据源授权清单中的同名部门。
          </p>
        </div>
      </div>

      {/* 新增 / 重命名弹窗（复用既有 modal 样式） */}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                {dialog.mode === 'create' ? (
                  <>
                    <Plus className="w-4 h-4 text-emerald-400" />
                    新增{CHILD_LEVEL[dialog.parent.level] ? ORG_LEVEL_LABELS[CHILD_LEVEL[dialog.parent.level]!] : '下级'} — 上级：{dialog.parent.name}
                  </>
                ) : (
                  <>
                    <Pencil className="w-4 h-4 text-emerald-400" />
                    编辑节点 — {dialog.node.name}
                  </>
                )}
              </h3>
              <button
                type="button"
                onClick={() => setDialog(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4 text-xs">
              <div className="space-y-1.5">
                <label className="text-slate-400 font-medium">节点名称（即用户「部门」文本）</label>
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  maxLength={100}
                  autoFocus
                  placeholder={dialog.mode === 'create' && dialog.parent.level === 'HQ' ? '如：安徽分公司' : '如：投资一部'}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSaveDialog();
                  }}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-emerald-500 transition-colors"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-slate-400 font-medium">
                  数据标识 <span className="text-slate-500">（自动编号，可改为业务实际取值）</span>
                </label>
                <input
                  type="text"
                  value={dataCodeInput}
                  onChange={(e) => setDataCodeInput(e.target.value)}
                  maxLength={100}
                  placeholder={dialog.mode === 'create' && dialog.parent.level === 'HQ' ? '机构编号，如 AH' : '数据中的取值，如 投资一部'}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSaveDialog();
                  }}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 font-mono focus:outline-none focus:border-emerald-500 transition-colors"
                />
              </div>
              {dialog.mode === 'create' && (
                <p className="text-[11px] leading-relaxed text-slate-500">
                  已按层级路径自动编号（机构 BR01 / 部门 BR01-D01 / 团队 BR01-D01-T01），可按业务数据中的实际取值修改。
                </p>
              )}
              {dialog.mode === 'edit' && (
                <p className="text-[11px] leading-relaxed text-slate-500 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
                  修改名称将同步更新已归属用户的部门文本与数据源授权清单中的同名部门。
                </p>
              )}
            </div>
            <div className="px-6 py-4 border-t border-slate-800 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setDialog(null)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors border border-slate-700"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleSaveDialog()}
                disabled={saving || !nameInput.trim()}
                className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-bold shadow-lg shadow-emerald-600/30 transition-all"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
