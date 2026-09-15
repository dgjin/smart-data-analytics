import React from 'react';
import { SlidersHorizontal, Database } from 'lucide-react';
import { AmountUnitSelect } from '../common/AmountUnitSelect';
import { useFlexQueryState } from './hooks/useFlexQueryState';
import { FieldPalette } from './FieldPalette';
import { BuilderCanvas } from './BuilderCanvas';
import { PreviewPanel } from './PreviewPanel';

/**
 * 灵活查询构建器（P0 上帝组件拆分：1404 行 → 状态 Hook + 三个子组件，行为保持一致）。
 * 本组件仅保留顶部标题栏/数据源切换、能力不可用兜底与 Toast，其余渲染下放：
 * - FieldPalette：数据表与字段面板（上区）
 * - BuilderCanvas：查询配置画布（中区，拖放/排序/行数/SQL 预览/执行）
 * - PreviewPanel：查询结果与固定报表库（下区）
 */
export const FlexQueryBuilder: React.FC = () => {
  const {
    // store 透出
    dataSources,
    activeDataSourceId,
    setActiveDataSource,
    goDashboard,
    // 数据源能力判定
    activeDS,
    dbSupported,
    // Schema
    tables,
    loadingTables,
    schemaError,
    tableSchema,
    // 查询构建状态
    selectedTable,
    setSelectedTable,
    dimensions,
    setDimensions,
    measures,
    setMeasures,
    filters,
    setFilters,
    havings,
    setHavings,
    orderBy,
    setOrderBy,
    fieldSearch,
    setFieldSearch,
    fieldTab,
    setFieldTab,
    dimOpen,
    setDimOpen,
    meaOpen,
    setMeaOpen,
    sqlOpen,
    setSqlOpen,
    advOpen,
    setAdvOpen,
    fullZone,
    setFullZone,
    showPct,
    setShowPct,
    pivotMode,
    setPivotMode,
    limit,
    setLimit,
    joins,
    setJoins,
    chartType,
    setChartType,
    queryName,
    setQueryName,
    // 派生
    isOrderByValid,
    allFields,
    dimensionCols,
    measureCols,
    usedColumns,
    columnNames,
    built,
    // 执行结果
    result,
    executing,
    execError,
    execTimeMs,
    toast,
    // 快速计算
    pivot,
    pivotAvailable,
    displayRows,
    displayColumns,
    chartConfig,
    // 行为
    addField,
    resetBuilder,
    runQuery,
    handleExportCsv,
    handlePin,
    handleSave,
    // 固定报表 / 历史
    savedQueries,
    history,
    deleteSavedQuery,
    persistHistory,
    loadSaved,
    loadHistory,
  } = useFlexQueryState();

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-4 md:p-6 space-y-5">
      {/* Top Banner（v0.4.11 紧凑化：标题单行 + 一句话说明） */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 flex items-center justify-between gap-3 shadow-xl">
        <div className="min-w-0">
          <div className="flex items-center space-x-2">
            <SlidersHorizontal className="w-4 h-4 text-indigo-400 shrink-0" />
            <h1 className="text-base font-extrabold text-slate-100 tracking-tight truncate">灵活查询 · 拖拉拽定制固定报表</h1>
          </div>
          <p className="text-[11px] text-slate-400 truncate">
            拖入维度/指标/筛选/HAVING，支持占比、透视、CSV 导出；可固化看板（自动更新）或保存为固定报表
          </p>
        </div>
        <div className="flex items-center space-x-2 shrink-0">
          {/* v0.5.4 金额单位：默认跟随全局，可单独选择本模块口径（优先于全局设置） */}
          <AmountUnitSelect module="flexquery" />
          <Database className="w-4 h-4 text-indigo-400" />
          <select
            data-testid="flexquery-datasource-select"
            value={activeDataSourceId}
            onChange={(e) => setActiveDataSource(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500"
          >
            {dataSources.length === 0 && <option value="">暂无数据源</option>}
            {dataSources.map((ds) => (
              <option key={ds.id} value={ds.id}>
                {ds.name}（{ds.type.toUpperCase()}）
              </option>
            ))}
          </select>
        </div>
      </div>

      {!dbSupported ? (
        <div className="p-10 text-center bg-slate-900/50 border border-slate-800 rounded-3xl space-y-2">
          <Database className="w-8 h-8 text-slate-500 mx-auto" />
          <p className="text-sm text-slate-300 font-semibold">当前数据源不支持灵活查询</p>
          <p className="text-xs text-slate-400">
            {activeDS?.status === 'disconnected'
              ? '该数据源已被管理员停用'
              : '仅 MySQL / PostgreSQL / Greenplum 及已导入落库的 CSV/Excel/JSON 文件数据源支持拖拉拽查询，请在上方切换数据源'}
          </p>
        </div>
      ) : (
        // v0.4.13：上（字段）/中（配置）/下（结果）纵向布局
        <div className="space-y-5">
          {/* 上：表选择 + 字段列表 */}
          <FieldPalette
            tables={tables}
            loadingTables={loadingTables}
            schemaError={schemaError}
            tableSchema={tableSchema}
            selectedTable={selectedTable}
            setSelectedTable={setSelectedTable}
            resetBuilder={resetBuilder}
            fieldSearch={fieldSearch}
            setFieldSearch={setFieldSearch}
            joins={joins}
            setJoins={setJoins}
            fieldTab={fieldTab}
            setFieldTab={setFieldTab}
            dimensionCols={dimensionCols}
            measureCols={measureCols}
            usedColumns={usedColumns}
            dimOpen={dimOpen}
            setDimOpen={setDimOpen}
            meaOpen={meaOpen}
            setMeaOpen={setMeaOpen}
            addField={addField}
          />

          {/* 中：拖放区 + SQL + 执行（v0.4.12：支持全屏） */}
          <BuilderCanvas
            fullZone={fullZone}
            setFullZone={setFullZone}
            resetBuilder={resetBuilder}
            addField={addField}
            dimensions={dimensions}
            setDimensions={setDimensions}
            measures={measures}
            setMeasures={setMeasures}
            filters={filters}
            setFilters={setFilters}
            havings={havings}
            setHavings={setHavings}
            orderBy={orderBy}
            setOrderBy={setOrderBy}
            isOrderByValid={isOrderByValid}
            limit={limit}
            setLimit={setLimit}
            advOpen={advOpen}
            setAdvOpen={setAdvOpen}
            columnNames={columnNames}
            allFields={allFields}
            measureCols={measureCols}
            built={built}
            sqlOpen={sqlOpen}
            setSqlOpen={setSqlOpen}
            runQuery={runQuery}
            executing={executing}
          />

          {/* 下：结果 + 固定报表（v0.4.12：支持全屏） */}
          <PreviewPanel
            fullZone={fullZone}
            setFullZone={setFullZone}
            result={result}
            execError={execError}
            execTimeMs={execTimeMs}
            queryName={queryName}
            setQueryName={setQueryName}
            chartType={chartType}
            setChartType={setChartType}
            showPct={showPct}
            setShowPct={setShowPct}
            pivotMode={pivotMode}
            setPivotMode={setPivotMode}
            pivotAvailable={pivotAvailable}
            pivot={pivot}
            chartConfig={chartConfig}
            displayRows={displayRows}
            displayColumns={displayColumns}
            columnNames={columnNames}
            handleExportCsv={handleExportCsv}
            handlePin={handlePin}
            handleSave={handleSave}
            built={built}
            savedQueries={savedQueries}
            history={history}
            loadSaved={loadSaved}
            loadHistory={loadHistory}
            deleteSavedQuery={deleteSavedQuery}
            persistHistory={persistHistory}
            goDashboard={goDashboard}
          />
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-xl bg-slate-800 border border-indigo-500/40 text-slate-100 text-xs shadow-2xl animate-fadeIn">
          {toast}
        </div>
      )}
    </div>
  );
};
