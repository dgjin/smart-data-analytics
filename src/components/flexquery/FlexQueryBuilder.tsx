import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  SlidersHorizontal,
  Table2,
  Hash,
  Tag,
  X,
  Play,
  Pin,
  Save,
  Trash2,
  Database,
  Loader2,
  Filter,
  ArrowUpDown,
  RotateCcw,
  Bookmark,
  Search,
  Download,
  History,
  Percent,
  LayoutGrid,
  Check,
  Plus,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { apiFetch } from '../../api/client';
import { downloadServerCsv } from '../../utils/exportCsv';
import { DynamicChart } from '../charts/DynamicChart';
import { DataTable } from '../charts/DataTable';
import { TableSchema, ChartConfig, ChartType } from '../../types/analytics';
import {
  buildFlexQuerySql,
  isAmountColumn,
  measureAlias,
  FLEX_AGGS,
  FLEX_FILTER_OPS,
  FLEX_HAVING_OPS,
  FLEX_NO_VALUE_OPS,
  FlexMeasure,
  FlexFilter,
  FlexHaving,
  FlexOrderBy,
  FlexJoin,
  FlexAgg,
  FlexQueryConfig,
} from '../../utils/flexQueryBuilder';
import { useEffectiveAmountUnit, AMOUNT_UNIT_DIVISORS } from '../../hooks/useAmountUnitStore';
import { AmountUnitSelect } from '../common/AmountUnitSelect';

/** 已保存的固定报表（灵活查询定义），v0.9.24 起服务端 flex_queries 表持久化 */
interface SavedFlexQuery {
  id: string;
  name: string;
  dataSourceId: string;
  config: FlexQueryConfig;
  chartType: ChartType;
  createdAt: string;
}

/** 最近执行查询历史，v0.9.24 起服务端 flex_query_history 表持久化（仅本人可见） */
interface FlexHistoryItem {
  id: string;
  name: string;
  dataSourceId: string;
  config: FlexQueryConfig;
  chartType: ChartType;
  ranAt: string;
}

/** v0.9.24 迁移遗留键：服务端持久化后仅存留一次性迁移源，迁移成功即清除 */
const SAVED_KEY = 'app-flex-queries';
const HISTORY_KEY = 'app-flex-history';
const DB_TYPES = ['mysql', 'postgresql', 'greenplum'];
/** 聚合方式中文标签（v0.4.10 参照 Agile Query：新增去重计数） */
const AGG_LABELS: Record<FlexAgg, string> = {
  SUM: '求和',
  COUNT: '计数',
  COUNT_DISTINCT: '去重计数',
  AVG: '平均',
  MAX: '最大',
  MIN: '最小',
};
const CHART_TYPE_OPTIONS: { value: ChartType; label: string }[] = [
  { value: 'bar', label: '柱状图' },
  { value: 'line', label: '折线图' },
  { value: 'area', label: '面积图' },
  { value: 'pie', label: '饼图' },
  { value: 'table', label: '表格' },
];

type DropZone = 'dimension' | 'measure' | 'filter' | 'having';

/** v0.4.11 字段面板分组可见性（字段较多时按类型过滤，减少滚动） */
type FieldTab = 'all' | 'dimension' | 'measure';

