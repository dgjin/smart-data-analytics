// P0 上帝组件拆分：自 FlexQueryBuilder 提取的字段面板（上区：表选择 + 字段列表 + 关联表配置）
// 纯展示组件：全部状态与行为由 useFlexQueryState 注入，JSX 与拆分前保持一致
import React from 'react';
import { Table2, Loader2, Search, Tag, Hash, Check, Filter, Plus, ChevronUp, ChevronDown, Gauge, Eye, X } from 'lucide-react';
import { TableSchema } from '../../types/analytics';
import { FlexJoin, FlexMetricMeasure } from '../../utils/flexQueryBuilder';
import { JoinConfigPanel } from './JoinConfigPanel';
import { DropZone, FieldTab, FieldWithTable, FlexTablePreview, MetricOption } from './flexQueryShared';

export interface FieldPaletteProps {
  tables: TableSchema[];
  loadingTables: boolean;
  schemaError: string | null;
  tableSchema: TableSchema | undefined;
  selectedTable: string;
  setSelectedTable: React.Dispatch<React.SetStateAction<string>>;
  resetBuilder: () => void;
  fieldSearch: string;
  setFieldSearch: React.Dispatch<React.SetStateAction<string>>;
  joins: FlexJoin[];
  setJoins: React.Dispatch<React.SetStateAction<FlexJoin[]>>;
  fieldTab: FieldTab;
  setFieldTab: React.Dispatch<React.SetStateAction<FieldTab>>;
  dimensionCols: FieldWithTable[];
  measureCols: FieldWithTable[];
  usedColumns: Set<string>;
  dimOpen: boolean;
  setDimOpen: React.Dispatch<React.SetStateAction<boolean>>;
  meaOpen: boolean;
  setMeaOpen: React.Dispatch<React.SetStateAction<boolean>>;
  addField: (column: string, zone?: DropZone) => void;
  /** v0.9.76 P1-7：语义指标（治理口径，归属表锁定，点击添加到指标区） */
  availableMetrics: MetricOption[];
  loadingMetrics: boolean;
  metricMeasures: FlexMetricMeasure[];
  addMetricMeasure: (id: number) => void;
  /** v0.9.77 P2-16：数据预览（样例 10 行，敏感列已剔除） */
  tablePreview: FlexTablePreview | null;
  previewTable: (table?: string) => Promise<void>;
  closePreview: () => void;
}

