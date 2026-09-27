// P0 上帝组件拆分：自 FlexQueryBuilder 提取的结果预览区（下区：图表/明细 + 快速计算 + 固化保存 + 固定报表库）
// 纯展示组件：全部状态与行为由 useFlexQueryState 注入，JSX 与拆分前保持一致
import React from 'react';
import { Pin, Save, Percent, Sigma, LayoutGrid, Download, Maximize2, Minimize2, Zap, RefreshCw, Layers, TrendingUp, AlertTriangle } from 'lucide-react';
import { DynamicChart } from '../charts/DynamicChart';
import { DataTable } from '../charts/DataTable';
import { DrillModal } from '../reports/DrillModal';
import { ChartConfig, ChartType } from '../../types/analytics';
import { FlexHistoryItem, FlexQueryLibrary, SavedFlexQuery } from './FlexQueryLibrary';
import { CHART_TYPE_OPTIONS, FlexBuilt, FlexPivot, FlexResult, FlexSubRunItem, FlexSubscriptionItem, FlexSubscriptionPayload, FlexVersionItem } from './flexQueryShared';

export interface PreviewPanelProps {
  fullZone: 'config' | 'result' | null;
  setFullZone: React.Dispatch<React.SetStateAction<'config' | 'result' | null>>;
  result: FlexResult | null;
  execError: string | null;
  execTimeMs: number | null;
  queryName: string;
  setQueryName: React.Dispatch<React.SetStateAction<string>>;
  chartType: ChartType;
  setChartType: React.Dispatch<React.SetStateAction<ChartType>>;
  /** v0.9.77 P2-14c：堆叠（柱/面积）与双轴（柱/折线/面积，需 ≥2 指标）视图开关 */
  chartStacked: boolean;
  setChartStacked: React.Dispatch<React.SetStateAction<boolean>>;
  chartDualAxis: boolean;
  setChartDualAxis: React.Dispatch<React.SetStateAction<boolean>>;
  showPct: boolean;
  setShowPct: React.Dispatch<React.SetStateAction<boolean>>;
  /** v0.9.75：合计行开关与合计行数据（结果截断时禁用） */
  showTotals: boolean;
  setShowTotals: React.Dispatch<React.SetStateAction<boolean>>;
  totalsRow: Record<string, unknown> | null;
  pivotMode: boolean;
  setPivotMode: React.Dispatch<React.SetStateAction<boolean>>;
  pivotAvailable: boolean;
  pivot: FlexPivot | null;
  chartConfig: ChartConfig | null;
  displayRows: Record<string, unknown>[];
  displayColumns: string[];
  columnNames: Record<string, string>;
  handleExportCsv: () => Promise<void>;
  handlePin: () => void;
  handleSave: () => void;
  built: FlexBuilt;
  savedQueries: SavedFlexQuery[];
  history: FlexHistoryItem[];
  loadSaved: (item: SavedFlexQuery) => void;
  loadHistory: (h: FlexHistoryItem) => void;
  deleteSavedQuery: (id: string) => Promise<void>;
  persistHistory: (list: FlexHistoryItem[]) => void;
  goDashboard: () => void;
  /** v0.9.75：收藏（本地偏好）/ 历史一键存为报表 */
  favoriteIds: string[];
  onToggleFavorite: (id: string) => void;
  onSaveFromHistory: (h: FlexHistoryItem) => void;
  /** v0.9.76：结果缓存标记与强制刷新 / 图表下钻 */
  resultCached: boolean;
  runQueryForceRefresh: () => void;
  chartDrillable: boolean;
  drillTarget: { dimensionKey: string; dimensionValue: string; dimensionLabel: string; originalSql: string } | null;
  handleDrill: (dimensionKey: string, dimensionValue: string | number) => void;
  closeDrill: () => void;
  activeDataSourceId: string;
  /** v0.9.77 P2-14a：EXPLAIN 预估扫描行数（防线关闭/评估失败时为 null） */
  estimatedRows: number | null;
  /** v0.9.77 P2-15：版本历史 / 订阅 / Excel 导出（透传固定报表库） */
  versionPanel: { queryId: string; name: string } | null;
  versions: FlexVersionItem[];
  loadingVersions: boolean;
  onOpenVersions: (queryId: string, name: string) => void;
  onCloseVersions: () => void;
  onRestoreVersion: (queryId: string, version: number) => void;
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
  onExportExcel: (queryId: string, name: string) => void;
}

