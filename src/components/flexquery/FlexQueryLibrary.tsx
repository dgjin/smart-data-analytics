// P0-1 拆分：v0.4.13 固定报表与最近查询历史并排面板（全宽时左右两列；v0.9.24 起服务端持久化）
// v0.9.75：固定报表检索 + 收藏置顶 + 历史一键存为报表
// v0.9.77 P2-15：报表版本历史（可回滚）/ 订阅（周期重跑 + 阈值告警）/ Excel 导出
import React, { useState } from 'react';
import { Bell, Bookmark, FileSpreadsheet, History, ListChecks, Pause, Pin, Play, RotateCcw, Search, Star, Trash2, X } from 'lucide-react';
import { ChartType } from '../../types/analytics';
import { FlexQueryConfig } from '../../utils/flexQueryBuilder';
import { FlexSubRunItem, FlexSubscriptionItem, FlexSubscriptionPayload, FlexVersionItem } from './flexQueryShared';

/** v0.9.77 P2-15：版本动作徽章样式（CREATE/UPDATE/RESTORE） */
const VERSION_ACTION_BADGE: Record<string, string> = {
  CREATE: 'border-emerald-500/40 text-emerald-300 bg-emerald-600/15',
  UPDATE: 'border-indigo-500/40 text-indigo-300 bg-indigo-600/15',
  RESTORE: 'border-amber-500/40 text-amber-300 bg-amber-600/15',
};

/** v0.9.77 P2-15：订阅运行状态徽章样式（SUCCESS/ALERT/FAILED） */
const RUN_STATUS_BADGE: Record<string, string> = {
  SUCCESS: 'border-emerald-500/40 text-emerald-300 bg-emerald-600/15',
  ALERT: 'border-amber-500/40 text-amber-300 bg-amber-600/15',
  FAILED: 'border-rose-500/40 text-rose-300 bg-rose-600/15',
};

/** v0.9.77 P2-15：ISO 时间戳 → `MM-DD HH:mm`（面板展示；空值/无效值返回原文本） */
const fmtPanelTs = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const s = String(iso).replace('T', ' ');
  return s.length >= 16 ? s.slice(5, 16) : s;
};

/** 已保存的固定报表（灵活查询定义），v0.9.24 起服务端 flex_queries 表持久化 */
export interface SavedFlexQuery {
  id: string;
  name: string;
  dataSourceId: string;
  config: FlexQueryConfig;
  chartType: ChartType;
  /** v0.9.77 P2-14c：图表视图选项（堆叠/双轴；旧数据缺省视为关闭） */
  chartOptions?: { stacked?: boolean; dualAxis?: boolean };
  createdAt: string;
}

/** 最近执行查询历史，v0.9.24 起服务端 flex_query_history 表持久化（仅本人可见） */
export interface FlexHistoryItem {
  id: string;
  name: string;
  dataSourceId: string;
  config: FlexQueryConfig;
  chartType: ChartType;
  /** v0.9.77 P2-14c：图表视图选项（堆叠/双轴） */
  chartOptions?: { stacked?: boolean; dualAxis?: boolean };
  ranAt: string;
}

