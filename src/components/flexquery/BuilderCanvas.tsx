// P0 上帝组件拆分：自 FlexQueryBuilder 提取的查询配置画布（中区：拖放区 + 排序行数 + SQL 预览 + 执行）
// 纯展示组件：拖拽悬停态（dragOverZone）为纯视觉关注点，收敛至本组件本地状态；其余由 useFlexQueryState 注入
import React, { useState } from 'react';
import { X, Play, Loader2, Filter, ArrowUpDown, RotateCcw, Maximize2, Minimize2, ChevronUp, ChevronDown } from 'lucide-react';
import {
  FLEX_AGGS,
  FLEX_FILTER_OPS,
  FLEX_HAVING_OPS,
  FLEX_NO_VALUE_OPS,
  measureAlias,
  FlexAgg,
  FlexMeasure,
  FlexFilter,
  FlexHaving,
  FlexOrderBy,
} from '../../utils/flexQueryBuilder';
import { SqlPreviewPanel } from './SqlPreviewPanel';
import { AGG_LABELS, DropZone, FieldWithTable, FlexBuilt } from './flexQueryShared';

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
  orderBy: FlexOrderBy | null;
  setOrderBy: React.Dispatch<React.SetStateAction<FlexOrderBy | null>>;
  isOrderByValid: boolean;
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
  orderBy,
  setOrderBy,
  isOrderByValid,
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
}) => {
  const [dragOverZone, setDragOverZone] = useState<DropZone | null>(null);

  const handleDrop = (zone: DropZone, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverZone(null);
    const column = e.dataTransfer.getData('text/plain');
    if (column) addField(column, zone);
  };

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
              {dimensions.map((d) => (
                <span
                  key={d}
                  className="text-[11px] px-2 py-1 rounded-lg bg-cyan-950/60 border border-cyan-500/40 text-cyan-200 flex items-center space-x-1"
                >
                  <span>{columnNames[d] || d}</span>
                  <button
                    onClick={() => setDimensions((prev) => prev.filter((x) => x !== d))}
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

        {/* 指标区 */}
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-emerald-400 uppercase">
            聚合指标{measures.length > 0 ? `（${measures.length}）` : ''}
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
            {measures.length === 0 ? (
              <p className="text-[10px] text-slate-500 text-center py-1.5">拖入或点击左侧指标</p>
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
                  {!FLEX_NO_VALUE_OPS.includes(f.op) && (
                    <input
                      value={f.value}
                      onChange={(e) =>
                        setFilters((prev) => prev.map((x, i) => (i === idx ? { ...x, value: e.target.value } : x)))
                      }
                      placeholder={
                        f.op === 'IN' ? '多值逗号分隔' : f.op === 'BETWEEN' ? '区间：最小值, 最大值' : '筛选值'
                      }
                      className="flex-1 min-w-[80px] bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] text-slate-200 focus:outline-none focus:border-amber-500"
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

      {/* 排序 + 行数（v0.4.10：排序目标可选任一指标/维度） */}
      <div className="flex items-center space-x-2 text-[11px] flex-wrap gap-y-1.5">
        <span className="text-slate-400 flex items-center space-x-1">
          <ArrowUpDown className="w-3 h-3" />
          <span>排序</span>
        </span>
        <select
          value={isOrderByValid && orderBy ? orderBy.by : ''}
          onChange={(e) => {
            const by = e.target.value;
            setOrderBy(by ? { by, dir: orderBy?.dir || 'desc' } : null);
          }}
          className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200 focus:outline-none max-w-[180px]"
        >
          <option value="">不排序</option>
          {measures.map((m) => (
            <option key={`om-${measureAlias(m)}`} value={measureAlias(m)}>
              指标 · {AGG_LABELS[m.agg]}({columnNames[m.column] || m.column})
            </option>
          ))}
          {dimensions.map((d) => (
            <option key={`od-${d}`} value={d}>
              维度 · {columnNames[d] || d}
            </option>
          ))}
        </select>
        {orderBy && (
          <select
            value={orderBy.dir}
            onChange={(e) => setOrderBy({ ...orderBy, dir: e.target.value as 'desc' | 'asc' })}
            className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200 focus:outline-none"
          >
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
        )}
        <span className="text-slate-400">行数</span>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200 focus:outline-none"
        >
          {[100, 500, 1000, 5000, 10000, 50000].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
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
        <span>{executing ? '执行中…' : '执行查询（真实数据库）'}</span>
      </button>
      {/* v0.4.14：执行超时提示 */}
      <p className="text-[10px] text-slate-500 text-center px-2">
        执行超时上限 10s；查询行数 {'>'} 10 万或执行时长 {'>'} 3s 将记入慢查询审计
      </p>
    </div>
  );
};