export const FlexQueryBuilder: React.FC = () => {
  const {
    dataSources,
    activeDataSourceId,
    setActiveDataSource,
    pinChartToDashboardRemote,
    setActiveTab,
  } = useAnalyticsStore();

  const activeDS = dataSources.find((ds) => ds.id === activeDataSourceId);
  const dbSupported = !!activeDS && DB_TYPES.includes(activeDS.type) && activeDS.status !== 'disconnected';
  const dialect: 'mysql' | 'pg' = activeDS?.type === 'mysql' ? 'mysql' : 'pg';

  // ---------- Schema 加载 ----------
  const [tables, setTables] = useState<TableSchema[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  useEffect(() => {
    setTables([]);
    setSelectedTable('');
    setSchemaError(null);
    if (!activeDataSourceId || !dbSupported) return;
    let cancelled = false;
    setLoadingTables(true);
    apiFetch(`/api/datasources/${encodeURIComponent(activeDataSourceId)}/flex-schema`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && data?.success) setTables(Array.isArray(data.tables) ? data.tables : []);
        else setSchemaError(data?.error || `Schema 加载失败（HTTP ${res.status}）`);
      })
      .catch(() => {
        if (!cancelled) setSchemaError('网络异常，Schema 加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoadingTables(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeDataSourceId, dbSupported]);

  // ---------- 查询构建状态 ----------
  const [selectedTable, setSelectedTable] = useState('');
  const [dimensions, setDimensions] = useState<string[]>([]);
  const [measures, setMeasures] = useState<FlexMeasure[]>([]);
  const [filters, setFilters] = useState<FlexFilter[]>([]);
  // v0.4.10：指标过滤（HAVING）与自由排序目标（任一指标/维度）
  const [havings, setHavings] = useState<FlexHaving[]>([]);
  const [orderBy, setOrderBy] = useState<FlexOrderBy | null>(null);
  const [fieldSearch, setFieldSearch] = useState('');
  // v0.4.11 布局优化：字段分组过滤/折叠、SQL 预览折叠
  const [fieldTab, setFieldTab] = useState<FieldTab>('all');
  const [dimOpen, setDimOpen] = useState(true);
  const [meaOpen, setMeaOpen] = useState(true);
  const [sqlOpen, setSqlOpen] = useState(true);
  const [advOpen, setAdvOpen] = useState(true);
  // v0.4.12：查询配置区/查询结果全屏显示
  const [fullZone, setFullZone] = useState<'config' | 'result' | null>(null);
  useEffect(() => {
    if (!fullZone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullZone(null);
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [fullZone]);
  const [showPct, setShowPct] = useState(false);
  const [pivotMode, setPivotMode] = useState(false);
  const [limit, setLimit] = useState(10000);
  const [joins, setJoins] = useState<FlexJoin[]>([]); // v0.4.14：多表 JOIN
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [queryName, setQueryName] = useState('');
  const [dragOverZone, setDragOverZone] = useState<DropZone | null>(null);

  const tableSchema = tables.find((t) => t.name === selectedTable);

  // v0.4.10 修复：聚合方式变更后同步校正排序目标（旧别名失效会阻塞执行），
  // 且排序下拉展示值需与实际 orderBy 一致（否则选「不排序」不生效）
  const validAliases = new Set(measures.map(measureAlias));
  const isOrderByValid = !!orderBy && (validAliases.has(orderBy.by) || dimensions.includes(orderBy.by));
  useEffect(() => {
    if (orderBy && !isOrderByValid) {
      const fallback = validAliases.size ? [...validAliases][0] : dimensions[0];
      setOrderBy(fallback ? { by: fallback, dir: orderBy.dir } : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measures, dimensions]);
  // 字段搜索：按列名/描述过滤（参照 Agile Query 搜索式字段定位）
  const searchKw = fieldSearch.trim().toLowerCase();
  // v0.4.15：跨表字段支持——合并主表 + 关联表字段，字段对象带 table 标识来源
  type FieldWithTable = { name: string; type: string; description?: string; table: string; fullName: string };
  const allFields = useMemo(() => {
    const fields: FieldWithTable[] = [];
    // 主表字段（fullName 不带表前缀，兼容单表场景）
    if (tableSchema) {
      for (const c of tableSchema.columns) {
        fields.push({ ...c, table: tableSchema.name, fullName: c.name });
      }
    }
    // 关联表字段（fullName 带表前缀 table.column）
    for (const j of joins) {
      if (!j.table) continue;
      const joinTable = tables.find((t) => t.name === j.table);
      if (!joinTable) continue;
      for (const c of joinTable.columns) {
        fields.push({ ...c, table: j.table, fullName: `${j.table}.${c.name}` });
      }
    }
    return fields;
  }, [tableSchema, joins, tables]);
  const dimensionCols = allFields.filter(
    (c) => c.type !== 'number' && (!searchKw || `${c.fullName} ${c.description || ''}`.toLowerCase().includes(searchKw)),
  );
  const measureCols = allFields.filter(
    (c) => c.type === 'number' && (!searchKw || `${c.fullName} ${c.description || ''}`.toLowerCase().includes(searchKw)),
  );
  // v0.4.11：已加入查询配置的字段在字段列表中标记，避免重复查找
  const usedColumns = useMemo(() => {
    const s = new Set<string>(dimensions);
    measures.forEach((m) => s.add(m.column));
    filters.forEach((f) => s.add(f.column));
    havings.forEach((h) => s.add(h.column));
    return s;
  }, [dimensions, measures, filters, havings]);

  const config: FlexQueryConfig = useMemo(
    () => ({ table: selectedTable, joins, dimensions, measures, filters, havings, orderBy, limit }),
    [selectedTable, joins, dimensions, measures, filters, havings, orderBy, limit],
  );

  // v0.5.4 金额单位：模块覆盖优先，未覆盖跟随全局；换算在 SQL 构建期完成（金额列聚合除以除数）
  const amountUnit = useEffectiveAmountUnit('flexquery');
  const flexAmountUnit = useMemo(
    () => ({ label: amountUnit, divisor: AMOUNT_UNIT_DIVISORS[amountUnit] }),
    [amountUnit],
  );
  const built = useMemo(
    () => (tableSchema ? buildFlexQuerySql(config, tableSchema, dialect, tables, flexAmountUnit) : null),
    [config, tableSchema, dialect, tables, flexAmountUnit],
  );

  // ---------- 执行结果 ----------
  const [result, setResult] = useState<{ columns: string[]; rows: Record<string, any>[] } | null>(null);
  const [executing, setExecuting] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [execTimeMs, setExecTimeMs] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 金额单位切换后口径变化，旧结果与新 SQL 不一致，清空结果引导重新执行
  const prevAmountUnitRef = useRef(amountUnit);
  useEffect(() => {
    if (prevAmountUnitRef.current !== amountUnit) {
      prevAmountUnitRef.current = amountUnit;
      setResult(null);
      setExecError(null);
    }
  }, [amountUnit]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  };

  // ---------- 已保存固定报表（v0.9.24 服务端持久化） ----------
  const [savedQueries, setSavedQueries] = useState<SavedFlexQuery[]>([]);

  /** 保存固定报表：本地乐观 + 服务端落库；失败回滚并提示（409 幂等视为成功） */
  const saveNewQuery = async (item: SavedFlexQuery) => {
    setSavedQueries((prev) => [item, ...prev]);
    try {
      const res = await apiFetch('/api/flex-queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: item }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok && res.status !== 409) throw new Error(data?.error || '保存到服务器失败');
      showToast(`固定报表「${item.name}」已保存`);
    } catch (err) {
      setSavedQueries((prev) => prev.filter((x) => x.id !== item.id));
      showToast((err as Error)?.message || '固定报表保存失败');
    }
  };

  /** 删除固定报表：本地乐观 + 服务端删除；失败回滚并提示 */
  const deleteSavedQuery = async (id: string) => {
    const prev = savedQueries;
    setSavedQueries(prev.filter((x) => x.id !== id));
    try {
      const res = await apiFetch(`/api/flex-queries/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || '删除失败');
    } catch (err) {
      setSavedQueries(prev);
      showToast((err as Error)?.message || '删除失败');
    }
  };

  // ---------- 最近查询历史（v0.9.24 服务端持久化，仅本人可见） ----------
  const [history, setHistory] = useState<FlexHistoryItem[]>([]);

  /** 历史整组替换：本地乐观 + 服务端 fire-and-forget（非关键数据，失败仅告警） */
  const persistHistory = (list: FlexHistoryItem[]) => {
    setHistory(list);
    void apiFetch('/api/flex-queries/history', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: list }),
    }).catch((err) => console.warn('[flex-query] 查询历史同步失败:', err));
  };

  // ---------- v0.9.24 服务端持久化初始化：迁移 localStorage 遗留 → 拉取服务端权威数据 ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. 迁移遗留固定报表（服务端 query_id UNIQUE + 409 幂等，重复迁移安全）
      try {
        const raw = localStorage.getItem(SAVED_KEY);
        const legacy = raw ? (JSON.parse(raw) as SavedFlexQuery[]) : [];
        for (const q of legacy) {
          if (!q?.id || !q?.name) continue;
          try {
            await apiFetch('/api/flex-queries', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: q }),
            });
          } catch {
            // 单条迁移失败不阻塞整体（localStorage 保留，下一会话重试）
          }
        }
        localStorage.removeItem(SAVED_KEY);
      } catch {
        // 本地读取失败忽略
      }
      // 2. 迁移遗留历史（整组替换）
      try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const legacyHist = raw ? (JSON.parse(raw) as FlexHistoryItem[]) : [];
        if (Array.isArray(legacyHist) && legacyHist.length) {
          await apiFetch('/api/flex-queries/history', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: legacyHist.slice(0, 8) }),
          });
        }
        localStorage.removeItem(HISTORY_KEY);
      } catch {
        // 历史迁移失败不影响主流程
      }
      // 3. 拉取服务端权威列表
      try {
        const [qRes, hRes] = await Promise.all([
          apiFetch('/api/flex-queries'),
          apiFetch('/api/flex-queries/history'),
        ]);
        const qData = await qRes.json().catch(() => null);
        const hData = await hRes.json().catch(() => null);
        if (cancelled) return;
        if (qRes.ok && qData?.success && Array.isArray(qData.queries)) {
          setSavedQueries(
            (qData.queries as { query?: SavedFlexQuery }[])
              .map((r) => r.query)
              .filter((q): q is SavedFlexQuery => !!q && typeof q.id === 'string'),
          );
        }
        if (hRes.ok && hData?.success && Array.isArray(hData.items)) {
          setHistory(hData.items as FlexHistoryItem[]);
        }
      } catch {
        // 服务端不可达时本次会话以空列表起步（写入仍可乐观进行）
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 字段添加 ----------
  const addField = (column: string, zone?: DropZone) => {
    // v0.4.15：支持跨表字段（fullName 格式：table.column 或主表 column）
    const col = allFields.find((c) => c.fullName === column);
    if (!col) return;
    const target: DropZone = zone || (col.type === 'number' ? 'measure' : 'dimension');
    if (target === 'dimension') {
      if (dimensions.includes(column)) return showToast('该维度已在分组区中');
      setDimensions((prev) => [...prev, column]);
    } else if (target === 'measure') {
      setMeasures((prev) => [...prev, { column, agg: 'SUM' }]);
      // 首个指标且未设排序：默认按该指标降序（沿用 v0.4.9 行为）
      if (!orderBy) setOrderBy({ by: measureAlias({ column, agg: 'SUM' }), dir: 'desc' });
    } else if (target === 'having') {
      setHavings((prev) => [...prev, { column, agg: 'SUM', op: '>', value: '' }]);
    } else {
      setFilters((prev) => [...prev, { column, op: '=', value: '' }]);
    }
  };

  const handleDrop = (zone: DropZone, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverZone(null);
    const column = e.dataTransfer.getData('text/plain');
    if (column) addField(column, zone);
  };

  const resetBuilder = () => {
    setDimensions([]);
    setMeasures([]);
    setFilters([]);
    setHavings([]);
    setOrderBy(null);
    setLimit(100);
    setResult(null);
    setExecError(null);
    setPivotMode(false);
    setShowPct(false);
  };

  // ---------- 执行 ----------
  const runQuery = async (sqlOverride?: string, dsIdOverride?: string) => {
    const sql = sqlOverride ?? (built?.ok ? built.sql : null);
    // 注意：基线 tsconfig 未启 strictNullChecks，布尔判别式 !built.ok 无法窄化联合类型，须用 === false 显式比较
    if (!sql) return setExecError(built && built.ok === false ? built.error : '请先选择数据表并拖入维度/指标');
    const dsId = dsIdOverride ?? activeDataSourceId;
    if (!dsId) return setExecError('请先选择数据源');
    setExecuting(true);
    setExecError(null);
    try {
      const res = await apiFetch('/api/query/execute-sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId: dsId, sql }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success && Array.isArray(data.rows)) {
        const cols = data.rows.length ? Object.keys(data.rows[0]) : [];
        setResult({ columns: cols, rows: data.rows });
        setExecTimeMs(typeof data.executionTimeMs === 'number' ? data.executionTimeMs : null);
        // 记入最近查询历史（按配置去重，上限 8 条）
        const cfgKey = JSON.stringify(config);
        const item: FlexHistoryItem = {
          id: `hist-${Date.now()}`,
          name: queryName.trim() || `${tableSchema?.displayName || config.table} 查询`,
          dataSourceId: dsId,
          config: JSON.parse(cfgKey) as FlexQueryConfig,
          chartType,
          ranAt: `${new Date().toISOString().slice(5, 10)} ${new Date().toTimeString().slice(0, 5)}`,
        };
        persistHistory([item, ...history.filter((h) => JSON.stringify(h.config) !== cfgKey)].slice(0, 8));
      } else {
        setExecError(data?.error || `执行失败（HTTP ${res.status}）`);
      }
    } catch (err: any) {
      setExecError(err?.message || '网络异常，执行失败');
    } finally {
      setExecuting(false);
    }
  };

  // ---------- 图表配置 ----------
  const columnNames = useMemo(() => {
    const map: Record<string, string> = {};
    (tableSchema?.columns || []).forEach((c) => {
      map[c.name] = c.description || c.name;
    });
    measures.forEach((m) => {
      // v0.4.15 跨表字段按 fullName 查找；主表字段回退列名查找
      const src = allFields.find((c) => c.fullName === m.column) || tableSchema?.columns.find((c) => c.name === m.column);
      const alias = measureAlias(m);
      // 金额列且选定非「元」单位：列名标注口径，与 SQL 换算结果一致（COUNT 类不换算不标注）
      const convertible = m.agg !== 'COUNT' && m.agg !== 'COUNT_DISTINCT';
      const unitSuffix = flexAmountUnit.divisor > 1 && convertible && isAmountColumn(src) ? `（${amountUnit}）` : '';
      map[alias] = `${AGG_LABELS[m.agg]}(${src?.description || m.column})${unitSuffix}`;
      map[`pct_${alias}`] = `占比·${src?.description || m.column}`;
    });
    return map;
  }, [tableSchema, allFields, measures, amountUnit, flexAmountUnit]);

  const chartConfig: ChartConfig | null = useMemo(() => {
    if (!result || dimensions.length === 0 || measures.length === 0 || chartType === 'table') return null;
    return {
      type: chartType,
      title: queryName.trim() || `${tableSchema?.displayName || selectedTable} · 灵活查询`,
      xAxisKey: dimensions[0],
      yAxisKeys: measures.map(measureAlias),
      xAxisName: columnNames[dimensions[0]],
    };
  }, [result, dimensions, measures, chartType, queryName, tableSchema, selectedTable, columnNames]);

  // ---------- v0.4.10 快速计算：占比 / 透视图 / CSV 导出（参照 Agile Query） ----------
  const firstAlias = measures.length ? measureAlias(measures[0]) : '';
  const pctAlias = firstAlias ? `pct_${firstAlias}` : '';

  /** 占比快速计算：首指标占总和的百分比，客户端追加列 */
  const displayRows = useMemo(() => {
    if (!result) return [] as Record<string, any>[];
    if (!showPct || !firstAlias) return result.rows;
    const total = result.rows.reduce((s, r) => s + (Number(r[firstAlias]) || 0), 0);
    return result.rows.map((r) => ({
      ...r,
      [pctAlias]: total > 0 ? `${(((Number(r[firstAlias]) || 0) / total) * 100).toFixed(2)}%` : '-',
    }));
  }, [result, showPct, firstAlias, pctAlias]);

  const displayColumns = useMemo(
    () => (result ? (showPct && firstAlias ? [...result.columns, pctAlias] : result.columns) : []),
    [result, showPct, firstAlias, pctAlias],
  );

  /** 透视图：两维度行列交叉 + 单指标值（客户端透视，不额外查库） */
  const pivot = useMemo(() => {
    if (!result || dimensions.length < 2 || measures.length !== 1) return null;
    const [rowDim, colDim] = dimensions;
    const alias = measureAlias(measures[0]);
    const colSet = new Set<string>();
    const map = new Map<string, Record<string, unknown>>();
    for (const r of result.rows) {
      const rk = String(r[rowDim] ?? '');
      const ck = String(r[colDim] ?? '');
      colSet.add(ck);
      if (!map.has(rk)) map.set(rk, {});
      const rowObj = map.get(rk);
      if (rowObj) rowObj[ck] = r[alias];
    }
    return { rowDim, colDim, alias, cols: [...colSet], map };
  }, [result, dimensions, measures]);
  const pivotAvailable = pivot !== null;

  // P2-12 DLP：导出走服务端统一通道（溯源水印 + 超阈值下载审批）
  const handleExportCsv = async () => {
    if (!result) return;
    const out = await downloadServerCsv({
      title: queryName.trim() || selectedTable || 'flex-query',
      columns: displayColumns,
      columnLabels: columnNames,
      rows: displayRows,
      dataSourceId: activeDataSourceId || undefined,
    });
    showToast(out.message);
  };

  // ---------- 固化 / 保存 ----------
  const handlePin = () => {
    if (!result || !built?.ok || !chartConfig) return;
    pinChartToDashboardRemote({
      title: chartConfig.title,
      chartConfig,
      data: result.rows,
      dataSourceId: activeDataSourceId || undefined,
      // v0.4.8 自主更新联动：携带原 SQL，数据变化时看板自动重放刷新
      sourceSql: built.sql,
    })
      .then(() => showToast('已固化至决策数据看板（数据变化时将自动更新）'))
      .catch((err) => showToast(err?.message || '固化到看板失败'));
  };

  const handleSave = () => {
    if (!built?.ok || !selectedTable) return showToast('请先完成查询配置');
    const name = queryName.trim() || `${tableSchema?.displayName || selectedTable} 报表 ${savedQueries.length + 1}`;
    const item: SavedFlexQuery = {
      id: `flex-${Date.now()}`,
      name,
      dataSourceId: activeDataSourceId,
      config,
      chartType,
      createdAt: new Date().toISOString().slice(0, 10),
    };
    void saveNewQuery(item);
  };

  /** 兼容 v0.4.9 旧配置（orderByFirstMeasure → orderBy）并补齐新字段 */
  const loadConfig = (name: string, dsId: string, rawCfg: any, ct: ChartType, toastMsg: string) => {
    const rawMeasures: FlexMeasure[] = Array.isArray(rawCfg?.measures) ? rawCfg.measures : [];
    let ob: FlexOrderBy | null = rawCfg?.orderBy ?? null;
    if (!ob && rawCfg?.orderByFirstMeasure && rawCfg.orderByFirstMeasure !== 'none' && rawMeasures.length) {
      ob = { by: measureAlias(rawMeasures[0]), dir: rawCfg.orderByFirstMeasure };
    }
    if (dsId !== activeDataSourceId) setActiveDataSource(dsId);
    setSelectedTable(String(rawCfg?.table || ''));
    setDimensions(Array.isArray(rawCfg?.dimensions) ? rawCfg.dimensions : []);
    setMeasures(rawMeasures);
    setFilters(Array.isArray(rawCfg?.filters) ? rawCfg.filters : []);
    setHavings(Array.isArray(rawCfg?.havings) ? rawCfg.havings : []);
    setOrderBy(ob);
    setLimit(typeof rawCfg?.limit === 'number' ? rawCfg.limit : 10000);
    setChartType(ct);
    setQueryName(name);
    setPivotMode(false);
    showToast(toastMsg);
  };

  const loadSaved = (item: SavedFlexQuery) => {
    loadConfig(item.name, item.dataSourceId, item.config, item.chartType, `已载入「${item.name}」，点击执行查询刷新数据`);
  };

  // ---------- 渲染 ----------
  const zoneClass = (zone: DropZone) =>
    `rounded-xl border-2 border-dashed p-2 min-h-[52px] transition-colors ${
      dragOverZone === zone ? 'border-indigo-400 bg-indigo-950/40' : 'border-slate-700 bg-slate-900/60'
    }`;

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
              : '仅 MySQL / PostgreSQL / Greenplum 数据库型数据源支持拖拉拽查询，请在上方切换数据源'}
          </p>
        </div>
      ) : (
        // v0.4.13：上（字段）/中（配置）/下（结果）纵向布局
        <div className="space-y-5">
          {/* 上：表选择 + 字段列表 */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
                <Table2 className="w-3.5 h-3.5 text-indigo-400" />
                <span>数据表与字段</span>
              </span>
              {loadingTables && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
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

            {/* v0.4.14：关联表配置（可选，多表 JOIN） */}
            {tableSchema && (
              <div className="rounded-xl bg-slate-800/40 border border-slate-700/50 p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-slate-400 uppercase flex items-center space-x-1">
                    <Database className="w-3 h-3 text-cyan-400" />
                    <span>关联表（可选）</span>
                  </span>
                  <button
                    onClick={() => setJoins([...joins, { table: '', type: 'INNER', on: { left: '', right: '' } }])}
                    className="text-[10px] px-2 py-0.5 rounded bg-indigo-600/40 text-indigo-200 hover:bg-indigo-600/60 transition-colors"
                  >
                    + 添加关联
                  </button>
                </div>
                {joins.length > 0 && (
                  <div className="space-y-1.5">
                    {joins.map((j, idx) => (
                      <div key={idx} className="flex items-center space-x-1.5 text-[10px] bg-slate-900/60 rounded-lg p-1.5">
                        <select
                          value={j.table}
                          onChange={(e) => {
                            const next = [...joins];
                            next[idx] = { ...j, table: e.target.value };
                            setJoins(next);
                          }}
                          className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200"
                        >
                          <option value="">选表…</option>
                          {tables.filter((t) => t.name !== selectedTable).map((t) => (
                            <option key={t.id} value={t.name}>{t.displayName || t.name}</option>
                          ))}
                        </select>
                        <select
                          value={j.type}
                          onChange={(e) => {
                            const next = [...joins];
                            next[idx] = { ...j, type: e.target.value as 'INNER' | 'LEFT' };
                            setJoins(next);
                          }}
                          className="bg-slate-800 border border-slate-700 rounded px-1 py-1 text-slate-200"
                        >
                          <option value="INNER">INNER</option>
                          <option value="LEFT">LEFT</option>
                        </select>
                        {/* v0.4.15：JOIN 条件下拉化（主表字段/关联表字段） */}
                        <select
                          value={j.on.left}
                          onChange={(e) => {
                            const next = [...joins];
                            next[idx] = { ...j, on: { ...j.on, left: e.target.value } };
                            setJoins(next);
                          }}
                          className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200"
                        >
                          <option value="">主表字段…</option>
                          {tableSchema?.columns.map((c) => (
                            <option key={c.name} value={c.name}>{c.name}</option>
                          ))}
                        </select>
                        <span className="text-slate-500">=</span>
                        <select
                          value={j.on.right}
                          onChange={(e) => {
                            const next = [...joins];
                            next[idx] = { ...j, on: { ...j.on, right: e.target.value } };
                            setJoins(next);
                          }}
                          disabled={!j.table}
                          className="flex-1 bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-slate-200 disabled:opacity-50"
                        >
                          <option value="">关联表字段…</option>
                          {j.table && tables.find((t) => t.name === j.table)?.columns.map((c) => (
                            <option key={c.name} value={c.name}>{c.name}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => setJoins(joins.filter((_, i) => i !== idx))}
                          className="p-1 text-rose-400 hover:text-rose-300"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
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
                                  <Plus className="w-3 h-3 text-slate-600 opacity-0 group-hover:opacity-100 shrink-0" />
                                </div>
                              );
                            })}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* 中：拖放区 + SQL + 执行（v0.4.12：支持全屏） */}
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
                  <p className="text-[10px] text-slate-500 text-center py-1.5">拖入字段添加筛选（支持 = / IN / BETWEEN / IS NULL）</p>
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
                  <p className="text-[10px] text-slate-500 text-center py-1.5">拖入指标添加聚合后条件（如 SUM(投放金额) &gt; 1000）</p>
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

            {/* SQL 预览（v0.4.11：可折叠，收起时单行摘要） */}
            <div className="rounded-xl bg-slate-950 border border-slate-800 p-2.5">
              <button
                onClick={() => setSqlOpen((v) => !v)}
                className="w-full flex items-center justify-between text-[10px] font-bold text-slate-500 uppercase"
              >
                <span>生成 SQL（实时预览）</span>
                {sqlOpen ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
              </button>
              {sqlOpen ? (
                <code className="block mt-1 text-[11px] text-emerald-300 font-mono break-all whitespace-pre-wrap">
                  {built?.ok === true ? built.sql : (built?.ok === false ? built.error : '选择数据表并拖入字段后自动生成')}
                </code>
              ) : (
                <code
                  className={`block mt-1 text-[10px] font-mono truncate ${
                    built?.ok ? 'text-slate-500' : 'text-rose-400'
                  }`}
                >
                  {built?.ok === true ? built.sql : (built?.ok === false ? built.error : '选择数据表并拖入字段后自动生成')}
                </code>
              )}
            </div>

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

          {/* 下：结果 + 固定报表（v0.4.12：支持全屏） */}
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
                      {result.rows.length} 行{execTimeMs !== null ? ` · ${execTimeMs}ms` : ''}
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
                    <DynamicChart config={chartConfig} data={result.rows} height={fullZone === 'result' ? 440 : 260} />
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
                      data={displayRows}
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

            {/* v0.4.13：固定报表与查询历史全宽下并排 */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            {/* 已保存固定报表 */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2.5 shadow-lg">
              <span className="text-xs font-bold text-slate-200 flex items-center space-x-1.5">
                <Bookmark className="w-3.5 h-3.5 text-indigo-400" />
                <span>我的固定报表（{savedQueries.length}）</span>
              </span>
              {savedQueries.length === 0 ? (
                <p className="text-[11px] text-slate-500 py-3 text-center">
                  暂无保存的报表。配置查询后点击「保存为固定报表」，下次一键载入执行。
                </p>
              ) : (
                <div className="space-y-1.5">
                  {savedQueries.map((item) => (
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
                          onClick={() => loadSaved(item)}
                          className="text-[10px] px-2 py-1 rounded-lg bg-indigo-600/30 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-600/50"
                        >
                          载入
                        </button>
                        <button
                          onClick={() => void deleteSavedQuery(item.id)}
                          className="p-1 text-slate-500 hover:text-rose-400"
                          title="删除该固定报表"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {savedQueries.length > 0 && (
                <button
                  onClick={() => setActiveTab('dashboard')}
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
                  <button onClick={() => persistHistory([])} className="text-[10px] text-slate-500 hover:text-rose-400">
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
                      <button
                        onClick={() =>
                          loadConfig(h.name, h.dataSourceId, h.config, h.chartType, `已从历史还原「${h.name}」，点击执行查询重新运行`)
                        }
                        className="shrink-0 text-[10px] px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:border-indigo-500"
                      >
                        还原
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            </div>
          </div>
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
