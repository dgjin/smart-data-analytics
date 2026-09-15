// P0 上帝组件拆分：自 FlexQueryBuilder.tsx 提取的状态与行为 Hook（行为保持一致，纯逻辑无 JSX）
// 涵盖：Schema 加载 / 查询配置状态 / SQL 构建与执行 / 快速计算（占比·透视）/ CSV 导出 /
// 固定报表与查询历史服务端持久化（含 localStorage 遗留迁移）/ 固化到看板
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAnalyticsStore } from '../../../hooks/useAnalyticsStore';
import { apiFetch } from '../../../api/client';
import { downloadServerCsv } from '../../../utils/exportCsv';
import { TableSchema, ChartConfig, ChartType } from '../../../types/analytics';
import {
  buildFlexQuerySql,
  isAmountColumn,
  measureAlias,
  FlexMeasure,
  FlexFilter,
  FlexHaving,
  FlexOrderBy,
  FlexJoin,
  FlexQueryConfig,
} from '../../../utils/flexQueryBuilder';
import { useEffectiveAmountUnit, AMOUNT_UNIT_DIVISORS } from '../../../hooks/useAmountUnitStore';
import { FlexHistoryItem, SavedFlexQuery } from '../FlexQueryLibrary';
import {
  AGG_LABELS,
  DB_TYPES,
  DropZone,
  FieldTab,
  FieldWithTable,
  FlexBuilt,
  FlexPivot,
  FlexResult,
} from '../flexQueryShared';
import { getErrorMessage } from '../../../utils/errorUtils';
import { logger } from '../../../utils/logger';

/** v0.9.24 迁移遗留键：服务端持久化后仅存留一次性迁移源，迁移成功即清除 */
const SAVED_KEY = 'app-flex-queries';
const HISTORY_KEY = 'app-flex-history';

/** 载入配置入参：兼容 v0.4.9 前旧字段 orderByFirstMeasure（'none' 表示不排序） */
type LoadableFlexConfig = Partial<FlexQueryConfig> & { orderByFirstMeasure?: string };

/**
 * 灵活查询构建器状态 Hook（P0 上帝组件拆分：自 FlexQueryBuilder 提取，行为保持一致）。
 * 所有状态与行为集中于此，渲染由 FlexQueryBuilder 及 FieldPalette / BuilderCanvas / PreviewPanel 承担。
 */
export function useFlexQueryState() {
  const {
    dataSources,
    activeDataSourceId,
    setActiveDataSource,
    pinChartToDashboardRemote,
    setActiveTab,
  } = useAnalyticsStore();

  const activeDS = dataSources.find((ds) => ds.id === activeDataSourceId);
  // v0.9.34：已落库文件型数据源（config.physicalTable = upl_*）同样走真实执行链路
  const isFileBacked = !!activeDS?.config?.physicalTable;
  const dbSupported = !!activeDS && (DB_TYPES.includes(activeDS.type) || isFileBacked) && activeDS.status !== 'disconnected';
  // 文件源落应用库（MySQL），生成的 SQL 方言按 mysql
  const dialect: 'mysql' | 'pg' = activeDS?.type === 'mysql' || isFileBacked ? 'mysql' : 'pg';

  // ---------- Schema 加载 ----------
  const [tables, setTables] = useState<TableSchema[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState('');

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
  const built: FlexBuilt = useMemo(
    () => (tableSchema ? buildFlexQuerySql(config, tableSchema, dialect, tables, flexAmountUnit) : null),
    [config, tableSchema, dialect, tables, flexAmountUnit],
  );

  // ---------- 执行结果 ----------
  const [result, setResult] = useState<FlexResult | null>(null);
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
    }).catch((err) => logger.warn('[flex-query] 查询历史同步失败:', err));
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
    } catch (err) {
      setExecError(getErrorMessage(err) || '网络异常，执行失败');
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
    if (!result) return [] as Record<string, unknown>[];
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
  const pivot: FlexPivot | null = useMemo(() => {
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
  const loadConfig = (name: string, dsId: string, rawCfg: LoadableFlexConfig, ct: ChartType, toastMsg: string) => {
    const rawMeasures: FlexMeasure[] = Array.isArray(rawCfg?.measures) ? rawCfg.measures : [];
    let ob: FlexOrderBy | null = rawCfg?.orderBy ?? null;
    if (!ob && rawCfg?.orderByFirstMeasure && rawCfg.orderByFirstMeasure !== 'none' && rawMeasures.length) {
      ob = { by: measureAlias(rawMeasures[0]), dir: rawCfg.orderByFirstMeasure as FlexOrderBy['dir'] };
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

  /** 从最近查询历史还原（原为渲染期内联回调，等价迁移） */
  const loadHistory = (h: FlexHistoryItem) => {
    loadConfig(h.name, h.dataSourceId, h.config, h.chartType, `已从历史还原「${h.name}」，点击执行查询重新运行`);
  };

  return {
    // store 透出（顶部数据源切换 + 看板跳转）
    dataSources,
    activeDataSourceId,
    setActiveDataSource,
    goDashboard: () => setActiveTab('dashboard'),
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
  };
}