export interface FlexQueryLibraryProps {
  savedQueries: SavedFlexQuery[];
  history: FlexHistoryItem[];
  onLoadSaved: (item: SavedFlexQuery) => void;
  onDeleteSaved: (id: string) => void;
  /** 「前往决策数据看板查看固化图表」 */
  onGoDashboard: () => void;
  onClearHistory: () => void;
  onRestoreHistory: (item: FlexHistoryItem) => void;
  /** v0.9.75：收藏（本地偏好，收藏项置顶展示） */
  favoriteIds: string[];
  onToggleFavorite: (id: string) => void;
  /** v0.9.75：历史一键存为固定报表 */
  onSaveFromHistory: (item: FlexHistoryItem) => void;
  /** v0.9.77 P2-15：版本历史（可回滚） */
  versionPanel: { queryId: string; name: string } | null;
  versions: FlexVersionItem[];
  loadingVersions: boolean;
  onOpenVersions: (queryId: string, name: string) => void;
  onCloseVersions: () => void;
  onRestoreVersion: (queryId: string, version: number) => void;
  /** v0.9.77 P2-15：订阅（周期重跑 + 阈值告警） */
  subPanel: { queryId: string; name: string } | null;
  subscriptions: FlexSubscriptionItem[];
  loadingSubs: boolean;
  subRuns: Record<string, FlexSubRunItem[]>;
  onOpenSubscriptions: (queryId: string, name: string) => void;
  onCloseSubscriptions: () => void;
  onCreateSubscription: (queryId: string, payload: FlexSubscriptionPayload) => Promise<boolean>;
  onUpdateSubscription: (queryId: string, subscriptionId: string, payload: FlexSubscriptionPayload, status?: string) => Promise<boolean>;
  onDeleteSubscription: (subscriptionId: string) => void;
  onRunSubscriptionNow: (subscriptionId: string) => void;
  onLoadSubRuns: (subscriptionId: string) => void;
  /** v0.9.77 P2-15：Excel 导出（服务端重放） */
  onExportExcel: (queryId: string, name: string) => void;
}

