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
  calcAlias,
  derivedAlias,
  dimResultAlias,
  isAmountColumn,
  measureAlias,
  metricAlias,
  suggestJoinOn,
  FlexCalcField,
  FlexDerived,
  FlexDerivedKind,
  FlexMeasure,
  FlexFilter,
  FlexHaving,
  FlexOrderBy,
  FlexJoin,
  FlexMetricMeasure,
  FlexQueryConfig,
  FlexTimeUnit,
} from '../../../utils/flexQueryBuilder';
import { matchFieldSearch } from '../../../utils/pinyin';
import { pollTask } from '../../../utils/asyncTask';
import { useEffectiveAmountUnit, AMOUNT_UNIT_DIVISORS } from '../../../hooks/useAmountUnitStore';
import { FlexHistoryItem, SavedFlexQuery } from '../FlexQueryLibrary';
import {
  AGG_LABELS,
  ColumnValuesState,
  DB_TYPES,
  DERIVED_LABELS,
  DropZone,
  FieldTab,
  FieldWithTable,
  FlexBuilt,
  FlexPivot,
  FlexResult,
  FlexSubRunItem,
  FlexSubscriptionItem,
  FlexSubscriptionPayload,
  FlexTablePreview,
  FlexVersionItem,
  MetricOption,
  TIME_UNIT_LABELS,
} from '../flexQueryShared';
import { getErrorMessage } from '../../../utils/errorUtils';
import { logger } from '../../../utils/logger';

/** v0.9.24 迁移遗留键：服务端持久化后仅存留一次性迁移源，迁移成功即清除 */
const SAVED_KEY = 'app-flex-queries';
const HISTORY_KEY = 'app-flex-history';
/** v0.9.75：固定报表收藏（本地偏好，跨会话保留） */
const FAVORITES_KEY = 'app-flex-favorites';

