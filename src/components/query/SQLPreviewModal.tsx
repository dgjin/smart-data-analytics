/**
 * P0-3 三级数据溯源弹窗（对齐 FineBI NEXT 类产品的信任标准）：
 * L1 指标口径卡 —— 命中的语义指标口径（表达式/来源表/过滤/业务说明），并延伸指标治理（审批状态 + 版本历史查看，P0-4 使用侧延伸）；
 * L2 表关联图   —— 从 SQL 解析主表与 JOIN 链，可视化数据来源与连接条件（parseSqlLineage，含子查询扁平展开）；
 * L3 SQL 与原始数据 —— AI 思维链 + SQL 编辑器（AI 解释/优化，可重跑）+ 结果原始行预览。
 * 三级各自可折叠，默认全展开；数据来源徽标（live/simulated）贯穿头部。
 */
import React, { useState, useEffect, useMemo } from 'react';
import {
  Code2,
  Play,
  X,
  Check,
  Brain,
  Sparkles,
  Copy,
  BookOpen,
  Gauge,
  Loader2,
  ChevronDown,
  ChevronRight,
  Target,
  GitBranch,
  History,
  Table2,
  Database,
  Link2,
  ShieldCheck,
} from 'lucide-react';
import { QueryResultData } from '../../types/analytics';
import { apiFetch } from '../../api/client';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { parseSqlLineage } from '../../utils/sqlLineage';

interface SQLPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  queryResult: QueryResultData;
  onReRunSQL: (newSQL: string) => void;
}

/** 语义指标（与指标中心 /api/metrics 返回结构一致） */
interface MetricItem {
  id: number;
  name: string;
  aliases: string[];
  description: string;
  expr: string;
  tableName: string;
  filters: string;
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'DISABLED';
  version?: number;
  approvedBy?: string;
  approvedAt?: string | null;
  createdBy?: string;
}

interface VersionEntry {
  version: number;
  action: string;
  actor: string;
  createdAt: string;
}

type TraceLevel = 'l1' | 'l2' | 'l3';

