import React, { useCallback, useEffect, useState } from 'react';
import { History, RefreshCw, X } from 'lucide-react';
import { getErrorMessage } from '../../../utils/errorUtils';
import { useEscapeKey } from '../ontologyUi';
import type { OntologyAssetType, OntologyVersionItem } from '../../../types/ontology';
import { callApi, summarizeSnapshot, ACTION_LABELS, type VersionTarget } from './shared';

// ============ 版本历史与回滚 ============


const VERSION_SEGMENTS: Record<OntologyAssetType, string> = {
  entity: 'entities',
  relation: 'relations',
  hierarchy: 'hierarchies',
};

export const VersionHistoryModal: React.FC<{
  target: VersionTarget;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onClose: () => void;
  onRestored: () => void;
}> = ({ target, showNotice, onClose, onRestored }) => {
  const [versions, setVersions] = useState<OntologyVersionItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);

  const baseUrl = `/api/ontology/${VERSION_SEGMENTS[target.assetType]}/${target.id}`;

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await callApi<{ versions: OntologyVersionItem[] }>(`${baseUrl}/versions`);
      setVersions(data.versions || []);
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '版本查询失败');
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl, showNotice]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEscapeKey(restoringVersion === null, onClose);

  const handleRestore = async (v: OntologyVersionItem) => {
    if (restoringVersion !== null) return;
    if (!window.confirm(`确认将「${target.title}」回滚到 v${v.version}？当前内容会作为新版本保留，可再次回滚。`)) return;
    setRestoringVersion(v.version);
    try {
      await callApi<{ ok: boolean }>(`${baseUrl}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: v.version }),
      });
      showNotice('success', `已将「${target.title}」回滚到 v${v.version}（回滚动作记入版本历史）`);
      onRestored();
    } catch (err) {
      showNotice('error', getErrorMessage(err));
      setRestoringVersion(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => restoringVersion === null && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="版本历史"
        className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-1.5">
            <History className="w-4 h-4 text-cyan-400" />
            <span>版本历史 · {target.title}</span>
            {!isLoading && <span className="text-[10px] font-normal text-slate-500">共 {versions.length} 个版本 · Esc 关闭</span>}
          </h3>
          <button onClick={onClose} disabled={restoringVersion !== null} aria-label="关闭" className="text-slate-400 hover:text-slate-200 disabled:opacity-50"><X className="w-4 h-4" /></button>
        </div>
        <div className="max-h-[420px] overflow-y-auto space-y-1.5">
          {versions.map((v, idx) => {
            const isLatest = idx === 0;
            return (
              <div key={`${v.version}-${v.createdAt}-${v.action}`} className={`flex items-center justify-between gap-2 bg-slate-950/60 border rounded-xl px-3 py-2 text-xs ${isLatest ? 'border-cyan-700/50' : 'border-slate-800'}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-bold text-slate-200">v{v.version}</span>
                    {isLatest && <span className="px-1.5 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-500/40 text-[10px] text-cyan-200">最新</span>}
                    <span className="px-1.5 py-0.5 rounded-full border border-slate-600/50 text-[10px] text-slate-300">{ACTION_LABELS[v.action] || v.action || '变更'}</span>
                    <span className="text-[10px] text-slate-500">{v.actor || '-'} · {v.createdAt || '-'}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 truncate" title={JSON.stringify(v.snapshot)}>
                    {summarizeSnapshot(target.assetType, v.snapshot) || '（空快照）'}
                  </div>
                </div>
                <button
                  onClick={() => void handleRestore(v)}
                  disabled={restoringVersion !== null || isLatest}
                  title={isLatest ? '已是最新版本' : `回滚到 v${v.version}`}
                  className="shrink-0 px-2.5 py-1 rounded-lg border border-cyan-700/60 text-cyan-300 hover:bg-cyan-950/40 disabled:opacity-40 text-[11px] font-semibold"
                >
                  {restoringVersion === v.version ? '回滚中…' : isLatest ? '当前版本' : '回滚到此版本'}
                </button>
              </div>
            );
          })}
          {!isLoading && versions.length === 0 && (
            <div className="py-8 text-center text-xs text-slate-500">暂无版本记录（创建/更新/删除/回滚均会留快照）</div>
          )}
          {isLoading && (
            <div className="py-8 text-center text-xs text-slate-500"><RefreshCw className="inline w-3.5 h-3.5 mr-1 animate-spin" />加载中…</div>
          )}
        </div>
        <div className="text-[10px] text-slate-500">回滚仅作用于治理元数据（实体/关系/层级），不改变执行层 Schema 与已生成 SQL。</div>
      </div>
    </div>
  );
};