export const FieldPalette: React.FC<FieldPaletteProps> = ({
  tables,
  loadingTables,
  schemaError,
  tableSchema,
  selectedTable,
  setSelectedTable,
  resetBuilder,
  fieldSearch,
  setFieldSearch,
  joins,
  setJoins,
  fieldTab,
  setFieldTab,
  dimensionCols,
  measureCols,
  usedColumns,
  dimOpen,
  setDimOpen,
  meaOpen,
  setMeaOpen,
  addField,
  availableMetrics,
  loadingMetrics,
  metricMeasures,
  addMetricMeasure,
  tablePreview,
  previewTable,
  closePreview,
}) => {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-lg">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
          <Table2 className="w-3.5 h-3.5 text-indigo-400" />
          <span>数据表与字段</span>
        </span>
        <div className="flex items-center space-x-2 shrink-0">
          {selectedTable && (
            <button
              onClick={() => void previewTable()}
              className="flex items-center space-x-1 text-[10px] text-indigo-300 hover:text-indigo-200"
              title="查看该表前 10 行样例数据（敏感列已自动剔除）"
            >
              <Eye className="w-3 h-3" />
              <span>预览数据</span>
            </button>
          )}
          {loadingTables && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
        </div>
      </div>
      {schemaError && <p className="text-[11px] text-rose-400">{schemaError}</p>}
      {/* v0.4.13：选表与搜索并排，充分利用全宽 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <select
          data-testid="flexquery-table-select"
          value={selectedTable}
          onChange={(e) => {
            setSelectedTable(e.target.value);
            resetBuilder();
          }}
          className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-500"
        >
          <option value="">请选择数据表…</option>
          {tables.map((t) => (
            <option key={t.id} value={t.name}>
              {t.displayName || t.name}（{t.rowCount.toLocaleString()} 行）
            </option>
          ))}
        </select>

        {tableSchema && (
          <div className="relative">
            <Search className="w-3 h-3 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={fieldSearch}
              onChange={(e) => setFieldSearch(e.target.value)}
              placeholder="搜索字段（名称/描述）…"
              className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-7 pr-2 py-2 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
            />
          </div>
        )}
      </div>

      {/* v0.4.14：关联表配置（P0-1 拆至 JoinConfigPanel，多表 JOIN） */}
      <JoinConfigPanel
        tableSchema={tableSchema}
        joins={joins}
        onChange={setJoins}
        tables={tables}
        selectedTable={selectedTable}
      />

      {/* v0.9.77 P2-16：样例数据预览（内联面板；loading/错误/空数据三态） */}
      {tablePreview && (
        <div className="border border-slate-800 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1 bg-slate-950/80 text-[10px] text-slate-400">
            <span>
              数据预览 · {tablePreview.table}
              {!tablePreview.loading && !tablePreview.error ? `（样例 ${tablePreview.rows.length} 行）` : ''}
            </span>
            <button onClick={closePreview} title="关闭预览" className="text-slate-400 hover:text-slate-200">
              <X className="w-3 h-3" />
            </button>
          </div>
          {tablePreview.loading ? (
            <p className="text-[10px] text-slate-500 p-3 text-center">加载中…</p>
          ) : tablePreview.error ? (
            <p className="text-[10px] text-rose-400 p-3 text-center">{tablePreview.error}</p>
          ) : tablePreview.rows.length === 0 ? (
            <p className="text-[10px] text-slate-500 p-3 text-center">表中暂无数据</p>
          ) : (
            <div className="overflow-x-auto max-h-[30vh] overflow-y-auto">
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-slate-950">
                  <tr className="text-slate-400">
                    {tablePreview.columns.map((col) => (
                      <th key={col} className="text-left px-2 py-1 font-semibold whitespace-nowrap">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tablePreview.rows.map((r, ri) => (
                    <tr key={ri} className="border-t border-slate-800/60">
                      {tablePreview.columns.map((col) => (
                        <td key={col} className="px-2 py-1 text-slate-300 whitespace-nowrap max-w-[220px] truncate">
                          {r[col] === null || r[col] === undefined || r[col] === '' ? '-' : String(r[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tableSchema && (
        <>
          {/* v0.4.11：类型页签——字段较多时只看维度或只看指标，减少滚动 */}
          <div className="flex rounded-lg bg-slate-800 border border-slate-700 p-0.5 text-[10px]">
            {(
              [
                ['all', `全部 ${tableSchema.columns.length}`],
                ['dimension', `维度 ${dimensionCols.length}`],
                ['measure', `指标 ${measureCols.length}`],
              ] as [FieldTab, string][]
            ).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setFieldTab(tab)}
                className={`flex-1 px-1 py-1 rounded-md transition-colors ${
                  fieldTab === tab ? 'bg-indigo-600/60 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 字段行式列表（v0.4.11 单行紧凑；v0.4.13 全宽下维度/指标左右并排） */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {fieldTab !== 'measure' && (
              <div>
                <button
                  onClick={() => setDimOpen((v) => !v)}
                  className="w-full flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase px-1 py-0.5 hover:text-slate-200"
                >
                  <span className="flex items-center space-x-1">
                    <Tag className="w-3 h-3 text-cyan-400" />
                    <span>维度字段（{dimensionCols.length}）</span>
                  </span>
                  {dimOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                {dimOpen &&
                  (dimensionCols.length === 0 ? (
                    <p className="text-[10px] text-slate-500 px-1 py-1">无匹配字段</p>
                  ) : (
                    <div className="space-y-px max-h-[36vh] overflow-y-auto pr-0.5">
                      {dimensionCols.map((c) => {
                        const used = usedColumns.has(c.fullName);
                        const isJoined = c.table !== selectedTable;
                        return (
                          <div
                            key={c.fullName}
                            draggable
                            onDragStart={(e) => e.dataTransfer.setData('text/plain', c.fullName)}
                            title={`${c.fullName}${c.description ? ` · ${c.description}` : ''}（点击加为维度，或拖至右侧区域）`}
                            onClick={() => addField(c.fullName, 'dimension')}
                            className={`group flex items-center space-x-1.5 px-1.5 py-1 rounded-lg cursor-grab text-[11px] hover:bg-slate-800/80 ${
                              used ? 'text-cyan-300' : 'text-slate-300'
                            }`}
                          >
                            {used ? (
                              <Check className="w-3 h-3 text-cyan-400 shrink-0" />
                            ) : (
                              <Tag className="w-3 h-3 text-slate-600 group-hover:text-cyan-400 shrink-0" />
                            )}
                            <span className="truncate flex-1">
                              {isJoined && <span className="text-cyan-500 mr-1">[{c.table}]</span>}
                              {c.description || c.name}
                            </span>
                            <button
                              onClick={(e) => { e.stopPropagation(); addField(c.fullName, 'filter'); }}
                              title="添加为筛选条件"
                              className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded hover:bg-amber-500/20"
                            >
                              <Filter className="w-3 h-3 text-amber-400" />
                            </button>
                            <Plus className="w-3 h-3 text-slate-600 opacity-0 group-hover:opacity-100 shrink-0" />
                          </div>
                        );
                      })}
                    </div>
                  ))}
              </div>
            )}
            {fieldTab !== 'dimension' && (
              <div>
                <button
                  onClick={() => setMeaOpen((v) => !v)}
                  className="w-full flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase px-1 py-0.5 hover:text-slate-200"
                >
                  <span className="flex items-center space-x-1">
                    <Hash className="w-3 h-3 text-emerald-400" />
                    <span>指标字段（{measureCols.length}）</span>
                  </span>
                  {meaOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                {meaOpen &&
                  (measureCols.length === 0 ? (
                    <p className="text-[10px] text-slate-500 px-1 py-1">无匹配字段</p>
                  ) : (
                    <div className="space-y-px max-h-[36vh] overflow-y-auto pr-0.5">
                      {measureCols.map((c) => {
                        const used = usedColumns.has(c.fullName);
                        const isJoined = c.table !== selectedTable;
                        return (
                          <div
                            key={c.fullName}
                            draggable
                            onDragStart={(e) => e.dataTransfer.setData('text/plain', c.fullName)}
                            title={`${c.fullName}${c.description ? ` · ${c.description}` : ''}（点击加为指标，或拖至右侧区域）`}
                            onClick={() => addField(c.fullName, 'measure')}
                            className={`group flex items-center space-x-1.5 px-1.5 py-1 rounded-lg cursor-grab text-[11px] hover:bg-slate-800/80 ${
                              used ? 'text-emerald-300' : 'text-slate-300'
                            }`}
                          >
                            {used ? (
                              <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                            ) : (
                              <Hash className="w-3 h-3 text-slate-600 group-hover:text-emerald-400 shrink-0" />
                            )}
                            <span className="truncate flex-1">
                              {isJoined && <span className="text-emerald-500 mr-1">[{c.table}]</span>}
                              {c.description || c.name}
                            </span>
                            <button
                              onClick={(e) => { e.stopPropagation(); addField(c.fullName, 'having'); }}
                              title="添加为 HAVING 指标过滤"
                              className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded hover:bg-fuchsia-500/20"
                            >
                              <Filter className="w-3 h-3 text-fuchsia-400" />
                            </button>
                            <Plus className="w-3 h-3 text-slate-600 opacity-0 group-hover:opacity-100 shrink-0" />
                          </div>
                        );
                      })}
                    </div>
                  ))}
              </div>
            )}
            {fieldTab !== 'dimension' && (
              <div>
                <p className="flex items-center space-x-1 text-[10px] font-bold text-slate-400 uppercase px-1 py-0.5">
                  <Gauge className="w-3 h-3 text-violet-400" />
                  <span>语义指标（{availableMetrics.length}）</span>
                  {loadingMetrics && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
                </p>
                {loadingMetrics && availableMetrics.length === 0 ? (
                  <p className="text-[10px] text-slate-500 px-1 py-1">语义指标加载中…</p>
                ) : availableMetrics.length === 0 ? (
                  <p className="text-[10px] text-slate-500 px-1 py-1">当前数据源暂无已生效的语义指标（可在指标治理中创建）</p>
                ) : (
                  <div className="space-y-px max-h-[28vh] overflow-y-auto pr-0.5">
                    {availableMetrics.map((m) => {
                      const used = metricMeasures.some((x) => x.id === m.id);
                      const tableMismatch = !!tableSchema && m.tableName !== tableSchema.name;
                      return (
                        <div
                          key={m.id}
                          onClick={() => addMetricMeasure(m.id)}
                          title={`${m.name} · ${m.expr}${m.filters ? ` · 固定过滤：${m.filters}` : ''}（归属表：${m.tableName}）${tableMismatch ? ' · 需先切换数据表' : ''}（点击添加到语义指标区）`}
                          className={`group flex items-center space-x-1.5 px-1.5 py-1 rounded-lg cursor-pointer text-[11px] hover:bg-slate-800/80 ${
                            used ? 'text-violet-300' : tableMismatch ? 'text-slate-500' : 'text-slate-300'
                          }`}
                        >
                          {used ? (
                            <Check className="w-3 h-3 text-violet-400 shrink-0" />
                          ) : (
                            <Gauge className="w-3 h-3 text-slate-600 group-hover:text-violet-400 shrink-0" />
                          )}
                          <span className="truncate flex-1">{m.name}</span>
                          <span className={`text-[9px] shrink-0 ${tableMismatch ? 'text-amber-500/80' : 'text-slate-500'}`}>{m.tableName}</span>
                          <Plus className="w-3 h-3 text-slate-600 opacity-0 group-hover:opacity-100 shrink-0" />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
