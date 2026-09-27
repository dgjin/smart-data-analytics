// P0 上帝组件拆分：自 FlexQueryBuilder 提取的查询配置画布（中区：拖放区 + 排序行数 + SQL 预览 + 执行）
// 纯展示组件：拖拽悬停态（dragOverZone）为纯视觉关注点，收敛至本组件本地状态；其余由 useFlexQueryState 注入
import React, { useState } from 'react';
import { X, Play, Loader2, Filter, ArrowUpDown, RotateCcw, Maximize2, Minimize2, ChevronUp, ChevronDown, Gauge, TrendingUp } from 'lucide-react';
import {
  FLEX_AGGS,
  FLEX_DERIVED_KINDS,
  FLEX_FILTER_OPS,
  FLEX_HAVING_OPS,
  FLEX_LIKE_MODES,
  FLEX_NO_VALUE_OPS,
  FLEX_TIME_UNITS,
  derivedAlias,
  measureAlias,
  metricAlias,
  FlexAgg,
  FlexDerived,
  FlexDerivedKind,
  FlexLikeMode,
  FlexMeasure,
  FlexMetricMeasure,
  FlexFilter,
  FlexHaving,
  FlexOrderBy,
  FlexTimeUnit,
} from '../../utils/flexQueryBuilder';
import { SqlPreviewPanel } from './SqlPreviewPanel';
import {
  AGG_LABELS,
  ColumnValuesState,
  DERIVED_LABELS,
  DropZone,
  FieldWithTable,
  FlexBuilt,
  LIKE_MODE_LABELS,
  TIME_UNIT_LABELS,
} from './flexQueryShared';

export interface BuilderCanvasProps {
  fullZone: 'config' | 'result' | null;
  setFullZone: React.Dispatch<React.SetStateAction<'config' | 'result' | null>>;
  resetBuilder: () => void;
  addField: (column: string, zone?: DropZone) => void;
  dimensions: string[];
  setDimensions: React.Dispatch<React.SetStateAction<string[]>>;
  measures: FlexMeasure[];
  setMeasures: React.Dispatch<React.SetStateAction<FlexMeasure[]>>;
  filters: FlexFilter[];
  setFilters: React.Dispatch<React.SetStateAction<FlexFilter[]>>;
  havings: FlexHaving[];
  setHavings: React.Dispatch<React.SetStateAction<FlexHaving[]>>;
  /** v0.9.75：多列排序 / 维度时间粒度 / 列取值探测缓存 */
  orderBys: FlexOrderBy[];
  setOrderBys: React.Dispatch<React.SetStateAction<FlexOrderBy[]>>;
  dimTimeUnits: Record<string, FlexTimeUnit>;
  setDimUnit: (column: string, unit: FlexTimeUnit | null) => void;
  columnValues: Record<string, ColumnValuesState>;
  fetchColumnValues: (fullName: string) => Promise<void>;
  limit: number;
  setLimit: React.Dispatch<React.SetStateAction<number>>;
  advOpen: boolean;
  setAdvOpen: React.Dispatch<React.SetStateAction<boolean>>;
  columnNames: Record<string, string>;
  allFields: FieldWithTable[];
  measureCols: FieldWithTable[];
  built: FlexBuilt;
  sqlOpen: boolean;
  setSqlOpen: React.Dispatch<React.SetStateAction<boolean>>;
  runQuery: (sqlOverride?: string, dsIdOverride?: string) => Promise<void>;
  executing: boolean;
  /** v0.9.76 P1-7/P1-8/P1-10/P1-11：语义指标 / 时间衍生列 / 后台执行 / OR 条件组 */
  metricMeasures: FlexMetricMeasure[];
  removeMetricMeasure: (id: number) => void;
  orGroups: FlexFilter[][];
  setOrGroups: React.Dispatch<React.SetStateAction<FlexFilter[][]>>;
  deriveds: FlexDerived[];
  setDeriveds: React.Dispatch<React.SetStateAction<FlexDerived[]>>;
  addDerived: (by: string, kind: FlexDerivedKind, periods?: number) => void;
  removeDerived: (alias: string) => void;
  hasTimeDim: boolean;
  backgroundMode: boolean;
  setBackgroundMode: React.Dispatch<React.SetStateAction<boolean>>;
  asyncProgress: string | null;
  cancelQuery: () => void;
}