export const FlexQueryLibrary: React.FC<FlexQueryLibraryProps> = ({
  savedQueries,
  history,
  onLoadSaved,
  onDeleteSaved,
  onGoDashboard,
  onClearHistory,
  onRestoreHistory,
  favoriteIds,
  onToggleFavorite,
  onSaveFromHistory,
  versionPanel,
  versions,
  loadingVersions,
  onOpenVersions,
  onCloseVersions,
  onRestoreVersion,
  subPanel,
  subscriptions,
  loadingSubs,
  subRuns,
  onOpenSubscriptions,
  onCloseSubscriptions,
  onCreateSubscription,
  onUpdateSubscription,
  onDeleteSubscription,
  onRunSubscriptionNow,
  onLoadSubRuns,
  onExportExcel,
}) => {
  // v0.9.75：固定报表检索（名称/数据表）
  const [search, setSearch] = useState('');
  // v0.9.77 P2-15：订阅表单本地状态（提交成功或面板关闭后保留可复用）
  const [subForm, setSubForm] = useState<{ frequencyMinutes: number; alertMetric: string; alertOp: string; alertThreshold: number }>({
    frequencyMinutes: 60,
    alertMetric: '',
    alertOp: '>',
    alertThreshold: 0,
  });
  // v0.9.77 P2-15：订阅运行历史展开态（键 = 订阅 ID；展开时拉取最新记录）
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const toggleRuns = (subscriptionId: string) => {
    const next = !expandedRuns[subscriptionId];
    setExpandedRuns((prev) => ({ ...prev, [subscriptionId]: next }));
    if (next) onLoadSubRuns(subscriptionId);
  };
  const kw = search.trim().toLowerCase();
  const visibleSaved = savedQueries
    .filter((q) => !kw || `${q.name} ${q.config.table}`.toLowerCase().includes(kw))
    // 收藏项置顶（sort 稳定，同组内保持原顺序）
    .sort((a, b) => Number(favoriteIds.includes(b.id)) - Number(favoriteIds.includes(a.id)));

  /** v0.9.77 P2-15：提交新订阅（周期校验由服务端统一给出提示） */
  const handleCreateSub = async () => {
    if (!subPanel) return;
    const ok = await onCreateSubscription(subPanel.queryId, {
      frequencyMinutes: Math.floor(Number(subForm.frequencyMinutes)) || 0,
      alertMetric: subForm.alertMetric.trim(),
      alertOp: subForm.alertOp,
      alertThreshold: Number(subForm.alertThreshold) || 0,
    });
    if (ok) setSubForm({ frequencyMinutes: 60, alertMetric: '', alertOp: '>', alertThreshold: 0 });
  };

  /** v0.9.77 P2-15：暂停/恢复订阅（保持其余参数不变，更新即重新排期） */
  const handleToggleStatus = (sub: FlexSubscriptionItem) => {
    if (!subPanel) return;
    void onUpdateSubscription(
      subPanel.queryId,
      sub.subscriptionId,
      {
        frequencyMinutes: sub.frequencyMinutes,
        alertMetric: sub.alertMetric,
        alertOp: sub.alertOp,
        alertThreshold: sub.alertThreshold,
      },
      sub.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
    {/* 已保存固定报表 */}
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2.5 shadow-lg">
      <span className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
        <Bookmark className="w-3.5 h-3.5 text-indigo-400" />
        <span>我的固定报表（{savedQueries.length}）</span>
      </span>
      {savedQueries.length > 0 && (
        <div className="relative">
          <Search className="w-3 h-3 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="检索报表（名称/数据表）…"
            className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-7 pr-2 py-1.5 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
          />
        </div>
      )}
      {savedQueries.length === 0 ? (
        <p className="text-[11px] text-slate-500 py-3 text-center">
          暂无保存的报表。配置查询后点击「保存为固定报表」，下次一键载入执行。
        </p>
      ) : visibleSaved.length === 0 ? (
        <p className="text-[11px] text-slate-500 py-3 text-center">无匹配「{search.trim()}」的报表</p>
      ) : (
        <div className="space-y-1.5">
          {visibleSaved.map((item) => {
            const isFav = favoriteIds.includes(item.id);
            return (
              <div
                key={item.id}
                className="flex items-center justify-between bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-xs text-slate-200 font-semibold truncate">{item.name}</p>
                  <p className="text-[10px] text-slate-500">
                    {item.config.table} · {item.createdAt}
                  </p>
                </div>
                <div className="flex items-center space-x-1.5 shrink-0">
                  <button
                    onClick={() => onToggleFavorite(item.id)}
                    title={isFav ? '取消收藏' : '收藏（收藏项置顶展示）'}
                    className={isFav ? 'p-1 text-amber-400' : 'p-1 text-slate-500 hover:text-amber-400'}
                  >
                    <Star className={`w-3.5 h-3.5 ${isFav ? 'fill-current' : ''}`} />
                  </button>
                  <button
                    onClick={() => onLoadSaved(item)}
                    className="text-[10px] px-2 py-1 rounded-lg bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-600/50"
                  >
                    载入
                  </button>
                  <button
                    onClick={() => onOpenVersions(item.id, item.name)}
                    title="版本历史（每次保存快照，可回滚）"
                    className="p-1 text-slate-500 hover:text-sky-400"
                  >
                    <History className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onOpenSubscriptions(item.id, item.name)}
                    title="订阅（周期重跑 + 阈值告警）"
                    className="p-1 text-slate-500 hover:text-violet-400"
                  >
                    <Bell className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onExportExcel(item.id, item.name)}
                    title="导出 Excel（服务端重放，含溯源水印）"
                    className="p-1 text-slate-500 hover:text-emerald-400"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onDeleteSaved(item.id)}
                    className="p-1 text-slate-500 hover:text-rose-400"
                    title="删除该固定报表"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {savedQueries.length > 0 && (
        <button
          onClick={onGoDashboard}
          className="w-full text-[10px] text-slate-400 hover:text-slate-200 flex items-center justify-center space-x-1"
        >
          <Pin className="w-3 h-3" />
          <span>前往决策数据看板查看固化图表</span>
        </button>
      )}
    </div>

    {/* 最近查询历史（v0.4.10，参照 Agile Query 查询历史） */}
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2.5 shadow-lg">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
          <History className="w-3.5 h-3.5 text-indigo-400" />
          <span>最近查询历史（{history.length}）</span>
        </span>
        {history.length > 0 && (
          <button onClick={onClearHistory} className="text-[10px] text-slate-500 hover:text-rose-400">
            清空
          </button>
        )}
      </div>
      {history.length === 0 ? (
        <p className="text-[11px] text-slate-500 py-2 text-center">
          执行成功的查询会自动记录在此，点击还原配置后可重新执行。
        </p>
      ) : (
        <div className="space-y-1.5">
          {history.map((h) => (
            <div
              key={h.id}
              className="flex items-center justify-between bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-1.5"
            >
              <div className="min-w-0">
                <p className="text-[11px] text-slate-200 truncate">{h.name}</p>
                <p className="text-[10px] text-slate-500">{h.config.table} · {h.ranAt}</p>
              </div>
              <div className="flex items-center space-x-1 shrink-0">
                <button
                  onClick={() => onRestoreHistory(h)}
                  className="shrink-0 text-[10px] px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:border-indigo-500"
                >
                  还原
                </button>
                <button
                  onClick={() => onSaveFromHistory(h)}
                  title="以该历史配置直接保存为固定报表"
                  className="shrink-0 text-[10px] px-2 py-1 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-600/40"
                >
                  存为报表
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>

    {/* v0.9.77 P2-15：版本历史面板（每次保存/回滚生成不可变快照，回滚会生成新版本） */}
    {versionPanel && (
      <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onCloseVersions}>
        <div
          className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-xl max-h-[80vh] flex flex-col shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
            <span className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
              <History className="w-3.5 h-3.5 text-sky-400" />
              <span>版本历史 · {versionPanel.name}</span>
            </span>
            <button onClick={onCloseVersions} title="关闭" className="text-slate-400 hover:text-slate-200">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-3 space-y-1.5 overflow-y-auto">
            {loadingVersions ? (
              <p className="text-[11px] text-slate-500 py-6 text-center">加载中…</p>
            ) : versions.length === 0 ? (
              <p className="text-[11px] text-slate-500 py-6 text-center">暂无版本记录</p>
            ) : (
              versions.map((v) => (
                <div key={v.version} className="flex items-center justify-between bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-[11px] text-slate-200 flex items-center space-x-1.5">
                      <span className="font-mono text-sky-300">v{v.version}</span>
                      <span className={`px-1.5 py-0.5 rounded border text-[9px] ${VERSION_ACTION_BADGE[v.action] || 'border-slate-600 text-slate-400'}`}>
                        {v.action}
                      </span>
                    </p>
                    <p className="text-[10px] text-slate-500 truncate">
                      {v.remark || '—'} · {v.actor} · {fmtPanelTs(v.createdAt)}
                    </p>
                  </div>
                  <button
                    onClick={() => onRestoreVersion(versionPanel.queryId, v.version)}
                    title={`回滚到 v${v.version}（将生成新版本，不丢失历史）`}
                    className="shrink-0 flex items-center space-x-1 text-[10px] px-2 py-1 rounded-lg bg-sky-600/20 border border-sky-500/40 text-sky-300 hover:bg-sky-600/40"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>回滚</span>
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    )}

    {/* v0.9.77 P2-15：订阅面板（周期重跑 + 阈值告警 + 运行历史） */}
    {subPanel && (
      <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onCloseSubscriptions}>
        <div
          className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
            <span className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
              <Bell className="w-3.5 h-3.5 text-violet-400" />
              <span>报表订阅 · {subPanel.name}</span>
            </span>
            <button onClick={onCloseSubscriptions} title="关闭" className="text-slate-400 hover:text-slate-200">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-3 space-y-3 overflow-y-auto">
            {/* 新建订阅（校验提示由服务端统一给出） */}
            <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3 space-y-2">
              <p className="text-[10px] font-bold text-slate-400 uppercase">新建订阅</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="text-[10px] text-slate-400 space-y-1">
                  <span>执行周期（分钟，5 ~ 10080）</span>
                  <input
                    type="number"
                    min={5}
                    max={10080}
                    value={subForm.frequencyMinutes}
                    onChange={(e) => setSubForm((f) => ({ ...f, frequencyMinutes: Number(e.target.value) }))}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </label>
                <label className="text-[10px] text-slate-400 space-y-1">
                  <span>告警指标列名（留空 = 仅重跑不告警）</span>
                  <input
                    value={subForm.alertMetric}
                    onChange={(e) => setSubForm((f) => ({ ...f, alertMetric: e.target.value }))}
                    placeholder="结果列名，如 total_sales"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </label>
                <label className="text-[10px] text-slate-400 space-y-1">
                  <span>比较符</span>
                  <select
                    value={subForm.alertOp}
                    onChange={(e) => setSubForm((f) => ({ ...f, alertOp: e.target.value }))}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    {['>', '>=', '<', '<=', '='].map((op) => (
                      <option key={op} value={op}>{op}</option>
                    ))}
                  </select>
                </label>
                <label className="text-[10px] text-slate-400 space-y-1">
                  <span>告警阈值</span>
                  <input
                    type="number"
                    value={subForm.alertThreshold}
                    onChange={(e) => setSubForm((f) => ({ ...f, alertThreshold: Number(e.target.value) }))}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </label>
              </div>
              <button
                onClick={() => void handleCreateSub()}
                className="w-full text-[11px] py-1.5 rounded-lg bg-violet-600/30 border border-violet-500/40 text-violet-200 hover:bg-violet-600/50"
              >
                创建订阅（首次执行延后一个周期）
              </button>
            </div>

            {/* 订阅列表（全员可见，团队共享展示） */}
            {loadingSubs ? (
              <p className="text-[11px] text-slate-500 py-4 text-center">加载中…</p>
            ) : subscriptions.length === 0 ? (
              <p className="text-[11px] text-slate-500 py-4 text-center">暂无订阅。创建后系统将按周期自动重跑该报表。</p>
            ) : (
              <div className="space-y-1.5">
                {subscriptions.map((sub) => (
                  <div key={sub.subscriptionId} className="bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[11px] text-slate-200 flex items-center space-x-1.5">
                          <span className="font-semibold">{sub.username}</span>
                          <span className="text-slate-500">每 {sub.frequencyMinutes} 分钟</span>
                          <span className={`px-1.5 py-0.5 rounded border text-[9px] ${sub.status === 'ACTIVE' ? 'border-emerald-500/40 text-emerald-300 bg-emerald-600/15' : 'border-amber-500/40 text-amber-300 bg-amber-600/15'}`}>
                            {sub.status === 'ACTIVE' ? '运行中' : '已暂停'}
                          </span>
                        </p>
                        <p className="text-[10px] text-slate-500 truncate">
                          {sub.alertMetric ? `告警 ${sub.alertMetric} ${sub.alertOp} ${sub.alertThreshold}` : '仅重跑不告警'} · 下次 {fmtPanelTs(sub.nextRunAt) || '—'}
                        </p>
                      </div>
                      <div className="flex items-center space-x-1 shrink-0">
                        <button onClick={() => onRunSubscriptionNow(sub.subscriptionId)} title="立即执行一次（不改变排期）" className="p-1 text-slate-500 hover:text-emerald-400">
                          <Play className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => toggleRuns(sub.subscriptionId)}
                          title="运行历史"
                          className={expandedRuns[sub.subscriptionId] ? 'p-1 text-sky-400' : 'p-1 text-slate-500 hover:text-sky-400'}
                        >
                          <ListChecks className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleToggleStatus(sub)}
                          title={sub.status === 'ACTIVE' ? '暂停订阅' : '恢复订阅'}
                          className="p-1 text-slate-500 hover:text-amber-400"
                        >
                          {sub.status === 'ACTIVE' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                        </button>
                        <button onClick={() => onDeleteSubscription(sub.subscriptionId)} title="删除订阅" className="p-1 text-slate-500 hover:text-rose-400">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    {expandedRuns[sub.subscriptionId] && (
                      <div className="border-t border-slate-800/60 pt-1.5 space-y-1">
                        {(subRuns[sub.subscriptionId] || []).length === 0 ? (
                          <p className="text-[10px] text-slate-500 py-1 text-center">暂无运行记录</p>
                        ) : (
                          (subRuns[sub.subscriptionId] || []).map((run, ri) => (
                            <div key={ri} className="flex items-center justify-between gap-2 text-[10px]">
                              <span className="flex items-center space-x-1.5 min-w-0">
                                <span className={`px-1.5 py-0.5 rounded border text-[9px] shrink-0 ${RUN_STATUS_BADGE[run.status] || 'border-slate-600 text-slate-400'}`}>
                                  {run.status}
                                </span>
                                <span className="text-slate-400 truncate">
                                  {run.rowCount} 行{run.alertValue ? ` · 告警值 ${run.alertValue}` : ''}{run.message ? ` · ${run.message}` : ''}
                                </span>
                              </span>
                              <span className="text-slate-500 shrink-0">{fmtPanelTs(run.runAt)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )}
    </div>

  );
};