/** 载入配置入参：兼容 v0.4.9 前 orderByFirstMeasure 与 v0.4.10~v0.9.74 单列 orderBy（'none' 表示不排序） */
type LoadableFlexConfig = Partial<FlexQueryConfig> & {
  orderByFirstMeasure?: string;
  /** v0.9.75 迁移源：旧版单列排序字段 */
  orderBy?: FlexOrderBy | null;
};

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
  // v0.9.75：列取值探测缓存（声明须在下方 Schema 加载 effect 之前，避免闭包前向引用）
  const [columnValues, setColumnValues] = useState<Record<string, ColumnValuesState>>({});
  // v0.9.76 P1-7：语义指标选择与候选（声明须在下方数据源/语义指标加载 effect 之前，避免闭包前向引用）
  const [metricMeasures, setMetricMeasures] = useState<FlexMetricMeasure[]>([]);
  const [availableMetrics, setAvailableMetrics] = useState<MetricOption[]>([]);
  const [loadingMetrics, setLoadingMetrics] = useState(false);

  // 数据源切换/可用性变化时统一重置并加载 Schema 与语义指标（v0.9.76 P1-7：语义指标并入同源加载，避免独立 effect 重复置位）
  useEffect(() => {
    setTables([]);
    setSelectedTable('');
    setSchemaError(null);
    setColumnValues({});
    setMetricMeasures([]);
    setAvailableMetrics([]);
    setLoadingMetrics(false);
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
    // 语义指标：当前数据源 ACTIVE 指标（仅取编辑器所需字段；加载态与列表同生命周期）
    setLoadingMetrics(true);
    apiFetch(`/api/metrics?dataSourceId=${encodeURIComponent(activeDataSourceId)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        const list = res.ok && Array.isArray(data?.metrics) ? (data.metrics as Record<string, unknown>[]) : [];
        setAvailableMetrics(
          list
            .filter((m) => m.status === 'ACTIVE' && typeof m.id === 'number' && typeof m.name === 'string' && typeof m.expr === 'string')
            .map((m) => ({
              id: m.id as number,
              name: m.name as string,
              expr: m.expr as string,
              tableName: String(m.tableName || ''),
              filters: String(m.filters || ''),
              description: typeof m.description === 'string' ? m.description : undefined,
            })),
        );
      })
      .catch(() => {
        if (!cancelled) setAvailableMetrics([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingMetrics(false);
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
  // v0.9.75：多列排序 / 维度时间粒度 / 合计行开关 / 固定报表收藏 / 列取值探测缓存
  const [orderBys, setOrderBys] = useState<FlexOrderBy[]>([]);
  const [dimTimeUnits, setDimTimeUnits] = useState<Record<string, FlexTimeUnit>>({});
  const [showTotals, setShowTotals] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });
  const [fieldSearch, setFieldSearch] = useState('');
  // v0.9.76 P1：OR 条件组 / 时间衍生列 / 后台执行 / 结果缓存与下钻（语义指标状态见上方 Schema 加载区）
  const [orGroups, setOrGroups] = useState<FlexFilter[][]>([]);
  const [deriveds, setDeriveds] = useState<FlexDerived[]>([]);
  // v0.9.77 P2：计算字段 / 数据预览 / EXPLAIN 预估 / 版本与订阅面板状态
  const [calcFields, setCalcFields] = useState<FlexCalcField[]>([]);
  const [tablePreview, setTablePreview] = useState<FlexTablePreview | null>(null);
  const [estimatedRows, setEstimatedRows] = useState<number | null>(null);
  const [versionPanel, setVersionPanel] = useState<{ queryId: string; name: string } | null>(null);
  const [versions, setVersions] = useState<FlexVersionItem[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [subPanel, setSubPanel] = useState<{ queryId: string; name: string } | null>(null);
  const [subscriptions, setSubscriptions] = useState<FlexSubscriptionItem[]>([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [subRuns, setSubRuns] = useState<Record<string, FlexSubRunItem[]>>({});
  const [exportingExcel, setExportingExcel] = useState(false);
  const [backgroundMode, setBackgroundMode] = useState(false);
  const [asyncProgress, setAsyncProgress] = useState<string | null>(null);
  const [resultCached, setResultCached] = useState(false);
  const [drillTarget, setDrillTarget] = useState<{ dimensionKey: string; dimensionValue: string; dimensionLabel: string; originalSql: string } | null>(null);
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
  // v0.9.77 P2-14c：堆叠（柱/面积）与双轴（柱/折线/面积，需 ≥2 指标）视图开关
  const [chartStacked, setChartStacked] = useState(false);
  const [chartDualAxis, setChartDualAxis] = useState(false);
  const [queryName, setQueryName] = useState('');

  const tableSchema = tables.find((t) => t.name === selectedTable);

  // v0.9.75（承接 v0.4.10 自愈逻辑，扩展为多列 + 粒度清理）：聚合/维度变更后剔除失效排序列
  // （旧别名失效会阻塞执行）；全部失效时回退首指标别名（无指标回退首维度）；同时清理已移除维度的粒度配置
  // v0.9.76：语义指标别名并入有效别名集（排序/衍生列引用同口径校验）
  const validAliases = new Set([...measures.map(measureAlias), ...metricMeasures.map((m) => metricAlias(m.id))]);
  useEffect(() => {
    setOrderBys((prev) => {
      const kept = prev.filter((o) => validAliases.has(o.by) || dimensions.includes(o.by));
      if (kept.length === prev.length) return prev;
      if (kept.length === 0 && prev.length > 0) {
        const fallback = validAliases.size ? [...validAliases][0] : dimensions[0];
        return fallback ? [{ by: fallback, dir: prev[0].dir }] : [];
      }
      return kept;
    });
    setDimTimeUnits((prev) => {
      const keys = Object.keys(prev);
      if (!keys.length) return prev;
      const kept: Record<string, FlexTimeUnit> = {};
      let changed = false;
      for (const k of keys) {
        if (dimensions.includes(k)) kept[k] = prev[k];
        else changed = true;
      }
      return changed ? kept : prev;
    });
    // v0.9.76：衍生列目标失效清理（指标移除后其衍生列一并移除，避免阻塞执行）
    setDeriveds((prev) => {
      const kept = prev.filter((d) => validAliases.has(d.by));
      return kept.length === prev.length ? prev : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measures, dimensions, metricMeasures]);

  /** v0.9.75：设置/清除维度时间粒度（unit 为 null 时清除） */
  const setDimUnit = (column: string, unit: FlexTimeUnit | null) => {
    setDimTimeUnits((prev) => {
      if (unit) return { ...prev, [column]: unit };
      if (!(column in prev)) return prev;
      const next: Record<string, FlexTimeUnit> = {};
      for (const [k, v] of Object.entries(prev)) if (k !== column) next[k] = v;
      return next;
    });
  };
  /** v0.9.75：固定报表收藏切换（本地偏好，写入 localStorage） */
  const toggleFavorite = (id: string) => {
    setFavoriteIds((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [id, ...prev];
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      } catch {
        // 本地存储不可用时仅会话内生效
      }
      return next;
    });
  };
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
  // v0.9.77 P2-16：字段搜索支持拼音首字母（如「xse」命中「销售额」），空关键字不过滤
  const dimensionCols = allFields.filter(
    (c) => c.type !== 'number' && matchFieldSearch(fieldSearch, c.fullName, c.description),
  );
  const measureCols = allFields.filter(
    (c) => c.type === 'number' && matchFieldSearch(fieldSearch, c.fullName, c.description),
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
    () => ({
      table: selectedTable,
      joins,
      dimensions,
      measures,
      filters,
      havings,
      orderBys,
      dimTimeUnits,
      limit,
      // v0.9.76：OR 条件组 / 语义指标 / 时间衍生列（可选段，构建器已做兼容容错）
      orGroups,
      metrics: metricMeasures,
      deriveds,
      // v0.9.77：计算字段
      calcFields,
    }),
    [selectedTable, joins, dimensions, measures, filters, havings, orderBys, dimTimeUnits, limit, orGroups, metricMeasures, deriveds, calcFields],
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
      // v0.9.75：同列同聚合重复添加拦截（同列不同聚合仍可添加）
      if (measures.some((m) => m.column === column && m.agg === 'SUM')) {
        return showToast('该字段已在指标区中（可调整聚合方式）');
      }
      setMeasures((prev) => [...prev, { column, agg: 'SUM' }]);
      // 无排序条件时默认按该指标降序（沿用 v0.4.9 行为，v0.9.75 起仅在排序为空时设定）
      if (orderBys.length === 0) setOrderBys([{ by: measureAlias({ column, agg: 'SUM' }), dir: 'desc' }]);
    } else if (target === 'having') {
      setHavings((prev) => [...prev, { column, agg: 'SUM', op: '>', value: '' }]);
    } else {
      setFilters((prev) => [...prev, { column, op: '=', value: '' }]);
    }
  };

  // ---------- v0.9.79 图形化建联：拖表/点表入画布（表关系画布 TableGraphCanvas） ----------
  /** 拖表入画布建立 JOIN：校验后按字段名启发式预填关联条件（可在连接符或行式面板继续调整） */
  const addJoinByTable = (table: string) => {
    if (!tableSchema) return showToast('请先选择数据表');
    if (!table || table === selectedTable) return showToast('不能把主表自身添加为关联表');
    if (joins.some((j) => j.table === table)) return showToast('该表已在画布中');
    const jt = tables.find((t) => t.name === table);
    if (!jt) return showToast('关联表不存在于当前数据源');
    const on = suggestJoinOn(tableSchema, jt);
    setJoins((prev) => [...prev, { table, type: 'INNER', on }]);
    showToast(`已添加关联表「${jt.displayName || jt.name}」：${on.left || '?'} = ${on.right || '?'}（可点击连接符调整）`);
  };

  // ---------- v0.9.76 P1-7：语义指标（归属表锁定，与 buildFlexQuerySql 同口径前置校验） ----------
  /** 添加语义指标：校验数据表/JOIN/固定过滤一致性；无排序时默认按该指标降序 */
  const addMetricMeasure = (id: number) => {
    const opt = availableMetrics.find((m) => m.id === id);
    if (!opt) return;
    if (!selectedTable) return showToast('请先选择数据表');
    if (metricMeasures.some((m) => m.id === id)) return showToast('该语义指标已在指标区中');
    if (metricMeasures.length >= 8) return showToast('语义指标最多同时使用 8 个');
    if (opt.tableName !== selectedTable) return showToast(`指标「${opt.name}」归属表为「${opt.tableName}」，请先切换数据表`);
    if (joins.length > 0) return showToast('含语义指标时暂不支持关联表（JOIN）');
    if (metricMeasures[0] && String(metricMeasures[0].filters || '').trim() !== String(opt.filters || '').trim()) {
      return showToast('与已选语义指标的固定过滤条件不一致，无法合并查询');
    }
    setMetricMeasures((prev) => [
      ...prev,
      { id: opt.id, name: opt.name, expr: opt.expr, tableName: opt.tableName, filters: opt.filters },
    ]);
    if (orderBys.length === 0) setOrderBys([{ by: metricAlias(opt.id), dir: 'desc' }]);
  };

  const removeMetricMeasure = (id: number) => setMetricMeasures((prev) => prev.filter((m) => m.id !== id));

  // ---------- v0.9.76 P1-8：时间衍生列（同比/环比/累计/移动平均；窗口排序键为已配粒度的首维度） ----------
  /** 是否已配置时间粒度维度（衍生列窗口排序键；无则不满足生成条件） */
  const hasTimeDim = dimensions.some((d) => !!dimTimeUnits[d]);

  /** 添加衍生列：目标须为现有指标/语义指标别名；同目标同类型去重；上限 6 */
  const addDerived = (by: string, kind: FlexDerivedKind, periods?: number) => {
    if (!validAliases.has(by)) return showToast('请先添加目标指标');
    if (!hasTimeDim) return showToast('同比/环比/累计/移动平均需先为日期维度选择时间粒度');
    if (deriveds.length >= 6) return showToast('时间衍生列最多 6 个');
    const alias = derivedAlias(by, kind, periods);
    if (deriveds.some((d) => derivedAlias(d.by, d.kind, d.periods) === alias)) return showToast('该衍生列已存在');
    setDeriveds((prev) => [
      ...prev,
      kind === 'ma' ? { by, kind, periods: Math.min(Math.max(Math.floor(periods || 3), 2), 12) } : { by, kind },
    ]);
  };

  /** 移除衍生列（按衍生别名定位，别名在构建期保证唯一） */
  const removeDerived = (alias: string) => {
    setDeriveds((prev) => prev.filter((d) => derivedAlias(d.by, d.kind, d.periods) !== alias));
  };

  const resetBuilder = () => {
    setDimensions([]);
    setMeasures([]);
    setFilters([]);
    setHavings([]);
    setOrderBys([]);
    setDimTimeUnits({});
    setShowTotals(false);
    // 列取值缓存随表切换清空（同名列表在不同表取值可能不同）
    setColumnValues({});
    // v0.9.64：重置回默认行数（与初始值一致），此前重置为 100 会让「取回全部明细」类取数被静默压到 100 行
    setLimit(10000);
    setResult(null);
    setExecError(null);
    setPivotMode(false);
    setShowPct(false);
    setChartStacked(false);
    setChartDualAxis(false);
    // v0.9.76：语义指标 / OR 条件组 / 时间衍生列 / 缓存标记 / 下钻目标一并清空
    setMetricMeasures([]);
    setOrGroups([]);
    setDeriveds([]);
    setResultCached(false);
    setDrillTarget(null);
    // v0.9.77 P2：计算字段 / 数据预览 / EXPLAIN 预估一并清空
    setCalcFields([]);
    setTablePreview(null);
    setEstimatedRows(null);
  };

  // ---------- v0.9.75：低基数列取值探测（服务端 DISTINCT + 白名单/敏感列约束，懒加载缓存） ----------
  /** 加载指定列候选取值（筛选值下拉用）；已缓存不重复请求，失败可再次点击重试 */
  const fetchColumnValues = async (fullName: string) => {
    if (!activeDataSourceId) return;
    const cached = columnValues[fullName];
    if (cached && cached.status !== 'error') return;
    const src = allFields.find((c) => c.fullName === fullName);
    if (!src) return;
    setColumnValues((prev) => ({ ...prev, [fullName]: { status: 'loading' } }));
    try {
      const res = await apiFetch(
        `/api/datasources/${encodeURIComponent(activeDataSourceId)}/flex-column-values?table=${encodeURIComponent(src.table)}&column=${encodeURIComponent(src.name)}`,
      );
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success && Array.isArray(data.values)) {
        setColumnValues((prev) => ({
          ...prev,
          [fullName]: { status: 'ready', values: data.values as string[], truncated: data.truncated === true },
        }));
      } else {
        setColumnValues((prev) => ({ ...prev, [fullName]: { status: 'error' } }));
        showToast(data?.error || '字段取值加载失败');
      }
    } catch {
      setColumnValues((prev) => ({ ...prev, [fullName]: { status: 'error' } }));
      showToast('网络异常，字段取值加载失败');
    }
  };

  // ---------- 执行 ----------
  /** v0.9.76：执行中止控制器（同步请求/后台等待共用；取消仅停止前端等待，服务端任务继续执行） */
  const abortRef = useRef<AbortController | null>(null);
  /** v0.9.76：最近一次成功执行的 SQL（下钻 AST 改写复用；后台执行同样记录） */
  const executedSqlRef = useRef('');

  /** 写入最近查询历史（按配置去重，上限 8 条；v0.9.76 自 runQuery 抽取供同步/后台路径复用） */
  const pushHistory = (dsId: string) => {
    const cfgKey = JSON.stringify(config);
    const item: FlexHistoryItem = {
      id: `hist-${Date.now()}`,
      name: queryName.trim() || `${tableSchema?.displayName || config.table} 查询`,
      dataSourceId: dsId,
      config: JSON.parse(cfgKey) as FlexQueryConfig,
      chartType,
      // v0.9.77 P2-14c：视图选项随历史保存（还原时一并生效）
      chartOptions: { stacked: chartStacked, dualAxis: chartDualAxis },
      ranAt: `${new Date().toISOString().slice(5, 10)} ${new Date().toTimeString().slice(0, 5)}`,
    };
    persistHistory([item, ...history.filter((h) => JSON.stringify(h.config) !== cfgKey)].slice(0, 8));
  };

  /** v0.9.76 P1-9：取消当前执行/等待（AbortController） */
  const cancelQuery = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  /**
   * v0.9.76：执行查询。opts.bypassCache=true 跳过服务端结果缓存（强制刷新）；
   * backgroundMode=true 转异步任务端点并轮询进度（大查询不阻塞页面，P1-10）。
   */
  const runQuery = async (sqlOverride?: string, dsIdOverride?: string, opts?: { bypassCache?: boolean }) => {
    const sql = sqlOverride ?? (built?.ok ? built.sql : null);
    // 注意：基线 tsconfig 未启 strictNullChecks，布尔判别式 !built.ok 无法窄化联合类型，须用 === false 显式比较
    if (!sql) return setExecError(built && built.ok === false ? built.error : '请先选择数据表并拖入维度/指标');
    const dsId = dsIdOverride ?? activeDataSourceId;
    if (!dsId) return setExecError('请先选择数据源');
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setExecuting(true);
    setExecError(null);
    setResultCached(false);
    setAsyncProgress(null);
    setEstimatedRows(null);
    try {
      if (backgroundMode) {
        // P1-10：提交后台任务 → 轮询 → 以任务结果渲染（结果已按提交人快照 DLP 脱敏）
        const submitRes = await apiFetch('/api/query/execute-sql-async', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataSourceId: dsId, sql }),
          signal: ac.signal,
        });
        const submitted = await submitRes.json().catch(() => null);
        if (!submitRes.ok || !submitted?.taskId) throw new Error(submitted?.error || `后台执行提交失败（HTTP ${submitRes.status}）`);
        setAsyncProgress('后台任务已提交，等待执行…');
        const task = await pollTask(String(submitted.taskId), {
          signal: ac.signal,
          onProgress: (progress, status) => setAsyncProgress(`${status === 'PENDING' ? '排队中' : '执行中'}：${progress}`),
        });
        const payload = (task.result ?? null) as { rows?: Record<string, unknown>[]; truncated?: boolean; executionTimeMs?: number } | null;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const cols = rows.length ? Object.keys(rows[0]) : [];
        executedSqlRef.current = sql;
        setResult({ columns: cols, rows, truncated: payload?.truncated === true });
        setExecTimeMs(typeof payload?.executionTimeMs === 'number' ? payload.executionTimeMs : null);
        pushHistory(dsId);
        return;
      }
      const res = await apiFetch('/api/query/execute-sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId: dsId, sql, ...(opts?.bypassCache ? { bypassCache: true } : {}) }),
        signal: ac.signal,
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success && Array.isArray(data.rows)) {
        const cols = data.rows.length ? Object.keys(data.rows[0]) : [];
        executedSqlRef.current = sql;
        setResult({ columns: cols, rows: data.rows as Record<string, unknown>[], truncated: data.truncated === true });
        setExecTimeMs(typeof data.executionTimeMs === 'number' ? data.executionTimeMs : null);
        // P1-9：服务端结果缓存命中标记（结果区展示「缓存命中」与强制刷新入口）
        setResultCached(data.cached === true);
        // v0.9.77 P2-14：EXPLAIN 预估扫描行数（大扫描提示；服务端未提供时缺省）
        setEstimatedRows(typeof data.estimatedRows === 'number' ? data.estimatedRows : null);
        pushHistory(dsId);
      } else {
        setExecError(data?.error || `执行失败（HTTP ${res.status}）`);
      }
    } catch (err) {
      const msg = getErrorMessage(err) || '';
      const errName = (err as { name?: string })?.name;
      if (ac.signal.aborted || errName === 'AbortError' || msg.includes('已取消')) {
        setExecError(msg.includes('任务等待') ? '已取消等待（任务仍在后台执行，可在任务中心查看结果）' : '已取消执行');
      } else {
        setExecError(msg || '网络异常，执行失败');
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setExecuting(false);
      setAsyncProgress(null);
    }
  };

  /** v0.9.76 P1-9：强制刷新（跳过服务端结果缓存重执行） */
  const runQueryForceRefresh = () => runQuery(undefined, undefined, { bypassCache: true });

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
    // v0.9.76：语义指标列名（指标名 + 口径说明悬浮）与时间衍生列名（目标指标名 · 衍生类型标注）
    metricMeasures.forEach((mt) => {
      map[metricAlias(mt.id)] = mt.name;
    });
    deriveds.forEach((dv) => {
      const base = map[dv.by] || dv.by;
      const suffix = dv.kind === 'ma' ? `MA(${Math.min(Math.max(Math.floor(dv.periods || 3), 2), 12)})` : DERIVED_LABELS[dv.kind];
      map[derivedAlias(dv.by, dv.kind, dv.periods)] = `${base}·${suffix}`;
    });
    // v0.9.77 P2-13：计算字段列名（展示名）
    calcFields.forEach((cf) => {
      map[calcAlias(cf)] = cf.name;
    });
    // v0.9.75：维度结果列名（末段列名）登记，含时间粒度标注；跨表维度配置键与结果键双向登记
    dimensions.forEach((d) => {
      const src = allFields.find((c) => c.fullName === d) || tableSchema?.columns.find((c) => c.name === d);
      const unit = dimTimeUnits[d];
      const label = `${src?.description || d}${unit ? `（${TIME_UNIT_LABELS[unit]}）` : ''}`;
      map[d] = label;
      map[dimResultAlias(d)] = label;
    });
    return map;
  }, [tableSchema, allFields, measures, metricMeasures, deriveds, dimensions, dimTimeUnits, amountUnit, flexAmountUnit, calcFields]);

  const chartConfig: ChartConfig | null = useMemo(() => {
    if (!result || chartType === 'table') return null;
    // v0.9.77 P2-14c：KPI 卡片不要求维度（单行聚合即可）；其余图表需至少 1 个维度
    if (chartType !== 'kpi' && dimensions.length === 0) return null;
    // v0.9.76：y 轴含普通指标 + 语义指标 + 累计/移动平均衍生列（同比/环比为比率列，仅在表格查看）
    const yAxisKeys = [
      ...measures.map(measureAlias),
      ...metricMeasures.map((m) => metricAlias(m.id)),
      ...deriveds.filter((d) => d.kind === 'cum' || d.kind === 'ma').map((d) => derivedAlias(d.by, d.kind, d.periods)),
      // v0.9.77 P2-13：计算字段并入 y 轴（数值型，与指标同权）
      ...calcFields.map(calcAlias),
    ];
    if (yAxisKeys.length === 0) return null;
    const xKey = dimensions.length ? dimResultAlias(dimensions[0]) : '';
    return {
      type: chartType,
      title: queryName.trim() || `${tableSchema?.displayName || selectedTable} · 灵活查询`,
      xAxisKey: xKey,
      yAxisKeys,
      xAxisName: xKey ? columnNames[xKey] : undefined,
      // v0.9.77 P2-14c：堆叠 / 双轴（未开启时不写入，旧报表行为不变）
      ...(chartStacked ? { stacked: true } : {}),
      ...(chartDualAxis ? { dualAxis: true } : {}),
    };
  }, [result, dimensions, measures, metricMeasures, deriveds, calcFields, chartType, queryName, tableSchema, selectedTable, columnNames, chartStacked, chartDualAxis]);

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

  /**
   * v0.9.75 合计行：客户端累计（只读展示，不额外查库）。SUM/COUNT 求和、MIN/MAX 取极值（分组最值的全局最值）；
   * AVG/COUNT_DISTINCT 无合计语义显示 -；结果被服务端截断时返回 null（合计不完整会误导，UI 同步禁用开关）。
   */
  const totalsRow = useMemo(() => {
    if (!result || !showTotals || result.truncated) return null;
    const row: Record<string, unknown> = {};
    dimensions.forEach((d, i) => {
      row[dimResultAlias(d)] = i === 0 ? '合计' : null;
    });
    for (const m of measures) {
      const alias = measureAlias(m);
      if (m.agg === 'AVG' || m.agg === 'COUNT_DISTINCT') {
        row[alias] = null;
        continue;
      }
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      let any = false;
      for (const r of result.rows) {
        const v = Number(r[alias]);
        if (!Number.isFinite(v)) continue;
        any = true;
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!any) {
        row[alias] = null;
        continue;
      }
      const val = m.agg === 'MIN' ? min : m.agg === 'MAX' ? max : sum;
      row[alias] = m.agg === 'COUNT' ? Math.round(val) : Math.round(val * 100) / 100;
    }
    // v0.9.76：语义指标与衍生列无客户端合计语义（口径由表达式决定），置空展示 -
    metricMeasures.forEach((mt) => {
      row[metricAlias(mt.id)] = null;
    });
    deriveds.forEach((dv) => {
      row[derivedAlias(dv.by, dv.kind, dv.periods)] = null;
    });
    // v0.9.77 P2-13：计算字段无客户端合计语义（表达式口径），置空展示 -
    calcFields.forEach((cf) => {
      row[calcAlias(cf)] = null;
    });
    return row;
  }, [result, showTotals, dimensions, measures, metricMeasures, deriveds, calcFields]);

  /** 透视图：两维度行列交叉 + 单指标值（客户端透视，不额外查库） */
  const pivot: FlexPivot | null = useMemo(() => {
    if (!result || dimensions.length < 2 || measures.length !== 1) return null;
    const [rowDim, colDim] = dimensions.map(dimResultAlias);
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
      rows: totalsRow ? [...displayRows, totalsRow] : displayRows,
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
      // v0.9.77 P2-14c：视图选项随报表持久化（堆叠/双轴）
      chartOptions: { stacked: chartStacked, dualAxis: chartDualAxis },
      createdAt: new Date().toISOString().slice(0, 10),
    };
    void saveNewQuery(item);
  };

  /** 兼容旧配置并补齐新字段：排序迁移链 orderBys（新）→ orderBy（v0.4.10 单列）→ orderByFirstMeasure（v0.4.9 前） */
  const loadConfig = (
    name: string,
    dsId: string,
    rawCfg: LoadableFlexConfig,
    ct: ChartType,
    toastMsg: string,
    chartOptions?: { stacked?: boolean; dualAxis?: boolean },
  ) => {
    const rawMeasures: FlexMeasure[] = Array.isArray(rawCfg?.measures) ? rawCfg.measures : [];
    let obs: FlexOrderBy[] = Array.isArray(rawCfg?.orderBys) ? rawCfg.orderBys.filter((o) => !!o && !!o.by) : [];
    if (!obs.length && rawCfg?.orderBy?.by) {
      obs = [{ by: rawCfg.orderBy.by, dir: rawCfg.orderBy.dir === 'asc' ? 'asc' : 'desc' }];
    }
    if (!obs.length && rawCfg?.orderByFirstMeasure && rawCfg.orderByFirstMeasure !== 'none' && rawMeasures.length) {
      obs = [{ by: measureAlias(rawMeasures[0]), dir: rawCfg.orderByFirstMeasure === 'asc' ? 'asc' : 'desc' }];
    }
    if (dsId !== activeDataSourceId) setActiveDataSource(dsId);
    setSelectedTable(String(rawCfg?.table || ''));
    setDimensions(Array.isArray(rawCfg?.dimensions) ? rawCfg.dimensions : []);
    setMeasures(rawMeasures);
    setFilters(Array.isArray(rawCfg?.filters) ? rawCfg.filters : []);
    setHavings(Array.isArray(rawCfg?.havings) ? rawCfg.havings : []);
    // v0.9.76：可选段兼容加载（旧配置无这些字段，按空处理；语义指标仅保留与配置表同归属的合法项）
    setMetricMeasures(
      Array.isArray(rawCfg?.metrics)
        ? rawCfg.metrics.filter((m) => !!m && typeof m.id === 'number' && typeof m.expr === 'string' && String(m.tableName || '') === String(rawCfg?.table || ''))
        : [],
    );
    setOrGroups(Array.isArray(rawCfg?.orGroups) ? rawCfg.orGroups.filter((g) => Array.isArray(g)) : []);
    setDeriveds(Array.isArray(rawCfg?.deriveds) ? rawCfg.deriveds.filter((d) => !!d && !!d.by && !!d.kind) : []);
    // v0.9.77 P2：计算字段（旧配置无此段按空处理；id/name/expr 三段校验）
    setCalcFields(
      Array.isArray(rawCfg?.calcFields)
        ? rawCfg.calcFields.filter((f) => !!f && typeof f.id === 'string' && typeof f.name === 'string' && typeof f.expr === 'string')
        : [],
    );
    setTablePreview(null);
    setEstimatedRows(null);
    setResultCached(false);
    setDrillTarget(null);
    setOrderBys(obs);
    setDimTimeUnits(rawCfg?.dimTimeUnits && typeof rawCfg.dimTimeUnits === 'object' ? rawCfg.dimTimeUnits : {});
    setShowTotals(false);
    setColumnValues({});
    setLimit(typeof rawCfg?.limit === 'number' ? rawCfg.limit : 10000);
    setChartType(ct);
    // v0.9.77 P2-14c：视图选项（旧配置无此段时重置为关闭）
    setChartStacked(chartOptions?.stacked === true);
    setChartDualAxis(chartOptions?.dualAxis === true);
    setQueryName(name);
    setPivotMode(false);
    showToast(toastMsg);
  };

  const loadSaved = (item: SavedFlexQuery) => {
    // v0.9.77 P2-15：载入即打点（使用统计；失败容忍，不阻塞载入）
    void apiFetch(`/api/flex-queries/${encodeURIComponent(item.id)}/touch`, { method: 'POST' }).catch(() => {});
    loadConfig(item.name, item.dataSourceId, item.config, item.chartType, `已载入「${item.name}」，点击执行查询刷新数据`, item.chartOptions);
  };

  /** 从最近查询历史还原（原为渲染期内联回调，等价迁移） */
  const loadHistory = (h: FlexHistoryItem) => {
    loadConfig(h.name, h.dataSourceId, h.config, h.chartType, `已从历史还原「${h.name}」，点击执行查询重新运行`, h.chartOptions);
  };

  /** v0.9.75：历史一键存为固定报表（按历史原配置保存，不改变当前画布） */
  const saveFromHistory = (h: FlexHistoryItem) => {
    const item: SavedFlexQuery = {
      id: `flex-${Date.now()}`,
      name: h.name,
      dataSourceId: h.dataSourceId,
      config: h.config,
      chartType: h.chartType,
      // v0.9.77 P2-14c：视图选项随历史转为报表
      chartOptions: h.chartOptions,
      createdAt: new Date().toISOString().slice(0, 10),
    };
    void saveNewQuery(item);
  };

  // ---------- v0.9.76 P1-12：图表下钻（复用 /api/query/drill 的 AST 改写通道） ----------
  /** 下钻可用性：直角坐标图（柱/折线/面积）+ 首维度非时间粒度（时间粒度下钻语义不明确） */
  const chartDrillable = useMemo(
    () => !!chartConfig && (chartType === 'bar' || chartType === 'line' || chartType === 'area') && !dimTimeUnits[dimensions[0]],
    [chartConfig, chartType, dimTimeUnits, dimensions],
  );

  /** 点击图表维度触发下钻：以最近成功执行的 SQL 为底，记录维度键/值供 DrillModal 改写 */
  const handleDrill = (dimensionKey: string, dimensionValue: string | number) => {
    const originalSql = executedSqlRef.current || (built?.ok ? built.sql : '');
    if (!originalSql || !result) return;
    const key = dimResultAlias(dimensionKey);
    setDrillTarget({
      dimensionKey: key,
      dimensionValue: String(dimensionValue),
      dimensionLabel: columnNames[key] || dimensionKey,
      originalSql,
    });
  };

  const closeDrill = () => setDrillTarget(null);

  // ---------- v0.9.77 P2-13：计算字段（表达式作用于聚合结果列，白名单函数；服务端编译期二次校验） ----------
  /** 添加计算字段草稿行（名称/表达式行内编辑；非空/去重/上限由执行期构建器统一校验并提示） */
  const addCalcField = () => {
    if (calcFields.length >= 4) return showToast('计算字段最多 4 个');
    setCalcFields((prev) => [
      ...prev,
      { id: `calc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: '', expr: '' },
    ]);
  };

  /** 更新计算字段（按 id 定位；空值/合法性由执行期统一校验提示） */
  const updateCalcField = (id: string, patch: Partial<Pick<FlexCalcField, 'name' | 'expr'>>) => {
    setCalcFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const removeCalcField = (id: string) => setCalcFields((prev) => prev.filter((f) => f.id !== id));

  // ---------- v0.9.77 P2-16：数据表预览（样例 10 行；服务端已剔除敏感列，走只读安全通道） ----------
  const previewTable = async (table?: string) => {
    const t = String(table || selectedTable || '');
    if (!activeDataSourceId || !t) return;
    setTablePreview({ loading: true, error: null, table: t, columns: [], rows: [] });
    try {
      const res = await apiFetch(
        `/api/datasources/${encodeURIComponent(activeDataSourceId)}/flex-preview?table=${encodeURIComponent(t)}&limit=10`,
      );
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setTablePreview({
          loading: false,
          error: null,
          table: t,
          columns: Array.isArray(data.columns) ? (data.columns as string[]) : [],
          rows: Array.isArray(data.rows) ? (data.rows as Record<string, unknown>[]) : [],
        });
      } else {
        setTablePreview({ loading: false, error: data?.error || `预览加载失败（HTTP ${res.status}）`, table: t, columns: [], rows: [] });
      }
    } catch {
      setTablePreview({ loading: false, error: '网络异常，预览加载失败', table: t, columns: [], rows: [] });
    }
  };
  const closePreview = () => setTablePreview(null);

  // 表格切换时清空预览（预览内容与选中表强绑定）
  useEffect(() => {
    setTablePreview(null);
  }, [selectedTable]);

  // ---------- v0.9.77 P2-15：固定报表版本历史（快照不可变，回滚以 version+1 记 RESTORE） ----------
  /** 重新拉取服务端固定报表列表（版本回滚后同步本地列表） */
  const refreshSavedQueries = async () => {
    try {
      const res = await apiFetch('/api/flex-queries');
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success && Array.isArray(data.queries)) {
        setSavedQueries(
          (data.queries as { query?: SavedFlexQuery }[])
            .map((r) => r.query)
            .filter((q): q is SavedFlexQuery => !!q && typeof q.id === 'string'),
        );
      }
    } catch {
      // 刷新失败保留本地列表
    }
  };

  /** 打开版本面板并拉取版本列表（新→旧，含快照供详情查看） */
  const openVersions = async (queryId: string, name: string) => {
    setVersionPanel({ queryId, name });
    setVersions([]);
    setLoadingVersions(true);
    try {
      const res = await apiFetch(`/api/flex-queries/${encodeURIComponent(queryId)}/versions`);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success && Array.isArray(data.versions)) setVersions(data.versions as FlexVersionItem[]);
      else showToast(data?.error || '版本历史加载失败');
    } catch {
      showToast('网络异常，版本历史加载失败');
    } finally {
      setLoadingVersions(false);
    }
  };
  const closeVersions = () => {
    setVersionPanel(null);
    setVersions([]);
  };

  /** 回滚到指定版本：成功后刷新版本列表与固定报表列表 */
  const restoreVersion = async (queryId: string, version: number) => {
    try {
      const res = await apiFetch(
        `/api/flex-queries/${encodeURIComponent(queryId)}/versions/${version}/restore`,
        { method: 'POST' },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || '回滚失败');
      showToast(`已回滚到 v${version}（生成 v${data.version}）`);
      await refreshSavedQueries();
      setVersions([]);
      await openVersions(queryId, versionPanel?.name || '');
    } catch (err) {
      showToast((err as Error)?.message || '回滚失败');
    }
  };

  // ---------- v0.9.77 P2-15：报表订阅（周期重跑 + 阈值告警；服务端 60s 调度） ----------
  /** 打开订阅面板并拉取该报表订阅列表（团队共享展示） */
  const openSubscriptions = async (queryId: string, name: string) => {
    setSubPanel({ queryId, name });
    setSubscriptions([]);
    setSubRuns({});
    setLoadingSubs(true);
    try {
      const res = await apiFetch(`/api/flex-queries/${encodeURIComponent(queryId)}/subscriptions`);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success && Array.isArray(data.subscriptions)) setSubscriptions(data.subscriptions as FlexSubscriptionItem[]);
      else showToast(data?.error || '订阅列表加载失败');
    } catch {
      showToast('网络异常，订阅列表加载失败');
    } finally {
      setLoadingSubs(false);
    }
  };
  const closeSubscriptions = () => {
    setSubPanel(null);
    setSubscriptions([]);
    setSubRuns({});
  };

  /** 创建订阅（周期 5~10080 分钟；告警指标为空 = 仅重跑不告警）；返回是否成功供表单清空判断 */
  const createSubscription = async (queryId: string, payload: FlexSubscriptionPayload) => {
    try {
      const res = await apiFetch(`/api/flex-queries/${encodeURIComponent(queryId)}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || '订阅创建失败');
      showToast('订阅已创建（首次执行延后一个周期）');
      await openSubscriptions(queryId, subPanel?.name || '');
      return true;
    } catch (err) {
      showToast((err as Error)?.message || '订阅创建失败');
      return false;
    }
  };

  /** 更新订阅（status 可选：ACTIVE/PAUSED 暂停恢复；更新即重新排期） */
  const updateSubscription = async (
    queryId: string,
    subscriptionId: string,
    payload: FlexSubscriptionPayload,
    status?: string,
  ) => {
    try {
      const res = await apiFetch(`/api/flex-queries/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ...(status ? { status } : {}) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || '订阅更新失败');
      showToast('订阅已更新');
      await openSubscriptions(queryId, subPanel?.name || '');
      return true;
    } catch (err) {
      showToast((err as Error)?.message || '订阅更新失败');
      return false;
    }
  };

  /** 删除订阅（本人或 ADMIN）；成功后刷新列表 */
  const deleteSubscription = async (subscriptionId: string) => {
    const queryId = subPanel?.queryId;
    try {
      const res = await apiFetch(`/api/flex-queries/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || '订阅删除失败');
      showToast('订阅已删除');
      if (queryId) await openSubscriptions(queryId, subPanel?.name || '');
    } catch (err) {
      showToast((err as Error)?.message || '订阅删除失败');
    }
  };

  /** 加载订阅运行历史（展开行时懒加载，非关键数据静默） */
  const loadSubRuns = async (subscriptionId: string) => {
    try {
      const res = await apiFetch(`/api/flex-queries/subscriptions/${encodeURIComponent(subscriptionId)}/runs`);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success && Array.isArray(data.runs)) {
        setSubRuns((prev) => ({ ...prev, [subscriptionId]: data.runs as FlexSubRunItem[] }));
      }
    } catch {
      // 运行历史加载失败静默
    }
  };

  /** 立即执行一次（不改变既有排期；结果含告警判定状态，刷新运行历史） */
  const runSubscriptionNow = async (subscriptionId: string) => {
    try {
      const res = await apiFetch(`/api/flex-queries/subscriptions/${encodeURIComponent(subscriptionId)}/run`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error || '执行失败');
      showToast(`订阅执行完成：${data.result?.status || 'SUCCESS'}`);
      await loadSubRuns(subscriptionId);
    } catch (err) {
      showToast((err as Error)?.message || '订阅执行失败');
    }
  };

  // ---------- v0.9.77 P2-15：Excel 导出（服务端重放报表并组装 XLSX，含溯源水印） ----------
  const handleExportExcel = async (queryId: string, name?: string) => {
    if (exportingExcel) return;
    setExportingExcel(true);
    try {
      const res = await apiFetch(`/api/flex-queries/${encodeURIComponent(queryId)}/export-excel`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `导出失败（HTTP ${res.status}）`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name || queryName.trim() || '灵活查询'}-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('Excel 已开始下载');
    } catch (err) {
      showToast((err as Error)?.message || 'Excel 导出失败');
    } finally {
      setExportingExcel(false);
    }
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
    orderBys,
    setOrderBys,
    dimTimeUnits,
    setDimUnit,
    showTotals,
    setShowTotals,
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
    // v0.9.77 P2-14c：堆叠 / 双轴视图开关
    chartStacked,
    setChartStacked,
    chartDualAxis,
    setChartDualAxis,
    queryName,
    setQueryName,
    // v0.9.76 新增配置段（语义指标 / OR 组 / 时间衍生列 / 后台执行）
    metricMeasures,
    addMetricMeasure,
    removeMetricMeasure,
    orGroups,
    setOrGroups,
    deriveds,
    setDeriveds,
    addDerived,
    removeDerived,
    hasTimeDim,
    availableMetrics,
    loadingMetrics,
    backgroundMode,
    setBackgroundMode,
    // 派生
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
    // v0.9.76：后台进度 / 缓存命中标记 / 下钻
    asyncProgress,
    resultCached,
    drillTarget,
    chartDrillable,
    handleDrill,
    closeDrill,
    // 快速计算
    pivot,
    pivotAvailable,
    displayRows,
    displayColumns,
    totalsRow,
    chartConfig,
    // 行为
    addField,
    addJoinByTable,
    resetBuilder,
    runQuery,
    runQueryForceRefresh,
    cancelQuery,
    fetchColumnValues,
    columnValues,
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
    favoriteIds,
    toggleFavorite,
    saveFromHistory,
    // v0.9.77 P2：计算字段 / 数据预览 / EXPLAIN 预估 / 版本历史 / 订阅 / Excel 导出
    calcFields,
    setCalcFields,
    addCalcField,
    updateCalcField,
    removeCalcField,
    tablePreview,
    previewTable,
    closePreview,
    estimatedRows,
    versionPanel,
    versions,
    loadingVersions,
    openVersions,
    closeVersions,
    restoreVersion,
    refreshSavedQueries,
    subPanel,
    subscriptions,
    loadingSubs,
    subRuns,
    openSubscriptions,
    closeSubscriptions,
    createSubscription,
    updateSubscription,
    deleteSubscription,
    runSubscriptionNow,
    loadSubRuns,
    handleExportExcel,
    exportingExcel,
  };
}