export const BuilderCanvas: React.FC<BuilderCanvasProps> = ({
  fullZone,
  setFullZone,
  resetBuilder,
  addField,
  dimensions,
  setDimensions,
  measures,
  setMeasures,
  filters,
  setFilters,
  havings,
  setHavings,
  orderBys,
  setOrderBys,
  dimTimeUnits,
  setDimUnit,
  columnValues,
  fetchColumnValues,
  limit,
  setLimit,
  advOpen,
  setAdvOpen,
  columnNames,
  allFields,
  measureCols,
  built,
  sqlOpen,
  setSqlOpen,
  runQuery,
  executing,
  metricMeasures,
  removeMetricMeasure,
  orGroups,
  setOrGroups,
  deriveds,
  setDeriveds,
  addDerived,
  removeDerived,
  hasTimeDim,
  backgroundMode,
  setBackgroundMode,
  asyncProgress,
  cancelQuery,
}) => {
  const [dragOverZone, setDragOverZone] = useState<DropZone | null>(null);

  const handleDrop = (zone: DropZone, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverZone(null);
    const column = e.dataTransfer.getData('text/plain');
    if (column) addField(column, zone);
  };

  // v0.9.75：多列排序——可添加的下一排序目标（未被占用的指标别名或维度）
  // v0.9.76：语义指标别名并入候选集
  const metricAliases = metricMeasures.map((m) => metricAlias(m.id));
  const usedSortKeys = new Set(orderBys.map((o) => o.by));
  const nextSortTarget = [...measures.map(measureAlias), ...metricAliases, ...dimensions].find((k) => !usedSortKeys.has(k));

  // v0.9.76 P1-8：可衍生目标（普通指标 + 语义指标）与行内补丁
  const derivedTargets = [
    ...measures.map((m) => ({ value: measureAlias(m), label: `指标 · ${AGG_LABELS[m.agg]}(${columnNames[m.column] || m.column})` })),
    ...metricMeasures.map((mt) => ({ value: metricAlias(mt.id), label: `指标 · ${mt.name}` })),
  ];
  const patchDerived = (index: number, patch: Partial<FlexDerived>) => {
    setDeriveds((prev) => {
      const cur = prev[index];
      if (!cur) return prev;
      const next = { ...cur, ...patch };
      const alias = derivedAlias(next.by, next.kind, next.periods);
      // 同目标同类型重复时忽略本次变更（与 addDerived 去重一致）
      if (prev.some((d, i) => i !== index && derivedAlias(d.by, d.kind, d.periods) === alias)) return prev;
      return prev.map((d, i) => (i === index ? next : d));
    });
  };

  // v0.9.76 P1-11：OR 条件组行内补丁（组内任一满足，组间 AND）
  const patchOrRow = (gi: number, fi: number, patch: Partial<FlexFilter>) => {
    setOrGroups((prev) => prev.map((g, i) => (i === gi ? g.map((x, j) => (j === fi ? { ...x, ...patch } : x)) : g)));
  };
  const newOrRow = (): FlexFilter => ({ column: allFields[0]?.fullName || '', op: '=', value: '' });

  const zoneClass = (zone: DropZone) =>
    `rounded-xl border-2 border-dashed p-2 min-h-[52px] transition-colors ${
      dragOverZone === zone ? 'border-indigo-400 bg-indigo-950/40' : 'border-slate-700 bg-slate-900/60'
    }`;

  return (
    <div
      className={
        fullZone === 'config'
          ? 'fixed inset-0 z-50 bg-slate-900 p-4 md:p-6 space-y-3 overflow-y-auto'
          : 'bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-lg'
      }
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-200">查询配置区</span>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setFullZone(fullZone === 'config' ? null : 'config')}
            title={fullZone === 'config' ? '退出全屏（Esc）' : '全屏查看查询配置'}
            className="text-[10px] text-slate-400 hover:text-slate-200 flex items-center space-x-1"
          >
            {fullZone === 'config' ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
            <span>{fullZone === 'config' ? '退出全屏' : '全屏'}</span>
          </button>
          <button
            onClick={resetBuilder}
            className="text-[10px] text-slate-400 hover:text-slate-200 flex items-center space-x-1"
          >
            <RotateCcw className="w-3 h-3" />
            <span>清空</span>
          </button>
        </div>
      </div>

      {/* v0.4.11：维度与指标并排（窄屏自动回落单列），节省纵向空间 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {/* 维度区 */}
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-cyan-400 uppercase">
            分组维度{dimensions.length > 0 ? `（${dimensions.length}）` : ''}
          </p>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverZone('dimension');
          }}
          onDragLeave={() => setDragOverZone(null)}
          onDrop={(e) => handleDrop('dimension', e)}
          className={zoneClass('dimension')}
        >
          {dimensions.length === 0 ? (
            <p className="text-[10px] text-slate-500 text-center py-1.5">拖入或点击左侧维度</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {dimensions.map((d) => {
                const src = allFields.find((c) => c.fullName === d);
                const unit = dimTimeUnits[d];
                return (
                  <span
                    key={d}
                    className="text-[11px] px-2 py-1 rounded-lg bg-cyan-950/60 border border-cyan-500/40 text-cyan-200 flex items-center space-x-1"
                  >
                    <span>{columnNames[d] || d}</span>
                    {/* v0.9.75：日期维度时间粒度（按年/季/月/周/日分组） */}
                    {src?.type === 'date' && (
                      <select
                        value={unit || ''}
                        onChange={(e) => setDimUnit(d, (e.target.value || null) as FlexTimeUnit | null)}
                        title="时间粒度分组（按年/季/月/周/日聚合）"
                        className="bg-slate-800 border border-slate-700 rounded px-0.5 py-0 text-[10px] text-cyan-100 focus:outline-none"
                      >
                        <option value="">原值</option>
                        {FLEX_TIME_UNITS.map((u) => (
                          <option key={u} value={u}>
                            {TIME_UNIT_LABELS[u]}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      onClick={() => setDimensions((prev) => prev.filter((x) => x !== d))}
                      className="hover:text-rose-400"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        </div>

        {/* 指标区 */}
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-emerald-400 uppercase">
            聚合指标{measures.length + metricMeasures.length > 0 ? `（${measures.length + metricMeasures.length}）` : ''}
          </p>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverZone('measure');
            }}
            onDragLeave={() => setDragOverZone(null)}
            onDrop={(e) => handleDrop('measure', e)}
            className={zoneClass('measure')}
          >
            {measures.length === 0 && metricMeasures.length === 0 ? (
              <p className="text-[10px] text-slate-500 text-center py-1.5">拖入或点击左侧指标，或在字段面板点击语义指标</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {measures.map((m, idx) => (
                  <span
                    key={`${m.column}-${m.agg}-${idx}`}
                    className="text-[11px] px-2 py-1 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-emerald-200 flex items-center space-x-1.5"
                  >
                    <select
                      value={m.agg}
                      onChange={(e) =>
                        setMeasures((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, agg: e.target.value as FlexMeasure['agg'] } : x)),
                        )
                      }
                      className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] focus:outline-none"
                    >
                      {FLEX_AGGS.map((a) => (
                        <option key={a} value={a}>
                          {AGG_LABELS[a]}
                        </option>
                      ))}
                    </select>
                    <span>{columnNames[m.column] || m.column}</span>
                    <button
                      onClick={() => setMeasures((prev) => prev.filter((_, i) => i !== idx))}
                      className="hover:text-rose-400"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {/* v0.9.76 P1-7：语义指标 chips（口径在指标治理中定义，此处仅展示与移除） */}
                {metricMeasures.map((mt) => (
                  <span
                    key={metricAlias(mt.id)}
                    title={`${mt.expr}${mt.filters ? ` · 固定过滤：${mt.filters}` : ''}`}
                    className="text-[11px] px-2 py-1 rounded-lg bg-violet-950/60 border border-violet-500/40 text-violet-200 flex items-center space-x-1.5"
                  >
                    <Gauge className="w-3 h-3 text-violet-400" />
                    <span>{mt.name}</span>
                    <button
                      onClick={() => removeMetricMeasure(mt.id)}
                      className="hover:text-rose-400"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* v0.4.11：筛选 + HAVING 合并为可折叠「高级筛选」，默认展开，标题带计数 */}
      <button
        onClick={() => setAdvOpen((v) => !v)}
        className="w-full flex items-center justify-between text-[10px] font-bold text-slate-400 uppercase hover:text-slate-200"
      >
        <span className="flex items-center space-x-1">
          <Filter className="w-3 h-3 text-amber-400" />
          <span>
            高级筛选（WHERE/HAVING）
            {filters.length + havings.length > 0 ? ` · ${filters.length + havings.length} 条` : ''}
          </span>
        </span>
        {advOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {advOpen && (
        <>
          {/* 筛选区 */}
          <div className="space-y-1">
            <p className="text-[10px] font-bold text-amber-400 uppercase">WHERE 条件（可拖任意字段）</p>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverZone('filter');
          }}
          onDragLeave={() => setDragOverZone(null)}
          onDrop={(e) => handleDrop('filter', e)}
          className={zoneClass('filter')}
        >
          {filters.length === 0 ? (
            <p className="text-[10px] text-slate-500 text-center py-1.5">点击上方字段的筛选图标，或选择字段添加条件</p>
          ) : (
            <div className="space-y-1.5">
              {filters.map((f, idx) => (
                <div key={idx} className="flex items-center space-x-1.5 flex-wrap gap-y-1">
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-500/40 text-amber-200">
                    {columnNames[f.column] || f.column}
                  </span>
                  <select
                    value={f.op}
                    onChange={(e) =>
                      setFilters((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, op: e.target.value as FlexFilter['op'] } : x)),
                      )
                    }
                    className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
                  >
                    {FLEX_FILTER_OPS.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                  {f.op === 'LIKE' && (
                    <select
                      value={f.likeMode || 'contains'}
                      onChange={(e) =>
                        setFilters((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, likeMode: e.target.value as FlexLikeMode } : x)),
                        )
                      }
                      title="LIKE 匹配模式"
                      className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
                    >
                      {FLEX_LIKE_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {LIKE_MODE_LABELS[mode]}
                        </option>
                      ))}
                    </select>
                  )}
                  {!FLEX_NO_VALUE_OPS.includes(f.op) && (
                    <FilterValueControl
                      filter={f}
                      field={allFields.find((c) => c.fullName === f.column)}
                      valuesState={columnValues[f.column]}
                      onFetchValues={() => void fetchColumnValues(f.column)}
                      onPatch={(patch) =>
                        setFilters((prev) => prev.map((x, i) => (i === idx ? { ...x, ...patch } : x)))
                      }
                    />
                  )}
                  <button
                    onClick={() => setFilters((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-slate-400 hover:text-rose-400"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {/* 独立入口：选择字段添加 WHERE 条件 */}
              <div className="pt-1">
                <select
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) { addField(v, 'filter'); e.target.value = ''; }
                  }}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-[10px] text-slate-300 focus:outline-none focus:border-amber-500"
                >
                  <option value="">+ 添加筛选条件（选择字段）…</option>
                  {allFields.map((c) => (
                    <option key={c.fullName} value={c.fullName}>{c.description || c.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* v0.9.76 P1-11：OR 条件组（组内任一满足、组间 AND；最多 5 组、每组 5 条） */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-bold text-orange-400 uppercase">OR 条件组（组内任一满足，组间 AND）</p>
          <button
            onClick={() => setOrGroups((prev) => (prev.length >= 5 ? prev : [...prev, [newOrRow()]]))}
            disabled={orGroups.length >= 5 || allFields.length === 0}
            className={`text-[10px] ${
              orGroups.length >= 5 || allFields.length === 0 ? 'text-slate-600 cursor-not-allowed' : 'text-orange-300 hover:text-orange-200'
            }`}
          >
            + 添加 OR 组{orGroups.length > 0 ? `（${orGroups.length}/5）` : ''}
          </button>
        </div>
        {orGroups.length === 0 ? (
          <p className="text-[10px] text-slate-500">未设置 OR 组（上方 WHERE 条件均为 AND 关系）</p>
        ) : (
          <div className="space-y-1.5">
            {orGroups.map((group, gi) => (
              <div key={gi} className="rounded-xl border-2 border-dashed border-orange-500/30 bg-slate-900/60 p-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-orange-300">组 {gi + 1}（任一满足）</span>
                  <button
                    onClick={() => setOrGroups((prev) => prev.filter((_, i) => i !== gi))}
                    className="text-[10px] text-slate-400 hover:text-rose-400 flex items-center space-x-0.5"
                  >
                    <X className="w-3 h-3" />
                    <span>移除组</span>
                  </button>
                </div>
                {group.map((f, fi) => (
                  <div key={fi} className="flex items-center space-x-1.5 flex-wrap gap-y-1">
                    <select
                      value={f.column}
                      onChange={(e) => patchOrRow(gi, fi, { column: e.target.value, value: '' })}
                      className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none max-w-[130px]"
                    >
                      {allFields.map((c) => (
                        <option key={c.fullName} value={c.fullName}>{c.description || c.name}</option>
                      ))}
                    </select>
                    <select
                      value={f.op}
                      onChange={(e) => patchOrRow(gi, fi, { op: e.target.value as FlexFilter['op'] })}
                      className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
                    >
                      {FLEX_FILTER_OPS.map((op) => (
                        <option key={op} value={op}>{op}</option>
                      ))}
                    </select>
                    {f.op === 'LIKE' && (
                      <select
                        value={f.likeMode || 'contains'}
                        onChange={(e) => patchOrRow(gi, fi, { likeMode: e.target.value as FlexLikeMode })}
                        title="LIKE 匹配模式"
                        className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
                      >
                        {FLEX_LIKE_MODES.map((mode) => (
                          <option key={mode} value={mode}>{LIKE_MODE_LABELS[mode]}</option>
                        ))}
                      </select>
                    )}
                    {!FLEX_NO_VALUE_OPS.includes(f.op) && (
                      <FilterValueControl
                        filter={f}
                        field={allFields.find((c) => c.fullName === f.column)}
                        valuesState={columnValues[f.column]}
                        onFetchValues={() => void fetchColumnValues(f.column)}
                        onPatch={(patch) => patchOrRow(gi, fi, patch)}
                      />
                    )}
                    <button
                      onClick={() => setOrGroups((prev) => prev.map((g, i) => (i === gi ? g.filter((_, j) => j !== fi) : g)))}
                      className="text-slate-400 hover:text-rose-400"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setOrGroups((prev) => prev.map((g, i) => (i === gi && g.length < 5 ? [...g, newOrRow()] : g)))}
                  disabled={group.length >= 5}
                  className={`text-[10px] ${group.length >= 5 ? 'text-slate-600 cursor-not-allowed' : 'text-orange-300 hover:text-orange-200'}`}
                >
                  + 添加条件（{group.length}/5）
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 指标过滤区（HAVING，v0.4.10） */}
      <div className="space-y-1">
        <p className="text-[10px] font-bold text-fuchsia-400 uppercase">HAVING 指标过滤（聚合后）</p>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverZone('having');
          }}
          onDragLeave={() => setDragOverZone(null)}
          onDrop={(e) => handleDrop('having', e)}
          className={zoneClass('having')}
        >
          {havings.length === 0 ? (
            <p className="text-[10px] text-slate-500 text-center py-1.5">点击上方字段的过滤图标，或选择指标添加 HAVING 条件</p>
          ) : (
            <div className="space-y-1.5">
              {havings.map((h, idx) => (
                <div key={idx} className="flex items-center space-x-1.5 flex-wrap gap-y-1">
                  <select
                    value={h.agg}
                    onChange={(e) =>
                      setHavings((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, agg: e.target.value as FlexAgg } : x)),
                      )
                    }
                    className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
                  >
                    {FLEX_AGGS.map((a) => (
                      <option key={a} value={a}>
                        {AGG_LABELS[a]}
                      </option>
                    ))}
                  </select>
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-fuchsia-950/60 border border-fuchsia-500/40 text-fuchsia-200">
                    {columnNames[h.column] || h.column}
                  </span>
                  <select
                    value={h.op}
                    onChange={(e) =>
                      setHavings((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, op: e.target.value as FlexHaving['op'] } : x)),
                      )
                    }
                    className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 focus:outline-none"
                  >
                    {FLEX_HAVING_OPS.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                  <input
                    value={h.value}
                    onChange={(e) =>
                      setHavings((prev) => prev.map((x, i) => (i === idx ? { ...x, value: e.target.value } : x)))
                    }
                    placeholder="阈值"
                    className="flex-1 min-w-[60px] bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] text-slate-200 focus:outline-none focus:border-fuchsia-500"
                  />
                  <button
                    onClick={() => setHavings((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-slate-400 hover:text-rose-400"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {/* 独立入口：选择指标字段添加 HAVING 条件 */}
              <div className="pt-1">
                <select
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) { addField(v, 'having'); e.target.value = ''; }
                  }}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-[10px] text-slate-300 focus:outline-none focus:border-fuchsia-500"
                >
                  <option value="">+ 添加 HAVING 条件（选择指标字段）…</option>
                  {measureCols.map((c) => (
                    <option key={c.fullName} value={c.fullName}>{c.description || c.name}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>
        </>
      )}

      {/* 排序 + 行数（v0.4.10：排序目标可选任一指标/维度；v0.9.75：多列排序） */}
      <div className="space-y-1.5 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="text-slate-400 flex items-center space-x-1">
            <ArrowUpDown className="w-3 h-3" />
            <span>排序（多列自上而下依次生效）</span>
          </span>
          <button
            onClick={() => {
              if (!nextSortTarget) return;
              setOrderBys((prev) => [...prev, { by: nextSortTarget, dir: 'desc' }]);
            }}
            disabled={!nextSortTarget}
            className={`text-[10px] ${nextSortTarget ? 'text-indigo-300 hover:text-indigo-200' : 'text-slate-600 cursor-not-allowed'}`}
          >
            + 添加排序
          </button>
        </div>
        {orderBys.length === 0 ? (
          <p className="text-[10px] text-slate-500">未设置排序（按数据库返回顺序）</p>
        ) : (
          <div className="space-y-1">
            {orderBys.map((o, idx) => (
              <div key={`${o.by}-${idx}`} className="flex items-center space-x-1.5">
                <span className="text-[10px] text-slate-500 w-3">{idx + 1}.</span>
                <select
                  value={o.by}
                  onChange={(e) =>
                    setOrderBys((prev) => prev.map((x, i) => (i === idx ? { ...x, by: e.target.value } : x)))
                  }
                  className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200 focus:outline-none max-w-[200px]"
                >
                  {measures.map((m) => (
                    <option key={`om-${measureAlias(m)}`} value={measureAlias(m)}>
                      指标 · {AGG_LABELS[m.agg]}({columnNames[m.column] || m.column})
                    </option>
                  ))}
                  {/* v0.9.76：语义指标同样作为排序目标 */}
                  {metricMeasures.map((mt) => (
                    <option key={`omt-${metricAlias(mt.id)}`} value={metricAlias(mt.id)}>
                      指标 · {mt.name}
                    </option>
                  ))}
                  {dimensions.map((d) => (
                    <option key={`od-${d}`} value={d}>
                      维度 · {columnNames[d] || d}
                    </option>
                  ))}
                </select>
                <select
                  value={o.dir}
                  onChange={(e) =>
                    setOrderBys((prev) =>
                      prev.map((x, i) => (i === idx ? { ...x, dir: e.target.value as 'desc' | 'asc' } : x)),
                    )
                  }
                  className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200 focus:outline-none"
                >
                  <option value="desc">降序</option>
                  <option value="asc">升序</option>
                </select>
                <button
                  onClick={() => setOrderBys((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-slate-400 hover:text-rose-400"
                  title="移除该排序条件"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center space-x-2">
          <span className="text-slate-400">行数</span>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200 focus:outline-none"
          >
            {/* v0.9.64：补 100000 选项（与执行层硬上限一致），取全部明细时无需再受 50000 限制 */}
            {[100, 500, 1000, 5000, 10000, 50000, 100000].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* v0.9.76 P1-8：时间衍生列（同比/环比/累计/移动平均；需已配置时间粒度的维度） */}
      <div className="space-y-1.5 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="text-slate-400 flex items-center space-x-1">
            <TrendingUp className="w-3 h-3" />
            <span>时间衍生列（同比/环比/累计/移动平均）</span>
          </span>
          <button
            onClick={() => {
              const by = derivedTargets[0]?.value;
              if (by) addDerived(by, 'yoy');
            }}
            disabled={!hasTimeDim || deriveds.length >= 6 || derivedTargets.length === 0}
            className={`text-[10px] ${
              !hasTimeDim || deriveds.length >= 6 || derivedTargets.length === 0
                ? 'text-slate-600 cursor-not-allowed'
                : 'text-indigo-300 hover:text-indigo-200'
            }`}
          >
            + 添加衍生{deriveds.length > 0 ? `（${deriveds.length}/6）` : ''}
          </button>
        </div>
        {deriveds.length === 0 ? (
          <p className="text-[10px] text-slate-500">
            {hasTimeDim ? '未设置衍生列（可选）' : '需先为日期维度选择时间粒度（上方维度 chip 内）'}
          </p>
        ) : (
          <div className="space-y-1">
            {deriveds.map((d, idx) => {
              const alias = derivedAlias(d.by, d.kind, d.periods);
              return (
                <div key={alias} className="flex items-center space-x-1.5 flex-wrap gap-y-1">
                  <select
                    value={d.by}
                    onChange={(e) => patchDerived(idx, { by: e.target.value })}
                    className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200 focus:outline-none max-w-[220px]"
                  >
                    {derivedTargets.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <select
                    value={d.kind}
                    onChange={(e) => patchDerived(idx, { kind: e.target.value as FlexDerivedKind })}
                    className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200 focus:outline-none"
                  >
                    {FLEX_DERIVED_KINDS.map((k) => (
                      <option key={k} value={k}>{DERIVED_LABELS[k]}</option>
                    ))}
                  </select>
                  {d.kind === 'ma' && (
                    <select
                      value={d.periods || 3}
                      onChange={(e) => patchDerived(idx, { periods: Number(e.target.value) })}
                      title="移动平均窗口期数（2~12）"
                      className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200 focus:outline-none"
                    >
                      {[2, 3, 4, 5, 6, 8, 10, 12].map((n) => (
                        <option key={n} value={n}>MA({n})</option>
                      ))}
                    </select>
                  )}
                  <span className="text-[10px] text-slate-500 font-mono truncate max-w-[150px]" title={alias}>{alias}</span>
                  <button
                    onClick={() => removeDerived(alias)}
                    className="text-slate-400 hover:text-rose-400"
                    title="移除该衍生列"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* SQL 预览（v0.4.11 可折叠）：P0-1 拆至 SqlPreviewPanel */}
      <SqlPreviewPanel built={built} sqlOpen={sqlOpen} onToggle={() => setSqlOpen((v) => !v)} />

      <button
        onClick={() => void runQuery()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void runQuery();
          }
        }}
        disabled={executing || !built?.ok}
        className={`w-full flex items-center justify-center space-x-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all ${
          executing || !built?.ok
            ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
            : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow'
        }`}
      >
        {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        <span>{executing ? (backgroundMode ? '后台执行中…' : '执行中…') : '执行查询（真实数据库）'}</span>
      </button>
      {/* v0.9.76 P1-10：后台执行开关、进度与取消 */}
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <label className="flex items-center space-x-1 cursor-pointer" title="提交后台任务队列执行（不阻塞页面；结果最多保留 2 万行）">
          <input
            type="checkbox"
            checked={backgroundMode}
            onChange={(e) => setBackgroundMode(e.target.checked)}
            className="accent-indigo-500"
          />
          <span>后台执行（大查询）</span>
        </label>
        {executing && (
          <button onClick={cancelQuery} className="text-rose-300 hover:text-rose-200 flex items-center space-x-0.5">
            <X className="w-3 h-3" />
            <span>取消</span>
          </button>
        )}
      </div>
      {asyncProgress && <p className="text-[10px] text-indigo-300 text-center">{asyncProgress}</p>}
      {/* v0.4.14：执行超时提示（后台模式走任务队列，不受交互超时限制） */}
      <p className="text-[10px] text-slate-500 text-center px-2">
        {backgroundMode
          ? '后台任务走独立连接池与超时策略，提交后可在任务中心查看结果'
          : '执行超时上限 10s；查询行数 > 10 万或执行时长 > 3s 将记入慢查询审计'}
      </p>
    </div>
  );
};

/** v0.9.75：日期快捷预设（选后自动切换为 BETWEEN，区间为 [起始, 今天]） */
const DatePresetSelect: React.FC<{ onPick: (value: string) => void }> = ({ onPick }) => (
  <select
    value=""
    onChange={(e) => {
      const key = e.target.value;
      if (!key) return;
      onPick(datePresetRange(key));
      e.target.value = '';
    }}
    title="日期快捷区间（自动切换为 BETWEEN）"
    className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-300 focus:outline-none"
  >
    <option value="">快捷…</option>
    <option value="today">今天</option>
    <option value="last7">近 7 天</option>
    <option value="last30">近 30 天</option>
    <option value="month">本月</option>
    <option value="quarter">本季</option>
    <option value="year">今年</option>
  </select>
);

/** 本地日期格式化（避免 toISOString 的 UTC 时区偏移） */
const fmtLocalDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 日期预设区间 → `起始, 今天`（近 7 天含今天共 7 天） */
function datePresetRange(key: string): string {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === 'last7') start.setDate(start.getDate() - 6);
  else if (key === 'last30') start.setDate(start.getDate() - 29);
  else if (key === 'month') start.setDate(1);
  else if (key === 'quarter') start.setMonth(Math.floor(now.getMonth() / 3) * 3, 1);
  else if (key === 'year') start.setMonth(0, 1);
  return `${fmtLocalDate(start)}, ${fmtLocalDate(now)}`;
}

/**
 * v0.9.75 类型感知筛选值控件：日期列日期输入 + 快捷预设（BETWEEN 双输入）；
 * 数值列 BETWEEN 双输入；字符串/枚举列文本输入 + 取值下拉（懒加载该列已有取值）。
 */
const FilterValueControl: React.FC<{
  filter: FlexFilter;
  field?: FieldWithTable;
  valuesState?: ColumnValuesState;
  onFetchValues: () => void;
  onPatch: (patch: Partial<FlexFilter>) => void;
}> = ({ filter: f, field, valuesState, onFetchValues, onPatch }) => {
  const isDate = field?.type === 'date';
  const isNumber = field?.type === 'number';
  // 枚举候选：字符串/枚举/布尔列（数值与日期列不提供取值下拉）
  const enumable = !!field && !isNumber && !isDate;
  const inputCls =
    'flex-1 min-w-[80px] bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] text-slate-200 focus:outline-none focus:border-amber-500';

  if (isDate) {
    const parts = f.value.split(/[,，]/);
    const a = parts[0]?.trim() ?? '';
    if (f.op === 'BETWEEN') {
      const b = parts[1]?.trim() ?? '';
      return (
        <>
          <input type="date" value={a} onChange={(e) => onPatch({ value: `${e.target.value}, ${b}` })} className={inputCls} />
          <span className="text-slate-500">~</span>
          <input type="date" value={b} onChange={(e) => onPatch({ value: `${a}, ${e.target.value}` })} className={inputCls} />
          <DatePresetSelect onPick={(v) => onPatch({ op: 'BETWEEN', value: v })} />
        </>
      );
    }
    return (
      <>
        <input type="date" value={a} onChange={(e) => onPatch({ value: e.target.value })} className={inputCls} />
        <DatePresetSelect onPick={(v) => onPatch({ op: 'BETWEEN', value: v })} />
      </>
    );
  }

  if (isNumber && f.op === 'BETWEEN') {
    const parts = f.value.split(/[,，]/);
    const a = parts[0]?.trim() ?? '';
    const b = parts[1]?.trim() ?? '';
    return (
      <>
        <input
          value={a}
          inputMode="decimal"
          placeholder="最小值"
          onChange={(e) => onPatch({ value: `${e.target.value}, ${b}` })}
          className={inputCls}
        />
        <span className="text-slate-500">~</span>
        <input
          value={b}
          inputMode="decimal"
          placeholder="最大值"
          onChange={(e) => onPatch({ value: `${a}, ${e.target.value}` })}
          className={inputCls}
        />
      </>
    );
  }

  return (
    <>
      <input
        value={f.value}
        onChange={(e) => onPatch({ value: e.target.value })}
        placeholder={f.op === 'IN' ? '多值逗号分隔' : '筛选值'}
        className={inputCls}
      />
      {enumable && (
        <select
          value=""
          onFocus={() => {
            if (!valuesState) onFetchValues();
          }}
          onChange={(e) => {
            const v = e.target.value;
            e.target.value = '';
            if (!v) return;
            if (v === '__retry__' || v === '__load__') return onFetchValues();
            // IN/BETWEEN 为多值语义：选择的取值追加到现有值（逗号分隔）
            const multiple = f.op === 'IN' || f.op === 'BETWEEN';
            onPatch({ value: multiple ? (f.value.trim() ? `${f.value.trim()}, ${v}` : v) : v });
          }}
          title="从该列已有取值中选择（点击加载）"
          className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-300 focus:outline-none max-w-[110px]"
        >
          {!valuesState || valuesState.status === 'loading' ? (
            <option value="__load__">{valuesState?.status === 'loading' ? '加载中…' : '取值▾'}</option>
          ) : valuesState.status === 'error' ? (
            <option value="__retry__">加载失败，点击重试</option>
          ) : (
            <>
              <option value="">取值▾</option>
              {valuesState.values.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
              {valuesState.truncated && (
                <option value="__more__" disabled>
                  …仅展示前 100 个
                </option>
              )}
            </>
          )}
        </select>
      )}
    </>
  );
};
