/**
 * 业务本体治理面板（v0.9.114 拆分）：
 * 实体与绑定 / 值域释义 / 关联路径 / 业务层级四类资产的手工治理入口（仅 ADMIN 可写）。
 * 子页签实现见 ./ontology/ 目录；本文件仅保留主面板编排与全局开关。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, RefreshCw, CheckCircle2, AlertCircle, Sparkles, X, Tag, GitBranch, Layers3 } from 'lucide-react';
import { useAnalyticsStore } from '../../../hooks/useAnalyticsStore';
import { getErrorMessage } from '../../../utils/errorUtils';
import { SectionTabs, type SectionTabItem } from '../SectionTabs';
import { OntologyAutoBuildModal } from '../OntologyAutoBuildModal';
import type { OntologyAssetType, OntologySummaryCounts } from '../../../types/ontology';
import { callApi, type VersionTarget } from './shared';
import { EntitySection } from './EntitySection';
import { ValueNoteSection } from './ValueNoteSection';
import { RelationSection } from './RelationSection';
import { HierarchySection } from './HierarchySection';
import { VersionHistoryModal } from './VersionHistoryModal';

type OntologyTab = 'entities' | 'value-notes' | 'relations' | 'hierarchies';

const TABS: SectionTabItem<OntologyTab>[] = [
  { id: 'entities', label: '实体与绑定', icon: Boxes, color: 'text-cyan-400' },
  { id: 'value-notes', label: '值域释义', icon: Tag, color: 'text-amber-400' },
  { id: 'relations', label: '关联路径', icon: GitBranch, color: 'text-emerald-400' },
  { id: 'hierarchies', label: '业务层级', icon: Layers3, color: 'text-violet-400' },
];

export const OntologyPanel: React.FC = () => {
  const dataSources = useAnalyticsStore((s) => s.dataSources);

  const [dataSourceId, setDataSourceId] = useState('');
  const [tab, setTab] = useState<OntologyTab>('entities');
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [summary, setSummary] = useState<OntologySummaryCounts | null>(null);
  const [isSummaryLoading, setIsSummaryLoading] = useState(false);
  const [versionTarget, setVersionTarget] = useState<VersionTarget | null>(null);
  // 版本回滚后强制重挂载四个子面板，使其重新拉取最新资产
  const [refreshToken, setRefreshToken] = useState(0);
  const [autoBuildOpen, setAutoBuildOpen] = useState(false);
  // v0.9.113 全局开关：ADMIN 在面板直接启停本体软注入（写 env_config 并热更，无需重启）
  const [ontologyOn, setOntologyOn] = useState<boolean | null>(null);
  const [togglingOntology, setTogglingOntology] = useState(false);

  const showNotice = useCallback((type: 'success' | 'error', text: string) => setNotice({ type, text }), []);
  const openVersions = useCallback(
    (assetType: OntologyAssetType, id: number, title: string) => setVersionTarget({ assetType, id, title }),
    []
  );

  // 开关初值来自 /api/ontology/settings（与「环境配置」面板同源）；读取失败时禁用开关，不影响资产浏览
  useEffect(() => {
    let cancelled = false;
    callApi<{ ok: boolean; enabled: boolean }>('/api/ontology/settings')
      .then((r) => {
        if (!cancelled) setOntologyOn(r?.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setOntologyOn(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleOntology = useCallback(async () => {
    if (ontologyOn === null || togglingOntology) return;
    const next = !ontologyOn;
    setTogglingOntology(true);
    try {
      const r = await callApi<{ ok: boolean; enabled: boolean }>('/api/ontology/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      setOntologyOn(r?.enabled === true);
      showNotice(
        'success',
        next
          ? '本体注入已开启：命中实体参与圈表加权，并注入四段提示词'
          : '本体注入已关闭：不再参与圈表加权与提示词注入（已登记资产保留，可随时重新开启）'
      );
    } catch (err) {
      showNotice('error', getErrorMessage(err));
    } finally {
      setTogglingOntology(false);
    }
  }, [ontologyOn, togglingOntology, showNotice]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 默认选中第一个数据源（与 IronRulesPanel 一致）
  useEffect(() => {
    if (!dataSourceId && dataSources.length > 0) setDataSourceId(dataSources[0].id);
  }, [dataSources, dataSourceId]);

  const tables = useMemo(
    () => dataSources.find((ds) => ds.id === dataSourceId)?.tables || [],
    [dataSources, dataSourceId]
  );
  const dataSourceName = useMemo(
    () => dataSources.find((ds) => ds.id === dataSourceId)?.name || '',
    [dataSources, dataSourceId]
  );

  const loadSummary = useCallback(async () => {
    if (!dataSourceId) return;
    setIsSummaryLoading(true);
    try {
      const data = await callApi<{ summary: OntologySummaryCounts }>(
        `/api/ontology/summary?dataSourceId=${encodeURIComponent(dataSourceId)}`
      );
      setSummary(data.summary || null);
    } catch (err) {
      showNotice('error', getErrorMessage(err) || '加载本体概览失败');
    } finally {
      setIsSummaryLoading(false);
    }
  }, [dataSourceId, showNotice]);

  useEffect(() => {
    const timer = setTimeout(() => void loadSummary(), 0);
    return () => clearTimeout(timer);
  }, [loadSummary]);

  const onChanged = useCallback(() => { void loadSummary(); }, [loadSummary]);
  const handleRestored = useCallback(() => {
    setVersionTarget(null);
    setRefreshToken((n) => n + 1);
    void loadSummary();
  }, [loadSummary]);

  // 可点击的计数卡直接切到对应 Tab（表列绑定依附实体，不单独跳转）
  const counters: { label: string; value: number; cls: string; tab?: OntologyTab; hint?: string }[] = [
    { label: '业务实体', value: summary?.entities ?? 0, cls: 'text-cyan-300', tab: 'entities' },
    { label: '表列绑定', value: summary?.bindings ?? 0, cls: 'text-slate-200', hint: '在「实体与绑定」中按实体维护' },
    { label: '值域释义', value: summary?.valueNotes ?? 0, cls: 'text-amber-300', tab: 'value-notes' },
    { label: '关联路径', value: summary?.relations ?? 0, cls: 'text-emerald-300', tab: 'relations' },
    { label: '业务层级', value: summary?.hierarchies ?? 0, cls: 'text-violet-300', tab: 'hierarchies' },
  ];

  return (
    <div className="space-y-4">
      {/* 数据源选择 + 概览计数条 */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-xl">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <Boxes className="w-4 h-4 text-cyan-400" />
          <span className="font-bold text-slate-200">业务本体</span>
          <select
            value={dataSourceId}
            onChange={(e) => setDataSourceId(e.target.value)}
            className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            {dataSources.length === 0 && <option value="">暂无数据源</option>}
            {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name}</option>)}
          </select>
          <button
            onClick={() => setAutoBuildOpen(true)}
            disabled={!dataSourceId}
            title="根据数据源 Schema 的中文描述与命名规则自动生成四类本体资产"
            className="flex items-center space-x-1 rounded-lg border border-cyan-700/60 bg-cyan-950/30 px-2.5 py-1.5 text-cyan-200 hover:bg-cyan-900/40 disabled:opacity-40"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>智能预填</span>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={ontologyOn === true}
            aria-label="本体注入开关"
            onClick={() => void toggleOntology()}
            disabled={ontologyOn === null || togglingOntology}
            title={
              ontologyOn
                ? '已开启：命中实体参与圈表加权并注入四段提示词；点击关闭（即时生效）'
                : '已关闭：圈表不加权、提示词不注入；点击开启（即时生效）'
            }
            className={`flex items-center space-x-1.5 rounded-lg border px-2.5 py-1.5 transition-colors disabled:opacity-40 ${
              ontologyOn
                ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-200 hover:bg-emerald-900/40'
                : 'border-slate-700 bg-slate-950/60 text-slate-400 hover:bg-slate-900'
            }`}
          >
            <span
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                ontologyOn ? 'bg-emerald-500' : 'bg-slate-600'
              }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                  ontologyOn ? 'translate-x-3.5' : 'translate-x-0.5'
                }`}
              />
            </span>
            <span>{ontologyOn === null ? '本体注入…' : ontologyOn ? '本体注入已开启' : '本体注入已关闭'}</span>
          </button>
          <button onClick={() => void loadSummary()} disabled={isSummaryLoading} className="flex items-center space-x-1 text-slate-400 hover:text-slate-200 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${isSummaryLoading ? 'animate-spin' : ''}`} />
            <span>刷新概览</span>
          </button>
          <span className="text-[10px] text-slate-500">命中实体 → 圈表加权 + 四段提示词软注入；执行层 Schema 白名单不变</span>
        </div>
        {ontologyOn === false && (
          <div className="flex items-center space-x-1.5 rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>本体注入已关闭：问数不再使用实体加权与四段提示词；已登记资产与版本历史保留，重新开启后立即恢复。</span>
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {counters.map((c) => {
            const activeTab = c.tab !== undefined && c.tab === tab;
            return (
              <button
                key={c.label}
                type="button"
                onClick={() => c.tab && setTab(c.tab)}
                disabled={!c.tab}
                title={c.hint || `查看${c.label}`}
                aria-label={c.tab ? `查看${c.label}` : c.hint}
                className={`text-left bg-slate-950/60 border rounded-xl px-3 py-2 transition-colors ${
                  activeTab ? 'border-cyan-500/60 ring-1 ring-cyan-500/30' : 'border-slate-800'
                } ${c.tab ? 'hover:border-slate-600 cursor-pointer' : 'cursor-default'}`}
              >
                <div className={`text-lg font-bold ${c.cls}`}>{c.value}</div>
                <div className="text-[10px] text-slate-500">{c.label}（ACTIVE）{c.tab ? ' ›' : ''}</div>
              </button>
            );
          })}
        </div>
      </div>

      {notice && (
        <div className={`flex items-center justify-between rounded-xl border px-3 py-2 text-xs ${notice.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200' : 'bg-rose-500/10 border-rose-500/30 text-rose-200'}`}>
          <div className="flex items-center space-x-2">
            {notice.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
            <span>{notice.text}</span>
          </div>
          <button onClick={() => setNotice(null)} className="text-slate-400 hover:text-slate-200"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      <SectionTabs<OntologyTab> tabs={TABS} active={tab} onChange={setTab} accent="cyan" />

      {dataSourceId ? (
        <>
          {tab === 'entities' && (
            <EntitySection
              key={`entities-${dataSourceId}-${refreshToken}`}
              dataSourceId={dataSourceId}
              tables={tables}
              showNotice={showNotice}
              onChanged={onChanged}
              openVersions={openVersions}
            />
          )}
          {tab === 'value-notes' && (
            <ValueNoteSection
              key={`value-notes-${dataSourceId}-${refreshToken}`}
              dataSourceId={dataSourceId}
              tables={tables}
              showNotice={showNotice}
              onChanged={onChanged}
              openVersions={openVersions}
            />
          )}
          {tab === 'relations' && (
            <RelationSection
              key={`relations-${dataSourceId}-${refreshToken}`}
              dataSourceId={dataSourceId}
              tables={tables}
              showNotice={showNotice}
              onChanged={onChanged}
              openVersions={openVersions}
            />
          )}
          {tab === 'hierarchies' && (
            <HierarchySection
              key={`hierarchies-${dataSourceId}-${refreshToken}`}
              dataSourceId={dataSourceId}
              tables={tables}
              showNotice={showNotice}
              onChanged={onChanged}
              openVersions={openVersions}
            />
          )}
        </>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-10 text-center text-xs text-slate-500">
          暂无可用数据源，请先在「数据源与 Schema」接入后再维护业务本体
        </div>
      )}

      {autoBuildOpen && dataSourceId && (
        <OntologyAutoBuildModal
          dataSourceId={dataSourceId}
          dataSourceName={dataSourceName}
          showNotice={showNotice}
          onClose={() => setAutoBuildOpen(false)}
          onApplied={handleRestored}
        />
      )}

      {versionTarget && (
        <VersionHistoryModal
          target={versionTarget}
          showNotice={showNotice}
          onClose={() => setVersionTarget(null)}
          onRestored={handleRestored}
        />
      )}
    </div>
  );
};

export default OntologyPanel;