export const PreviewPanel: React.FC<PreviewPanelProps> = ({
  fullZone,
  setFullZone,
  result,
  execError,
  execTimeMs,
  queryName,
  setQueryName,
  chartType,
  setChartType,
  chartStacked,
  setChartStacked,
  chartDualAxis,
  setChartDualAxis,
  showPct,
  setShowPct,
  showTotals,
  setShowTotals,
  totalsRow,
  pivotMode,
  setPivotMode,
  pivotAvailable,
  pivot,
  chartConfig,
  displayRows,
  displayColumns,
  columnNames,
  handleExportCsv,
  handlePin,
  handleSave,
  built,
  savedQueries,
  history,
  loadSaved,
  loadHistory,
  deleteSavedQuery,
  persistHistory,
  goDashboard,
  favoriteIds,
  onToggleFavorite,
  onSaveFromHistory,
  resultCached,
  runQueryForceRefresh,
  chartDrillable,
  drillTarget,
  handleDrill,
  closeDrill,
  activeDataSourceId,
  estimatedRows,
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
  return (
    <div
      className={
        fullZone === 'result'
          ? 'fixed inset-0 z-50 bg-slate-950 p-4 md:p-6 space-y-4 overflow-y-auto'
          : 'space-y-4'
      }
    >
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-lg">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs font-bold text-slate-200">查询结果</span>
          <div className="flex items-center space-x-2">
            {result && (
              <span className="text-[10px] text-slate-400">
                {result.rows.length} 行{result.truncated ? '（已达行数上限，结果被截断）' : ''}
                {execTimeMs !== null ? ` · ${execTimeMs}ms` : ''}
              </span>
            )}
            {/* v0.9.77 P2-14a：EXPLAIN 预估扫描行数（超 10 万行时高亮提示收窄筛选） */}
            {result && estimatedRows !== null && (
              <span
                className={`flex items-center space-x-1 text-[10px] border rounded-lg px-1.5 py-0.5 ${
                  estimatedRows > 100000
                    ? 'text-amber-300 bg-amber-950/50 border-amber-500/40'
                    : 'text-slate-400 bg-slate-900/60 border-slate-700'
                }`}
                title="执行前 EXPLAIN 预估的扫描行数（MySQL 优化器估算，仅供参考）"
              >
                <AlertTriangle className="w-3 h-3" />
                <span>
                  预估扫描 {estimatedRows.toLocaleString('zh-CN')} 行{estimatedRows > 100000 ? '，建议收窄筛选条件' : ''}
                </span>
              </span>
            )}
            {/* v0.9.76 P1-9：服务端结果缓存命中标记 + 跳过缓存强制刷新 */}
            {result && resultCached && (
              <span className="flex items-center space-x-1 text-[10px] text-emerald-300 bg-emerald-950/50 border border-emerald-500/40 rounded-lg px-1.5 py-0.5">
                <Zap className="w-3 h-3" />
                <span>缓存命中</span>
                <button
                  onClick={runQueryForceRefresh}
                  title="跳过缓存重新查询（获取最新数据）"
                  className="flex items-center space-x-0.5 text-emerald-200 hover:text-white ml-0.5"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>强制刷新</span>
                </button>
              </span>
            )}
            <button
              onClick={() => setFullZone(fullZone === 'result' ? null : 'result')}
              title={fullZone === 'result' ? '退出全屏（Esc）' : '全屏查看查询结果'}
              className="text-[10px] text-slate-400 hover:text-slate-200 flex items-center space-x-1"
            >
              {fullZone === 'result' ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
              <span>{fullZone === 'result' ? '退出全屏' : '全屏'}</span>
            </button>
          </div>
        </div>
        {execError && <p className="text-[11px] text-rose-400">{execError}</p>}
        {!result && !execError && (
          <p className="text-[11px] text-slate-500 text-center py-8">执行查询后在此展示图表与明细</p>
        )}
        {result && (
          <>
            <div className="flex items-center space-x-2 flex-wrap gap-y-2">
              <input
                value={queryName}
                onChange={(e) => setQueryName(e.target.value)}
                placeholder="报表名称（固化/保存用）"
                className="flex-1 min-w-[140px] bg-slate-800 border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              />
              <select
                value={chartType}
                onChange={(e) => setChartType(e.target.value as ChartType)}
                className="bg-slate-800 border border-slate-700 rounded-xl px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
              >
                {CHART_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 快速计算与视图切换（v0.4.10，参照 Agile Query） */}
            <div className="flex items-center space-x-2 flex-wrap gap-y-1.5 text-[11px]">
              <label
                className="flex items-center space-x-1 text-slate-300 cursor-pointer"
                title="首指标占总和的百分比，追加新列展示"
              >
                <input
                  type="checkbox"
                  checked={showPct}
                  onChange={(e) => setShowPct(e.target.checked)}
                  className="accent-indigo-500"
                />
                <Percent className="w-3 h-3 text-indigo-400" />
                <span>占比快速计算</span>
              </label>
              {/* v0.9.75：合计行（客户端累计；结果被截断时禁用防止展示不完整合计） */}
              <label
                className={`flex items-center space-x-1 ${result.truncated ? 'text-slate-500 cursor-not-allowed' : 'text-slate-300 cursor-pointer'}`}
                title={
                  result.truncated
                    ? '结果已达行数上限被截断，合计不完整已禁用'
                    : '追加合计行：求和/计数列累加，最值列取全局最值（平均/去重计数显示 -）'
                }
              >
                <input
                  type="checkbox"
                  checked={showTotals && !result.truncated}
                  disabled={!!result.truncated}
                  onChange={(e) => setShowTotals(e.target.checked)}
                  className="accent-emerald-500"
                />
                <Sigma className="w-3 h-3 text-emerald-400" />
                <span>合计行</span>
              </label>
              {/* v0.9.77 P2-14c：堆叠视图（柱/面积） */}
              {(chartType === 'bar' || chartType === 'area') && (
                <label
                  className="flex items-center space-x-1 text-slate-300 cursor-pointer"
                  title="多个指标同轴堆叠展示（柱状/面积图）"
                >
                  <input
                    type="checkbox"
                    checked={chartStacked}
                    onChange={(e) => setChartStacked(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <Layers className="w-3 h-3 text-indigo-400" />
                  <span>堆叠</span>
                </label>
              )}
              {/* v0.9.77 P2-14c：双轴视图（柱/折线/面积，需 ≥2 指标） */}
              {(chartType === 'bar' || chartType === 'line' || chartType === 'area') && (
                <label
                  className="flex items-center space-x-1 text-slate-300 cursor-pointer"
                  title="第 1 个指标用左轴，第 2 个指标用右轴（需至少 2 个指标）"
                >
                  <input
                    type="checkbox"
                    checked={chartDualAxis}
                    onChange={(e) => setChartDualAxis(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <TrendingUp className="w-3 h-3 text-amber-400" />
                  <span>双轴</span>
                </label>
              )}
              <button
                onClick={() => setPivotMode((v) => !v)}
                disabled={!pivotAvailable}
                title={pivotAvailable ? '行列维度交叉展示为透视表' : '需 2 个维度且恰好 1 个指标才可用透视图'}
                className={`flex items-center space-x-1 px-2 py-1 rounded-lg border transition-colors ${
                  pivotMode
                    ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-300'
                    : pivotAvailable
                      ? 'bg-slate-800 border-slate-700 text-slate-300 hover:border-indigo-500'
                      : 'bg-slate-800 border-slate-700 text-slate-600 cursor-not-allowed'
                }`}
              >
                <LayoutGrid className="w-3 h-3" />
                <span>透视图</span>
              </button>
              <button
                onClick={handleExportCsv}
                className="flex items-center space-x-1 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:border-emerald-500"
              >
                <Download className="w-3 h-3" />
                <span>导出 CSV</span>
              </button>
            </div>

            {chartConfig && !pivotMode && (
              <DynamicChart
                config={chartConfig}
                data={result.rows}
                height={fullZone === 'result' ? 440 : 260}
                onDrill={chartDrillable ? handleDrill : undefined}
                drillable={chartDrillable}
              />
            )}

            {pivotMode && pivot ? (
              <div className="overflow-x-auto border border-slate-800 rounded-xl">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="bg-slate-950/80 text-slate-400">
                      <th className="text-left px-2.5 py-1.5 font-semibold whitespace-nowrap">
                        {columnNames[pivot.rowDim] || pivot.rowDim}
                      </th>
                      {pivot.cols.map((ck) => (
                        <th key={ck} className="text-right px-2.5 py-1.5 font-semibold whitespace-nowrap">
                          {ck}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...pivot.map.entries()].map(([rk, rowObj]) => (
                      <tr key={rk} className="border-t border-slate-800/60">
                        <td className="px-2.5 py-1.5 text-slate-200 whitespace-nowrap">{rk}</td>
                        {pivot.cols.map((ck) => {
                          const v = rowObj[ck];
                          return (
                            <td key={ck} className="px-2.5 py-1.5 text-right text-slate-300 font-mono whitespace-nowrap">
                              {typeof v === 'number'
                                ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
                                : v == null ? '-' : String(v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <DataTable
                data={totalsRow ? [...displayRows, totalsRow] : displayRows}
                columns={displayColumns}
                columnNames={columnNames}
                pageSize={fullZone === 'result' ? 14 : 8}
              />
            )}

            <div className="flex items-center space-x-2">
              <button
                onClick={handlePin}
                disabled={!chartConfig || !built?.ok}
                className={`flex-1 flex items-center justify-center space-x-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all ${
                  !chartConfig || !built?.ok
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                    : 'bg-emerald-600/80 hover:bg-emerald-500 text-white'
                }`}
                title="固化图表至看板，数据变化时自动重放 SQL 更新"
              >
                <Pin className="w-3.5 h-3.5" />
                <span>固化至看板（自动更新）</span>
              </button>
              <button
                onClick={handleSave}
                disabled={!built?.ok}
                className={`flex-1 flex items-center justify-center space-x-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all ${
                  !built?.ok
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                    : 'bg-indigo-600/80 hover:bg-indigo-500 text-white'
                }`}
              >
                <Save className="w-3.5 h-3.5" />
                <span>保存为固定报表</span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* v0.9.76 P1-12：图表下钻明细弹层（复用 /api/query/drill AST 改写） */}
      {drillTarget && (
        <DrillModal
          open
          onClose={closeDrill}
          dataSourceId={activeDataSourceId}
          originalSql={drillTarget.originalSql}
          dimensionKey={drillTarget.dimensionKey}
          dimensionValue={drillTarget.dimensionValue}
          dimensionLabel={drillTarget.dimensionLabel}
        />
      )}

      {/* v0.4.13：固定报表与最近查询历史（P0-1 拆至 FlexQueryLibrary） */}
      <FlexQueryLibrary
        savedQueries={savedQueries}
        history={history}
        onLoadSaved={loadSaved}
        onDeleteSaved={(id) => void deleteSavedQuery(id)}
        onGoDashboard={goDashboard}
        onClearHistory={() => persistHistory([])}
        onRestoreHistory={loadHistory}
        favoriteIds={favoriteIds}
        onToggleFavorite={onToggleFavorite}
        onSaveFromHistory={onSaveFromHistory}
        versionPanel={versionPanel}
        versions={versions}
        loadingVersions={loadingVersions}
        onOpenVersions={onOpenVersions}
        onCloseVersions={onCloseVersions}
        onRestoreVersion={onRestoreVersion}
        subPanel={subPanel}
        subscriptions={subscriptions}
        loadingSubs={loadingSubs}
        subRuns={subRuns}
        onOpenSubscriptions={onOpenSubscriptions}
        onCloseSubscriptions={onCloseSubscriptions}
        onCreateSubscription={onCreateSubscription}
        onUpdateSubscription={onUpdateSubscription}
        onDeleteSubscription={onDeleteSubscription}
        onRunSubscriptionNow={onRunSubscriptionNow}
        onLoadSubRuns={onLoadSubRuns}
        onExportExcel={onExportExcel}
      />
    </div>
  );
};
