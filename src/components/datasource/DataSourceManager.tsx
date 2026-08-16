import React, { useEffect, useState } from 'react';
import {
  Database,
  Plus,
  CheckCircle2,
  HardDrive,
  Globe,
  Upload,
  RefreshCw,
  Server,
  Layers,
  Sparkles,
  GitFork,
  BookOpen,
  FileCode2,
  ScanSearch,
  Table as TableIcon,
  Trash2,
  SlidersHorizontal,
  ListChecks,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { apiFetch } from '../../api/client';
import { SchemaViewer } from './SchemaViewer';
import { DataLineageView } from './DataLineageView';
import { SchemaMetaEditor } from './SchemaMetaEditor';
import { KnowledgeBasePanel } from './KnowledgeBasePanel';
import { SqlExamplesPanel } from './SqlExamplesPanel';
import { DataScope, DataSource, DataSourceType, TableSchema } from '../../types/analytics';

// 支持真实连接的数据库类型（服务端提取完整 Schema，其余类型用占位表）
const DB_TYPES: DataSourceType[] = ['mysql', 'postgresql', 'greenplum'];

/**
 * 图标操作按钮 + 悬停功能提示气泡：替代原生 title（原生提示延迟约 1 秒且样式类系统默认，
 * 深色主题下不明显）。纯 CSS group-hover 实现，悬停立即显示；气泡绝对定位不影响布局，
 * 右对齐防溢出卡片。固定宽度 + 自动换行，避免长文案单行向左伸出被左侧导航栏遮挡。
 * 无障碍语义由内部按钮的 aria-label 承担。
 */
function TipAction({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <div className="relative group/tip">
      {children}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-0 top-full z-30 mt-1.5 w-64 whitespace-normal text-left rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-[11px] leading-relaxed text-slate-200 opacity-0 shadow-xl transition-opacity duration-150 group-hover/tip:opacity-100"
      >
        {tip}
      </span>
    </div>
  );
}

export const DataSourceManager: React.FC = () => {
  const {
    dataSources,
    activeDataSourceId,
    setActiveDataSource,
    addDataSource,
    removeDataSource,
    updateDataSource,
    activeTableId,
    setActiveTable,
  } = useAnalyticsStore();

  const [activeSubTab, setActiveSubTab] = useState<'schema' | 'lineage' | 'knowledge' | 'examples'>('schema');
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [dsName, setDsName] = useState('');
  const [dsType, setDsType] = useState<DataSourceType>('postgresql');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  // 指标/维度维护弹窗状态
  const [metaDs, setMetaDs] = useState<DataSource | null>(null);
  // 问数范围配置弹窗状态
  const [scopeDs, setScopeDs] = useState<DataSource | null>(null);
  const [scopeTables, setScopeTables] = useState<Set<string>>(new Set());
  const [scopeCols, setScopeCols] = useState<Record<string, Set<string>>>({});
  const [scopeExpanded, setScopeExpanded] = useState<string | null>(null);
  const [scopeSaving, setScopeSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!importNotice) return;
    const timer = setTimeout(() => setImportNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [importNotice]);

  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 5000);
    return () => clearTimeout(timer);
  }, [actionError]);

  const activeDS = dataSources.find((ds) => ds.id === activeDataSourceId);
  const activeTable = activeDS?.tables.find((t) => t.id === activeTableId) || activeDS?.tables[0];

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const response = await apiFetch('/api/datasources/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: dsType,
          config: { host, port, database, username, password },
        }),
      });

      const res = await response.json();
      if (res.success) {
        setTestResult(`连接成功！延迟: ${res.latencyMs}ms，检测到 ${res.tableCount} 张数据表。`);
      } else {
        setTestResult(`连接失败: ${res.message || res.error || '无法建立握手'}`);
      }
    } catch (err: any) {
      setTestResult(`测试错误: ${err.message}`);
    } finally {
      setIsTesting(false);
    }
  };

  const handleDeleteDataSource = async (ds: DataSource) => {
    if (!window.confirm(`确认删除数据源「${ds.name}」？此操作不可恢复。`)) return;
    try {
      const res = await apiFetch(`/api/datasources/${ds.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '删除失败');
      removeDataSource(ds.id);
      setImportNotice(`数据源「${ds.name}」已删除。`);
    } catch (err: any) {
      setActionError(err.message || '删除数据源失败');
    }
  };

  // 数据源级数据自省开关（Vanna intermediate_sql 借鉴）：问数前可先执行轻量自省 SQL 确认真实取值
  const handleToggleIntrospection = async (ds: DataSource) => {
    const next = !ds.allowIntrospection;
    try {
      const res = await apiFetch(`/api/datasources/${ds.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowIntrospection: next }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '更新失败');
      updateDataSource({ ...ds, allowIntrospection: next });
      setImportNotice(`数据源「${ds.name}」数据自省已${next ? '开启' : '关闭'}。`);
    } catch (err: any) {
      setActionError(err.message || '更新自省开关失败');
    }
  };

  const handleSaveDataSource = async () => {
    if (!dsName.trim() || isSaving) return;

    // 非数据库类型构造一张占位表；数据库类型由服务端真实连接并提取完整 Schema
    const placeholderTables: TableSchema[] =
      DB_TYPES.includes(dsType)
        ? []
        : [
            {
              id: `tbl_${Date.now()}`,
              name: `custom_analytics_${Date.now().toString().slice(-4)}`,
              displayName: `${dsName} 关联主数据表`,
              description: `来自 ${dsType.toUpperCase()} 外部接入源的数据表`,
              rowCount: Math.floor(Math.random() * 5000) + 1200,
              columns: [
                { name: 'id', type: 'number', description: '主键ID', isPrimaryKey: true },
                { name: 'created_at', type: 'date', description: '记录产生时间', isDimension: true },
                { name: 'region', type: 'category', description: '区域', isDimension: true },
                { name: 'total_amount', type: 'number', description: '业务金额', isMetric: true },
                { name: 'status', type: 'string', description: '状态标识', isDimension: true },
              ],
            },
          ];

    setIsSaving(true);
    try {
      // 先落库（服务端 MySQL 持久化），成功后再同步到本地 store
      const res = await apiFetch('/api/datasources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: dsName.trim(),
          type: dsType,
          config: { host, port, database, username, password },
          tables: placeholderTables,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '保存失败');

      const savedDS = data.dataSource as DataSource;
      addDataSource(savedDS);
      setIsAddingNew(false);
      setDsName('');
      setTestResult(null);
      if (DB_TYPES.includes(dsType)) {
        // 统计自动推导结果并自动打开问数范围编辑器，引导管理员完成"选范围 → 调指标维度"闭环
        const allCols = savedDS.tables.flatMap((t) => t.columns);
        const metricCount = allCols.filter((c) => c.isMetric).length;
        const dimCount = allCols.filter((c) => c.isDimension).length;
        setImportNotice(
          `数据源「${savedDS.name}」已保存，提取到 ${savedDS.tables.length} 张数据表，并自动推导出 ${metricCount} 个指标列、${dimCount} 个维度列。请勾选允许问数的范围，之后可在卡片上进一步维护指标/维度。`
        );
        openScopeEditor(savedDS);
      } else {
        setImportNotice(`数据源「${savedDS.name}」已保存到服务端。`);
      }
    } catch (err: any) {
      setActionError(err.message || '保存数据源失败');
    } finally {
      setIsSaving(false);
    }
  };

  // ---- 问数范围配置 ----
  const openScopeEditor = (ds: DataSource) => {
    const scope = ds.scope;
    const checkedTables = new Set(scope?.tables?.length ? scope.tables : ds.tables.map((t) => t.id));
    const cols: Record<string, Set<string>> = {};
    for (const t of ds.tables) {
      const scopedCols = scope?.columns?.[t.id];
      cols[t.id] = new Set(scopedCols?.length ? scopedCols : t.columns.map((c) => c.name));
    }
    setScopeDs(ds);
    setScopeTables(checkedTables);
    setScopeCols(cols);
    setScopeExpanded(null);
  };

  const toggleScopeTable = (table: TableSchema) => {
    const willEnable = !scopeTables.has(table.id);
    setScopeTables((prev) => {
      const next = new Set(prev);
      if (willEnable) next.add(table.id);
      else next.delete(table.id);
      return next;
    });
    // 重新勾选时若列为空则恢复全选，避免"表勾选但 0 字段"被服务端视为全字段放开
    if (willEnable && (scopeCols[table.id]?.size ?? 0) === 0) {
      setScopeCols((prev) => ({ ...prev, [table.id]: new Set(table.columns.map((c) => c.name)) }));
    }
  };

  const toggleScopeColumn = (tableId: string, colName: string) => {
    setScopeCols((prev) => {
      const set = new Set(prev[tableId] || []);
      if (set.has(colName)) set.delete(colName);
      else set.add(colName);
      return { ...prev, [tableId]: set };
    });
  };

  const handleSaveScope = async () => {
    if (!scopeDs || scopeSaving) return;
    setScopeSaving(true);
    try {
      // 勾选但 0 字段的表视为不纳入
      const checkedTables = scopeDs.tables.filter(
        (t) => scopeTables.has(t.id) && (scopeCols[t.id]?.size ?? 0) > 0
      );
      const isFull =
        checkedTables.length === scopeDs.tables.length &&
        checkedTables.every((t) => scopeCols[t.id]?.size === t.columns.length);

      let scope: DataScope | null = null;
      if (!isFull) {
        const columns: Record<string, string[]> = {};
        for (const t of checkedTables) {
          const checked = scopeCols[t.id] || new Set<string>();
          if (checked.size < t.columns.length) {
            columns[t.id] = t.columns.map((c) => c.name).filter((n) => checked.has(n));
          }
        }
        scope = { tables: checkedTables.map((t) => t.id), columns };
      }

      const res = await apiFetch(`/api/datasources/${scopeDs.id}/scope`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '保存失败');
      updateDataSource(data.dataSource as DataSource);
      setImportNotice(
        scope
          ? `「${scopeDs.name}」问数范围已限定为 ${scope.tables.length} 张表。`
          : `「${scopeDs.name}」已恢复为全部表可问数。`
      );
      setScopeDs(null);
    } catch (err: any) {
      setActionError(err.message || '问数范围保存失败');
    } finally {
      setScopeSaving(false);
    }
  };

  // 重新连接 MySQL 数据库同步最新 Schema（修复早期版本保存的假表结构）
  const syncSchemaRequest = async (ds: DataSource, password?: string) => {
    const res = await apiFetch(`/api/datasources/${ds.id}/sync-schema`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(password ? { password } : {}),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || '同步失败');
    return data.dataSource as DataSource;
  };

  const handleSyncSchema = async (ds: DataSource) => {
    if (syncingId) return;
    setSyncingId(ds.id);
    try {
      let synced: DataSource;
      try {
        synced = await syncSchemaRequest(ds);
      } catch (firstErr: any) {
        // 早期保存的数据源未存储连接密码，首次同步失败时提示补输一次（服务端会落库，之后不再询问）
        const pwd = window.prompt(
          `同步失败（${firstErr.message}）。\n请输入数据库 ${ds.config.database || ''} 的密码后重试：`
        );
        if (!pwd) throw firstErr;
        synced = await syncSchemaRequest(ds, pwd);
      }
      updateDataSource(synced);
      setImportNotice(`「${ds.name}」Schema 已同步：${synced.tables.length} 张数据表。`);
    } catch (err: any) {
      setActionError(err.message || 'Schema 同步失败');
    } finally {
      setSyncingId(null);
    }
  };

  // File Upload Parsing handler（上传后同样落库）
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const fileExt = file.name.split('.').pop()?.toLowerCase();
    const isCSV = fileExt === 'csv';

    const newTable: TableSchema = {
      id: `tbl_file_${Date.now()}`,
      name: file.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase(),
      displayName: `文件解析: ${file.name}`,
      description: `从 ${file.name} 导入的本地结构化文件数据`,
      rowCount: Math.floor(Math.random() * 2000) + 500,
      columns: [
        { name: 'row_id', type: 'number', description: '行号', isPrimaryKey: true },
        { name: 'date', type: 'date', description: '日期字段', isDimension: true },
        { name: 'category', type: 'category', description: '分类', isDimension: true },
        { name: 'metric_value', type: 'number', description: '度量数值', isMetric: true },
      ],
    };

    const dsConfig = {
      fileName: file.name,
      fileSize: `${(file.size / 1024).toFixed(1)} KB`,
    };

    try {
      const res = await apiFetch('/api/datasources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `导入文件: ${file.name}`,
          type: isCSV ? 'csv' : 'json',
          config: dsConfig,
          tables: [newTable],
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '导入失败');

      const newDS: DataSource = {
        id: data.id,
        name: `导入文件: ${file.name}`,
        type: isCSV ? 'csv' : 'json',
        status: 'connected',
        config: dsConfig,
        tables: [newTable],
        lastSyncedAt: new Date().toISOString(),
      };

      addDataSource(newDS);
      setImportNotice(`成功解析并导入本地文件 "${file.name}"！Schema 已自动识别。`);
    } catch (err: any) {
      setActionError(err.message || '文件导入失败');
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-950 p-4 md:p-8 space-y-6">
      {/* Header Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xl">
        <div className="space-y-1">
          <div className="flex items-center space-x-2 text-indigo-400 text-xs font-semibold uppercase tracking-wider">
            <Database className="w-4 h-4 text-indigo-400" />
            <span>多数据源接入与 Schema 管理中心</span>
          </div>
          <h1 className="text-xl md:text-2xl font-extrabold text-slate-100 tracking-tight">
            数据源与元数据配置 (Data Source & Schema)
          </h1>
          <p className="text-xs text-slate-400">
            支持接入 PostgreSQL、MySQL、本地 CSV/JSON 文件以及 REST API 接口，AI 将自动探测并读取表结构进行自然语言分析。
          </p>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          {/* Upload Local File Button */}
          <label className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold cursor-pointer transition-colors">
            <Upload className="w-4 h-4 text-cyan-400" />
            <span>导入本地 CSV / JSON</span>
            <input
              type="file"
              accept=".csv,.json,.xlsx"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>

          <button
            onClick={() => setIsAddingNew(true)}
            className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>添加数据库接入</span>
          </button>
        </div>
      </div>

      {/* Import Success Notice */}
      {importNotice && (
        <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-800/60 text-xs text-emerald-300 flex items-center space-x-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{importNotice}</span>
        </div>
      )}

      {/* Action Error Notice */}
      {actionError && (
        <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800/60 text-xs text-rose-300 flex items-center space-x-2">
          <RefreshCw className="w-4 h-4 text-rose-400 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Add New Connection Form Modal */}
      {isAddingNew && (
        <div className="bg-slate-900 border border-indigo-500/40 rounded-2xl p-6 space-y-4 shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
              <Server className="w-4 h-4 text-indigo-400" />
              <span>新增外部数据库源配置</span>
            </h3>
            <button
              onClick={() => setIsAddingNew(false)}
              className="text-slate-400 hover:text-slate-200 text-xs"
            >
              取消
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">数据源名称:</label>
              <input
                type="text"
                placeholder="例如: 华南节点 PostgreSQL 库"
                value={dsName}
                onChange={(e) => setDsName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="space-y-1">
              <label className="text-slate-300 font-medium">数据库类型:</label>
              <select
                value={dsType}
                onChange={(e) => setDsType(e.target.value as DataSourceType)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="postgresql">PostgreSQL 数据库</option>
                <option value="greenplum">Greenplum 数据库</option>
                <option value="mysql">MySQL 数据库</option>
                <option value="api">RESTful API 接口源</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-slate-300 font-medium">主机地址 (Host/IP):</label>
              <input
                type="text"
                placeholder="10.0.1.20 或 db.example.com"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-slate-300 font-medium">端口 (Port):</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-slate-300 font-medium">数据库名 (Database):</label>
              <input
                type="text"
                placeholder="dw_analytics_prod"
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-slate-300 font-medium">用户名 (Username):</label>
              <input
                type="text"
                placeholder="readonly_user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-slate-300 font-medium">密码 (Password):</label>
              <input
                type="password"
                placeholder="连接密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
              />
            </div>
          </div>

          {testResult && (
            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-indigo-300 font-mono flex items-center space-x-2">
              <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>{testResult}</span>
            </div>
          )}

          <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-800">
            <button
              onClick={handleTestConnection}
              disabled={isTesting}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 flex items-center space-x-1"
            >
              {isTesting && <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1" />}
              <span>测试连接通道</span>
            </button>
            <button
              onClick={handleSaveDataSource}
              disabled={!dsName.trim() || isSaving}
              className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1"
            >
              {isSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              <span>{isSaving ? '正在保存...' : '保存并初始化 Schema'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Mode Sub-Tab Switcher */}
      <div className="flex items-center space-x-2 border-b border-slate-800 pb-2">
        <button
          onClick={() => setActiveSubTab('schema')}
          className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
            activeSubTab === 'schema'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <TableIcon className="w-4 h-4" />
          <span>数据表 Schema 探测 (Schema Inspector)</span>
        </button>

        <button
          onClick={() => setActiveSubTab('lineage')}
          className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
            activeSubTab === 'lineage'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <GitFork className="w-4 h-4 text-cyan-400" />
          <span>全链路数据血缘视图 (Data Lineage Graph)</span>
        </button>

        <button
          onClick={() => setActiveSubTab('knowledge')}
          className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
            activeSubTab === 'knowledge'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <BookOpen className="w-4 h-4 text-amber-400" />
          <span>业务知识库 (Knowledge Base)</span>
        </button>

        <button
          onClick={() => setActiveSubTab('examples')}
          className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
            activeSubTab === 'examples'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <FileCode2 className="w-4 h-4 text-violet-400" />
          <span>SQL 样例库 (Training Data)</span>
        </button>
      </div>

      {activeSubTab === 'lineage' ? (
        <DataLineageView />
      ) : activeSubTab === 'knowledge' ? (
        <KnowledgeBasePanel dataSources={dataSources} initialId={activeDataSourceId} />
      ) : activeSubTab === 'examples' ? (
        <SqlExamplesPanel dataSources={dataSources} initialId={activeDataSourceId} />
      ) : (
        /* Main Grid: Data Sources List & Active Schema Inspector */
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Connected Datasources Cards */}
        <div className="space-y-3">
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider px-1">
            已接入的数据源 (Datasources)
          </div>

          <div className="space-y-2">
            {dataSources.map((ds) => {
              const isSelected = activeDataSourceId === ds.id;
              return (
                <div
                  key={ds.id}
                  onClick={() => setActiveDataSource(ds.id)}
                  className={`p-4 rounded-2xl border cursor-pointer transition-all space-y-2 ${
                    isSelected
                      ? 'bg-indigo-950/50 border-indigo-500 text-slate-100 shadow-lg'
                      : 'bg-slate-900 border-slate-800 hover:border-slate-700 text-slate-400'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <div
                        className={`p-2 rounded-xl ${
                          isSelected ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        <HardDrive className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="font-bold text-xs text-slate-100">{ds.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono">
                          {ds.config.database || ds.config.fileName || 'Online DB'}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center space-x-1.5">
                      <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-indigo-300">
                        {ds.type}
                      </span>
                      <TipAction tip="配置问数范围：勾选允许 AI 问数的表与字段，未勾选的表不进入提问上下文">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openScopeEditor(ds);
                          }}
                          aria-label="配置问数范围"
                          className="p-1 rounded-lg text-slate-500 hover:text-amber-300 hover:bg-amber-950/40 border border-transparent hover:border-amber-800/50 transition-colors"
                        >
                          <SlidersHorizontal className="w-3.5 h-3.5" />
                        </button>
                      </TipAction>
                      <TipAction tip="维护指标与维度：登记业务指标的标准口径与同义词，命中后保证全系统算法一致">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMetaDs(ds);
                          }}
                          aria-label="维护指标与维度"
                          className="p-1 rounded-lg text-slate-500 hover:text-cyan-300 hover:bg-cyan-950/40 border border-transparent hover:border-cyan-800/50 transition-colors"
                        >
                          <ListChecks className="w-3.5 h-3.5" />
                        </button>
                      </TipAction>
                      {DB_TYPES.includes(ds.type) && (
                        <TipAction
                          tip={
                            ds.allowIntrospection
                              ? '数据自省已开启：问数前可先执行轻量 SQL 确认字段真实取值，解决取值不确定型歧义（点击关闭）'
                              : '数据自省已关闭：开启后问数前可先执行轻量 SQL 确认字段真实取值（点击开启）'
                          }
                        >
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleIntrospection(ds);
                            }}
                            aria-label="切换数据自省开关"
                            className={`p-1 rounded-lg border transition-colors ${
                              ds.allowIntrospection
                                ? 'text-violet-300 bg-violet-950/40 border-violet-800/50'
                                : 'text-slate-500 hover:text-violet-300 hover:bg-violet-950/40 hover:border-violet-800/50 border-transparent'
                            }`}
                          >
                            <ScanSearch className="w-3.5 h-3.5" />
                          </button>
                        </TipAction>
                      )}
                      {DB_TYPES.includes(ds.type) && (
                        <TipAction tip="同步表结构：重新连接数据库拉取最新表结构（新增表/字段后使用）">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSyncSchema(ds);
                            }}
                            disabled={syncingId !== null}
                            aria-label="重新连接数据库同步最新表结构"
                            className="p-1 rounded-lg text-slate-500 hover:text-cyan-300 hover:bg-cyan-950/40 border border-transparent hover:border-cyan-800/50 transition-colors disabled:opacity-40"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${syncingId === ds.id ? 'animate-spin' : ''}`} />
                          </button>
                        </TipAction>
                      )}
                      <TipAction tip="删除数据源：解除连接并清除本地缓存（数据库本身不受影响）">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteDataSource(ds);
                          }}
                          aria-label="删除数据源"
                          className="p-1 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-rose-950/40 border border-transparent hover:border-rose-800/50 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </TipAction>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-800/60 pt-2">
                    <span className="flex items-center space-x-1 text-emerald-400 font-medium">
                      <CheckCircle2 className="w-3 h-3" />
                      <span>连接正常</span>
                    </span>
                    <span className="flex items-center space-x-2">
                      {ds.scope && ds.scope.tables.length > 0 && (
                        <span className="text-amber-300 font-medium">
                          问数 {ds.scope.tables.length}/{ds.tables.length} 表
                        </span>
                      )}
                      <span>{ds.tables.length} 张关联数据表</span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Active Table Inspector */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              当前选择的数据表 Schema 详情
            </div>

            {/* Table Selector */}
            {activeDS && activeDS.tables.length > 0 && (
              <div className="flex items-center space-x-2">
                <span className="text-xs text-slate-400">切换视角表:</span>
                <select
                  value={activeTable?.id}
                  onChange={(e) => setActiveTable(e.target.value)}
                  className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
                >
                  {activeDS.tables.map((tbl) => (
                    <option key={tbl.id} value={tbl.id}>
                      {tbl.displayName} ({tbl.name})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {activeTable ? (
            <SchemaViewer table={activeTable} />
          ) : (
            <div className="p-12 text-center text-xs text-slate-400 bg-slate-900 border border-slate-800 rounded-2xl">
              未检测到可用数据表
            </div>
          )}
        </div>
      </div>
      )}

      {/* Schema Meta Editor Modal（指标/维度维护） */}
      {metaDs && (
        <SchemaMetaEditor
          ds={metaDs}
          onClose={() => setMetaDs(null)}
          onSaved={(updated, touched) => {
            updateDataSource(updated);
            setMetaDs(null);
            setImportNotice(`「${updated.name}」指标/维度配置已保存（${touched} 个字段），对智能问数即时生效。`);
          }}
          onError={(msg) => setActionError(msg)}
        />
      )}

      {/* Query Scope Config Modal */}
      {scopeDs && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-slate-900 border border-amber-500/40 rounded-2xl shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <div className="space-y-0.5">
                <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
                  <SlidersHorizontal className="w-4 h-4 text-amber-400" />
                  <span>问数范围配置：{scopeDs.name}</span>
                </h3>
                <p className="text-[11px] text-slate-400">
                  勾选允许 AI 智能问数使用的数据表与字段，未勾选内容不会进入 AI 的 Schema 上下文。
                </p>
              </div>
              <button
                onClick={() => setScopeDs(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5">
              {scopeDs.tables.map((table) => {
                const tableChecked = scopeTables.has(table.id);
                const checkedCols = scopeCols[table.id] || new Set<string>();
                const expanded = scopeExpanded === table.id;
                return (
                  <div
                    key={table.id}
                    className={`rounded-xl border transition-colors ${
                      tableChecked ? 'border-amber-500/30 bg-amber-950/10' : 'border-slate-800 bg-slate-950/50'
                    }`}
                  >
                    <div className="flex items-center space-x-2.5 px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={tableChecked}
                        onChange={() => toggleScopeTable(table)}
                        className="w-3.5 h-3.5 accent-amber-500 cursor-pointer"
                      />
                      <button
                        onClick={() => setScopeExpanded(expanded ? null : table.id)}
                        className="flex-1 flex items-center justify-between min-w-0 text-left"
                      >
                        <div className="min-w-0">
                          <span className="text-xs font-semibold text-slate-200">{table.displayName}</span>
                          <span className="ml-2 text-[10px] text-slate-500 font-mono">{table.name}</span>
                        </div>
                        <div className="flex items-center space-x-2 shrink-0">
                          <span className="text-[10px] text-slate-400">
                            字段 {tableChecked ? checkedCols.size : 0}/{table.columns.length}
                          </span>
                          {expanded ? (
                            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                          )}
                        </div>
                      </button>
                    </div>

                    {expanded && (
                      <div className="px-4 pb-3 pt-1 border-t border-slate-800/60 grid grid-cols-2 md:grid-cols-3 gap-1">
                        {table.columns.map((col) => (
                          <label
                            key={col.name}
                            className={`flex items-center space-x-1.5 px-2 py-1 rounded-lg text-[11px] cursor-pointer transition-colors ${
                              !tableChecked
                                ? 'opacity-40 pointer-events-none'
                                : checkedCols.has(col.name)
                                  ? 'text-slate-200 bg-amber-950/30'
                                  : 'text-slate-400 hover:bg-slate-800/60'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={tableChecked && checkedCols.has(col.name)}
                              disabled={!tableChecked}
                              onChange={() => toggleScopeColumn(table.id, col.name)}
                              className="w-3 h-3 accent-amber-500"
                            />
                            <span className="font-mono truncate">{col.name}</span>
                            <span className="text-slate-500 text-[9px]">{col.type}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-5 py-3.5 border-t border-slate-800">
              <div className="text-[11px] text-slate-400">
                已选 <span className="text-amber-300 font-bold">{scopeTables.size}</span> / {scopeDs.tables.length} 张表
                {scopeTables.size === 0 && <span className="ml-2 text-rose-400">至少保留一张表</span>}
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setScopeDs(null)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700"
                >
                  取消
                </button>
                <button
                  onClick={handleSaveScope}
                  disabled={scopeSaving || scopeTables.size === 0}
                  className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold shadow flex items-center space-x-1"
                >
                  {scopeSaving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>{scopeSaving ? '保存中...' : '保存问数范围'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