const METRIC_STATUS_META: Record<string, { label: string; cls: string }> = {
  PENDING: { label: '待审批', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  ACTIVE: { label: '已生效', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  REJECTED: { label: '已驳回', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  DISABLED: { label: '已停用', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
};

const VERSION_ACTION_LABELS: Record<string, string> = {
  CREATE: '创建',
  APPROVE: '审批生效',
  UPDATE: '变更',
  RESTORE: '回溯',
};

const JOIN_TYPE_CLS: Record<string, string> = {
  MAIN: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
  INNER: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  LEFT: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  RIGHT: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  FULL: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  CROSS: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  NATURAL: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
};

/** 原始数据预览行数上限 */
const PREVIEW_ROW_LIMIT = 15;

function formatCell(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function formatDateTime(v?: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
}

/** 三级区块的可折叠标题（编号 + 图标 + 标题 + 副标题 + 右侧徽标） */
const LevelHeader: React.FC<{
  level: TraceLevel;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  accentCls: string;
  badge?: string;
  expanded: boolean;
  onToggle: () => void;
}> = ({ level, icon, title, subtitle, accentCls, badge, expanded, onToggle }) => (
  <button
    onClick={onToggle}
    className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800/80 hover:border-slate-700 transition-colors text-left"
    data-level={level}
  >
    <div className="flex items-center space-x-2.5 min-w-0">
      <span className={`shrink-0 w-5 h-5 rounded-md border flex items-center justify-center text-[10px] font-bold ${accentCls}`}>
        {level.replace('l', 'L')}
      </span>
      <span className="shrink-0 text-indigo-400">{icon}</span>
      <div className="min-w-0">
        <div className="font-bold text-slate-100 text-xs">{title}</div>
        <div className="text-[10px] text-slate-500 truncate">{subtitle}</div>
      </div>
    </div>
    <div className="flex items-center space-x-2 shrink-0">
      {badge && (
        <span className="px-2 py-0.5 rounded-full border text-[10px] font-semibold bg-slate-800/80 text-slate-300 border-slate-700">
          {badge}
        </span>
      )}
      {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
    </div>
  </button>
);

export const SQLPreviewModal: React.FC<SQLPreviewModalProps> = ({
  isOpen,
  onClose,
  queryResult,
  onReRunSQL,
}) => {
  const activeDataSourceId = useAnalyticsStore((s) => s.activeDataSourceId);
  const [sqlText, setSqlText] = useState(queryResult.generatedSQL || '');
  const [copied, setCopied] = useState(false);
  // SQL AI 助手（借鉴 Chat2DB：SQL 解释 / 优化建议）
  const [assistLoading, setAssistLoading] = useState<'explain' | 'optimize' | null>(null);
  const [assistResult, setAssistResult] = useState<{ type: 'explain' | 'optimize'; text: string } | null>(null);

  // 三级区块折叠状态（默认全展开）
  const [expanded, setExpanded] = useState<Record<TraceLevel, boolean>>({ l1: true, l2: true, l3: true });

  // L1 指标治理数据（审批状态 + 版本历史）
  const [metrics, setMetrics] = useState<MetricItem[]>([]);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [versionsFor, setVersionsFor] = useState<number | null>(null);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

  // 打开的上下文变化时重置 SQL 文本与版本面板
  useEffect(() => {
    if (!isOpen) {
      setVersionsFor(null);
      return;
    }
    setSqlText(queryResult.generatedSQL || '');
  }, [isOpen, queryResult]);

  // L1 数据：加载当前数据源的语义指标（命中匹配在下方 useMemo 中完成）
  useEffect(() => {
    if (!isOpen || !activeDataSourceId) {
      setMetrics([]);
      return;
    }
    let cancelled = false;
    setMetricsLoading(true);
    apiFetch(`/api/metrics?dataSourceId=${encodeURIComponent(activeDataSourceId)}`)
      .then(async (res) => (res.ok ? res.json().catch(() => ({})) : {}))
      .then((data) => {
        if (!cancelled) setMetrics(Array.isArray(data?.metrics) ? data.metrics : []);
      })
      .catch(() => {
        if (!cancelled) setMetrics([]);
      })
      .finally(() => {
        if (!cancelled) setMetricsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeDataSourceId]);

  const lineage = useMemo(() => parseSqlLineage(sqlText), [sqlText]);
  const columnLabels = queryResult.columnNames || {};

  // L1 指标命中：指标名/别名出现在 SQL 文本，或与结果列中文表头一致
  const matchedMetrics = useMemo(() => {
    if (!metrics.length) return [];
    const sqlUpper = sqlText.toUpperCase();
    const labels = new Set(Object.values(columnLabels));
    return metrics.filter((mt) => {
      const keys = [mt.name, ...(mt.aliases || [])].map((k) => String(k || '').trim()).filter(Boolean);
      return keys.some((k) => sqlUpper.includes(k.toUpperCase()) || labels.has(k));
    });
  }, [metrics, sqlText, columnLabels]);

  // L1 相关指标：SQL 引用表与指标登记表一致的未命中指标（使用侧口径提醒）
  const relatedMetrics = useMemo(() => {
    if (!metrics.length) return [];
    const tables = new Set(lineage.edges.map((e) => e.name.toLowerCase()));
    const matchedIds = new Set(matchedMetrics.map((mt) => mt.id));
    return metrics
      .filter((mt) => !matchedIds.has(mt.id) && mt.tableName && tables.has(mt.tableName.toLowerCase()))
      .slice(0, 6);
  }, [metrics, lineage, matchedMetrics]);

  if (!isOpen) return null;

  const toggleLevel = (level: TraceLevel) => setExpanded((prev) => ({ ...prev, [level]: !prev[level] }));

  const handleCopy = () => {
    navigator.clipboard.writeText(sqlText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSqlAssist = async (action: 'explain' | 'optimize') => {
    if (assistLoading) return;
    setAssistLoading(action);
    try {
      const resp = await apiFetch('/api/query/sql-assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, sql: sqlText }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || '请求失败');
      setAssistResult({ type: action, text: String(data.text || '') });
    } catch (err: any) {
      setAssistResult({ type: action, text: `AI 助手调用失败：${String(err?.message || err)}` });
    } finally {
      setAssistLoading(null);
    }
  };

  const toggleVersions = async (metricId: number) => {
    if (versionsFor === metricId) {
      setVersionsFor(null);
      return;
    }
    setVersionsFor(metricId);
    setVersions([]);
    setVersionsLoading(true);
    try {
      const res = await apiFetch(`/api/metrics/${metricId}/versions`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.versions)) setVersions(data.versions);
    } catch {
      // 版本历史加载失败仅展示空态
    } finally {
      setVersionsLoading(false);
    }
  };

  const isLive = queryResult.dataProvenance === 'live';
  const previewRows = (queryResult.rows || []).slice(0, PREVIEW_ROW_LIMIT);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl max-h-[88vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between bg-slate-950">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 rounded-lg bg-indigo-600/20 text-indigo-400">
              <Database className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-slate-100 text-sm">三级数据溯源 · 可信链路</h3>
              <p className="text-[11px] text-slate-400">
                指标口径 → 表关联 → SQL 与原始数据，逐层验证数据来源
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <span
              className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${
                isLive
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                  : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
              }`}
            >
              {isLive ? '真实数据执行' : '演示数据'}
            </span>
            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-slate-200 rounded-lg bg-slate-800"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto space-y-4 text-xs text-slate-300">
          {/* ======================= L1 指标口径卡 ======================= */}
          <section className="space-y-2">
            <LevelHeader
              level="l1"
              icon={<Target className="w-3.5 h-3.5" />}
              title="L1 指标口径卡"
              subtitle="命中的语义指标口径与治理状态（审批 / 版本）"
              accentCls="bg-indigo-600/20 text-indigo-300 border-indigo-500/40"
              badge={
                metricsLoading
                  ? '加载中…'
                  : matchedMetrics.length > 0
                  ? `${matchedMetrics.length} 项命中`
                  : '未命中登记指标'
              }
              expanded={expanded.l1}
              onToggle={() => toggleLevel('l1')}
            />
            {expanded.l1 && (
              <div className="space-y-2.5">
                {metricsLoading ? (
                  <div className="flex items-center space-x-2 p-3.5 rounded-xl bg-slate-950 border border-slate-800/80 text-slate-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>正在加载该数据源的指标口径与治理状态…</span>
                  </div>
                ) : matchedMetrics.length > 0 ? (
                  matchedMetrics.map((mt) => {
                    const statusMeta = METRIC_STATUS_META[mt.status] || METRIC_STATUS_META.DISABLED;
                    return (
                      <div key={mt.id} className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/80 space-y-2.5">
                        <div className="flex items-center justify-between flex-wrap gap-2">
                          <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                            <span className="font-bold text-slate-100 text-sm">{mt.name}</span>
                            <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${statusMeta.cls}`}>
                              {statusMeta.label}
                            </span>
                            {mt.version !== undefined && (
                              <span className="text-[10px] text-slate-500 font-mono">v{mt.version}</span>
                            )}
                          </div>
                          <button
                            onClick={() => toggleVersions(mt.id)}
                            className="flex items-center space-x-1 text-[10px] text-slate-400 hover:text-indigo-300 bg-slate-900 px-2 py-1 rounded border border-slate-700 transition-colors"
                          >
                            <History className="w-3 h-3" />
                            <span>{versionsFor === mt.id ? '收起版本' : '版本历史'}</span>
                          </button>
                        </div>
                        {mt.description && <p className="text-slate-400 leading-relaxed">{mt.description}</p>}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          <div className="p-2 rounded-lg bg-slate-900/80 border border-slate-800">
                            <div className="text-[10px] text-slate-500 mb-0.5">口径表达式</div>
                            <div className="font-mono text-indigo-300 break-all">{mt.expr || '—'}</div>
                          </div>
                          <div className="p-2 rounded-lg bg-slate-900/80 border border-slate-800">
                            <div className="text-[10px] text-slate-500 mb-0.5">来源表</div>
                            <div className="font-mono text-slate-300">{mt.tableName || '—'}</div>
                          </div>
                          <div className="p-2 rounded-lg bg-slate-900/80 border border-slate-800">
                            <div className="text-[10px] text-slate-500 mb-0.5">过滤口径</div>
                            <div className="font-mono text-slate-300 break-all">{mt.filters || '无'}</div>
                          </div>
                        </div>
                        {(mt.approvedBy || mt.createdBy) && (
                          <div className="flex items-center space-x-1.5 text-[10px] text-slate-500">
                            <ShieldCheck className="w-3 h-3" />
                            <span>
                              {mt.approvedBy ? `审批人 ${mt.approvedBy} · ${formatDateTime(mt.approvedAt)}` : `提议人 ${mt.createdBy}`}
                            </span>
                          </div>
                        )}

                        {/* 版本历史（P0-4 治理延伸到使用侧） */}
                        {versionsFor === mt.id && (
                          <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 space-y-1.5">
                            {versionsLoading ? (
                              <div className="flex items-center space-x-2 text-slate-400">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                <span>加载版本历史…</span>
                              </div>
                            ) : versions.length === 0 ? (
                              <div className="text-slate-500">暂无版本记录</div>
                            ) : (
                              versions.slice(0, 10).map((v) => (
                                <div key={`${v.version}-${v.action}-${v.createdAt}`} className="flex items-center space-x-2 text-[10px]">
                                  <span className="font-mono text-indigo-300 shrink-0">v{v.version}</span>
                                  <span className="px-1.5 py-0.5 rounded border border-slate-700 bg-slate-950 text-slate-300 shrink-0">
                                    {VERSION_ACTION_LABELS[v.action] || v.action}
                                  </span>
                                  <span className="text-slate-400 shrink-0">{v.actor}</span>
                                  <span className="text-slate-500 truncate">{formatDateTime(v.createdAt)}</span>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/80 space-y-2">
                    <p className="text-slate-400 leading-relaxed">
                      {activeDataSourceId
                        ? '本次查询未命中已登记语义指标（指标名/别名未出现在 SQL 或结果表头中），以下为结果列口径：'
                        : '当前未关联真实数据源，以下为结果列口径：'}
                    </p>
                    {(queryResult.columns || []).length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {(queryResult.columns || []).map((col) => (
                          <span
                            key={col}
                            className="px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-[10px]"
                          >
                            <span className="font-mono text-indigo-300">{col}</span>
                            {columnLabels[col] && <span className="text-slate-400"> · {columnLabels[col]}</span>}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-slate-500">无结果列信息</div>
                    )}
                  </div>
                )}

                {/* 同表相关指标提醒 */}
                {relatedMetrics.length > 0 && (
                  <div className="flex items-center flex-wrap gap-1.5 text-[10px] text-slate-500">
                    <span className="flex items-center space-x-1 shrink-0">
                      <Link2 className="w-3 h-3" />
                      <span>同表相关指标：</span>
                    </span>
                    {relatedMetrics.map((mt) => {
                      const statusMeta = METRIC_STATUS_META[mt.status] || METRIC_STATUS_META.DISABLED;
                      return (
                        <span key={mt.id} className="px-1.5 py-0.5 rounded border border-slate-800 bg-slate-950 text-slate-400">
                          {mt.name}
                          <span className={`ml-1 ${mt.status === 'ACTIVE' ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {statusMeta.label}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ======================= L2 表关联图 ======================= */}
          <section className="space-y-2">
            <LevelHeader
              level="l2"
              icon={<GitBranch className="w-3.5 h-3.5" />}
              title="L2 表关联图"
              subtitle="从 SQL 解析的数据来源与连接关系"
              accentCls="bg-cyan-600/20 text-cyan-300 border-cyan-500/40"
              badge={lineage.edges.length > 0 ? `${lineage.edges.length} 张表` : '未解析到表'}
              expanded={expanded.l2}
              onToggle={() => toggleLevel('l2')}
            />
            {expanded.l2 && (
              <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/80">
                {lineage.edges.length === 0 ? (
                  <div className="text-slate-500">未能从 SQL 中解析出引用表（请确认 SQL 中包含 FROM 子句）</div>
                ) : (
                  <div>
                    {lineage.edges.map((edge, idx) => (
                      <div key={`${edge.name}-${idx}`}>
                        {idx > 0 && (
                          <div className="flex items-stretch">
                            <div className="w-px bg-slate-700 ml-[26px]" />
                            <div className="flex items-center space-x-1.5 pl-4 py-1.5 text-[10px] min-w-0">
                              <span
                                className={`px-1.5 py-0.5 rounded border font-semibold shrink-0 ${
                                  JOIN_TYPE_CLS[edge.joinType] || JOIN_TYPE_CLS.NATURAL
                                }`}
                              >
                                {edge.joinType === 'INNER' ? 'JOIN' : `${edge.joinType} JOIN`}
                              </span>
                              {edge.onCondition ? (
                                <span className="text-slate-500 font-mono truncate">
                                  {edge.onCondition.startsWith('USING') ? edge.onCondition : `ON ${edge.onCondition}`}
                                </span>
                              ) : (
                                <span className="text-slate-600">无连接条件（笛卡尔积）</span>
                              )}
                            </div>
                          </div>
                        )}
                        <div className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 w-fit max-w-full">
                          <Table2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                          <span className="font-mono font-semibold text-slate-200 truncate">{edge.name}</span>
                          {edge.alias && <span className="text-[10px] text-slate-500 shrink-0">别名 {edge.alias}</span>}
                          {idx === 0 && (
                            <span className="px-1.5 py-0.5 rounded border text-[10px] font-semibold bg-indigo-500/15 text-indigo-300 border-indigo-500/30 shrink-0">
                              主表
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                    {lineage.hasSubquery && (
                      <p className="mt-2 text-[10px] text-slate-500">SQL 含子查询，内部表已扁平展开为上述清单</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ======================= L3 SQL 与原始数据 ======================= */}
          <section className="space-y-2">
            <LevelHeader
              level="l3"
              icon={<Code2 className="w-3.5 h-3.5" />}
              title="L3 SQL 与原始数据"
              subtitle="NL2SQL 推理链、SQL 编辑器与结果原始行预览"
              accentCls="bg-emerald-600/20 text-emerald-300 border-emerald-500/40"
              badge={`${queryResult.totalCount ?? (queryResult.rows || []).length} 行结果`}
              expanded={expanded.l3}
              onToggle={() => toggleLevel('l3')}
            />
            {expanded.l3 && (
              <div className="space-y-3">
                {/* AI Thought Chain Steps */}
                {queryResult.thoughtProcess && queryResult.thoughtProcess.length > 0 && (
                  <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/80 space-y-2">
                    <div className="flex items-center space-x-1.5 font-semibold text-indigo-300 text-xs">
                      <Brain className="w-4 h-4 text-indigo-400" />
                      <span>AI 自然语言解析与意图推导链 (Thought Process):</span>
                    </div>
                    <ul className="space-y-1.5 pl-5 list-disc text-slate-300 font-sans">
                      {queryResult.thoughtProcess.map((step, idx) => (
                        <li key={idx} className="leading-relaxed">
                          {step}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* SQL Editor */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="font-semibold text-slate-200 flex items-center space-x-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                      <span>生成的 SQL 查询语句 (可手动修改调试):</span>
                    </label>
                    <div className="flex items-center space-x-1.5">
                      <button
                        onClick={() => handleSqlAssist('explain')}
                        disabled={assistLoading !== null}
                        className="flex items-center space-x-1 text-[11px] text-cyan-300 hover:text-cyan-200 bg-cyan-950/50 px-2 py-1 rounded border border-cyan-500/30 disabled:opacity-50 transition-colors"
                        title="用自然语言解释这条 SQL 的业务含义"
                      >
                        {assistLoading === 'explain' ? <Loader2 className="w-3 h-3 animate-spin" /> : <BookOpen className="w-3 h-3" />}
                        <span>AI 解释</span>
                      </button>
                      <button
                        onClick={() => handleSqlAssist('optimize')}
                        disabled={assistLoading !== null}
                        className="flex items-center space-x-1 text-[11px] text-emerald-300 hover:text-emerald-200 bg-emerald-950/50 px-2 py-1 rounded border border-emerald-500/30 disabled:opacity-50 transition-colors"
                        title="给出索引与写法层面的优化建议"
                      >
                        {assistLoading === 'optimize' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Gauge className="w-3 h-3" />}
                        <span>优化建议</span>
                      </button>
                      <button
                        onClick={handleCopy}
                        className="flex items-center space-x-1 text-[11px] text-slate-400 hover:text-slate-200 bg-slate-800 px-2 py-1 rounded border border-slate-700"
                      >
                        {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        <span>{copied ? '已复制' : '复制 SQL'}</span>
                      </button>
                    </div>
                  </div>

                  <textarea
                    value={sqlText}
                    onChange={(e) => setSqlText(e.target.value)}
                    rows={6}
                    className="w-full p-3 bg-slate-950 border border-slate-700 rounded-xl font-mono text-xs text-indigo-300 focus:outline-none focus:border-indigo-500 leading-relaxed"
                  />

                  {/* SQL AI 助手输出（解释 / 优化建议） */}
                  {assistResult && (
                    <div
                      className={`p-3.5 rounded-xl border space-y-1.5 ${
                        assistResult.type === 'explain'
                          ? 'bg-cyan-950/30 border-cyan-500/30'
                          : 'bg-emerald-950/30 border-emerald-500/30'
                      }`}
                    >
                      <div
                        className={`flex items-center space-x-1.5 font-semibold text-xs ${
                          assistResult.type === 'explain' ? 'text-cyan-300' : 'text-emerald-300'
                        }`}
                      >
                        {assistResult.type === 'explain' ? <BookOpen className="w-3.5 h-3.5" /> : <Gauge className="w-3.5 h-3.5" />}
                        <span>{assistResult.type === 'explain' ? 'SQL 业务解读' : 'SQL 优化建议'}</span>
                      </div>
                      <p className="text-slate-300 leading-relaxed whitespace-pre-wrap">{assistResult.text}</p>
                    </div>
                  )}
                </div>

                {/* 原始数据行预览 */}
                <div className="space-y-2">
                  <label className="font-semibold text-slate-200 flex items-center space-x-1.5">
                    <Table2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span>结果原始数据（前 {PREVIEW_ROW_LIMIT} 行预览）:</span>
                  </label>
                  {previewRows.length > 0 ? (
                    <>
                      <div className="overflow-x-auto overflow-y-auto max-h-72 rounded-xl border border-slate-800">
                        <table className="w-full text-[11px] font-mono">
                          <thead className="sticky top-0 bg-slate-950 z-10">
                            <tr>
                              {(queryResult.columns || []).map((col) => (
                                <th
                                  key={col}
                                  className="px-3 py-2 text-left text-slate-400 border-b border-slate-800 whitespace-nowrap font-semibold"
                                >
                                  {columnLabels[col] || col}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {previewRows.map((row, rowIdx) => (
                              <tr key={rowIdx} className="hover:bg-slate-900/60 transition-colors">
                                {(queryResult.columns || []).map((col) => (
                                  <td
                                    key={col}
                                    className="px-3 py-1.5 text-slate-300 border-b border-slate-800/50 whitespace-nowrap"
                                  >
                                    {formatCell(row[col])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[10px] text-slate-500">
                        共 {queryResult.totalCount ?? previewRows.length} 行，此处预览前 {previewRows.length} 行；完整数据请使用报告/导出功能获取
                      </p>
                    </>
                  ) : (
                    <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800/80 text-slate-500">
                      无原始数据行（演示模式或查询尚未执行）
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Modal Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-slate-950 flex items-center justify-between">
          <span className="text-[11px] text-slate-500">
            执行时间: {queryResult.executionTimeMs} ms • 状态: 语法已通过校验
          </span>
          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium"
            >
              关闭
            </button>
            <button
              onClick={() => {
                onReRunSQL(sqlText);
                onClose();
              }}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium shadow"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>重新运行 SQL</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
