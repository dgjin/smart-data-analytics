/**
 * v0.9.107 评价中心面板（管理端，v0.9.109 简化为纯星级）：
 * - 6 张概览卡：问数均分/评价数/好评率 + 全站均分/评价数/NPS；
 * - 近 30 天趋势（双线：问数均分 / 全站均分）；
 * - 低分待关注（近 7 天 ≤2 星，最多 10 条，顶部红色计数徽标）；
 * - 明细分页（来源/评分/时间范围筛选）+ CSV 导出（UTF-8 BOM，服务端写审计）。
 * 数据来自 /api/admin/ratings/*（仅 ADMIN）；问数评价与 query_feedback 独立，口径互不影响。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, Download, MessageSquareWarning, RefreshCw, Star } from 'lucide-react';
import { apiFetch } from '../../../api/client';
import { getErrorMessage } from '../../../utils/errorUtils';
import { RATING_LABELS, RatingSource } from '../../../types/accessFeedback';

interface OverviewResponse {
  query: { count: number; avg: number; goodRate: number; lowCount: number };
  app: { count: number; avg: number; nps: number; lowCount: number };
  trend: Array<{ date: string; queryAvg: number | null; queryCount: number; appAvg: number | null; appCount: number }>;
}

interface RatingItem {
  id: number;
  source: 'query' | 'app';
  username: string;
  rating: number;
  question: string;
  createdAt: string;
}

interface ItemsResponse {
  items: RatingItem[];
  total: number;
  page: number;
  pageSize: number;
}

const RANGE_OPTIONS = [7, 30, 90] as const;
const PAGE_SIZE = 10;

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

const StarBadge: React.FC<{ value: number }> = ({ value }) => (
  <span className={`inline-flex items-center space-x-0.5 ${value <= 2 ? 'text-rose-400' : 'text-amber-400'}`}>
    <Star className="w-3 h-3 fill-current" />
    <span className="text-[11px] font-semibold tabular-nums">{value}</span>
  </span>
);

export const RatingCenterPanel: React.FC = () => {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [overviewError, setOverviewError] = useState('');

  const [lowItems, setLowItems] = useState<RatingItem[]>([]);
  const [items, setItems] = useState<ItemsResponse | null>(null);
  const [itemsError, setItemsError] = useState('');
  const [loadingItems, setLoadingItems] = useState(true);

  const [source, setSource] = useState<RatingSource>('all');
  const [ratingFilter, setRatingFilter] = useState<number | 'all'>('all');
  const [days, setDays] = useState<(typeof RANGE_OPTIONS)[number]>(30);
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  const loadOverview = useCallback(async () => {
    setOverviewError('');
    try {
      const resp = await apiFetch('/api/admin/ratings/overview?days=30');
      const body = (await resp.json().catch(() => null)) as (OverviewResponse & { error?: string }) | null;
      if (!resp.ok || !body) throw new Error(body?.error || `概览获取失败（HTTP ${resp.status}）`);
      setOverview(body);
    } catch (err) {
      setOverviewError(getErrorMessage(err) || '评价概览获取失败');
    }
  }, []);

  // 低分待关注：近 7 天 ≤2 星（独立于明细筛选）
  const loadLowItems = useCallback(async () => {
    try {
      const resp = await apiFetch('/api/admin/ratings/items?maxRating=2&days=7&page=1&pageSize=10');
      const body = (await resp.json().catch(() => null)) as (ItemsResponse & { error?: string }) | null;
      if (!resp.ok || !body) return;
      setLowItems(body.items || []);
    } catch {
      /* 低分列表失败不影响主看板 */
    }
  }, []);

  const loadItems = useCallback(async () => {
    setLoadingItems(true);
    setItemsError('');
    try {
      const params = new URLSearchParams({
        source,
        days: String(days),
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (ratingFilter !== 'all') {
        params.set('minRating', String(ratingFilter));
        params.set('maxRating', String(ratingFilter));
      }
      const resp = await apiFetch(`/api/admin/ratings/items?${params.toString()}`);
      const body = (await resp.json().catch(() => null)) as (ItemsResponse & { error?: string }) | null;
      if (!resp.ok || !body) throw new Error(body?.error || `明细获取失败（HTTP ${resp.status}）`);
      setItems(body);
    } catch (err) {
      setItemsError(getErrorMessage(err) || '评价明细获取失败');
    } finally {
      setLoadingItems(false);
    }
  }, [source, days, page, ratingFilter]);

  useEffect(() => {
    void loadOverview();
    void loadLowItems();
  }, [loadOverview, loadLowItems]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  const trendData = useMemo(
    () =>
      (overview?.trend || []).map((point) => ({
        label: point.date.slice(5),
        问数均分: point.queryAvg,
        全站均分: point.appAvg,
      })),
    [overview]
  );

  const totalPages = items ? Math.max(1, Math.ceil(items.total / items.pageSize)) : 1;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ source, days: String(days) });
      const resp = await apiFetch(`/api/admin/ratings/export?${params.toString()}`);
      if (!resp.ok) throw new Error(`导出失败（HTTP ${resp.status}）`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ratings-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setItemsError(getErrorMessage(err) || '导出失败，请稍后重试');
    } finally {
      setExporting(false);
    }
  };

  const cards = [
    { label: '问数均分', value: (overview?.query.avg ?? 0).toFixed(2), hint: '近 30 天 1-5 星均值' },
    { label: '问数评价数', value: String(overview?.query.count ?? 0), hint: '近 30 天星级评价条数' },
    { label: '问数好评率', value: pct(overview?.query.goodRate ?? 0), hint: '4 星及以上占比' },
    { label: '全站均分', value: (overview?.app.avg ?? 0).toFixed(2), hint: '近 30 天满意度均值' },
    { label: '全站评价数', value: String(overview?.app.count ?? 0), hint: '近 30 天满意度条数' },
    { label: 'NPS', value: String(overview?.app.nps ?? 0), hint: '(5 星 − 1-3 星) / 总数 × 100' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-bold text-slate-100 flex items-center space-x-2">
            <Star className="w-4 h-4 text-amber-400" />
            <span>评价中心</span>
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            问数星级评价与全站满意度独立于赞/踩纠错（不参与 few-shot 与统一记忆体），口径互不影响
          </p>
        </div>
        <button
          onClick={() => {
            void loadOverview();
            void loadLowItems();
            void loadItems();
          }}
          className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>刷新</span>
        </button>
      </div>

      {overviewError && (
        <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-500/40 text-[11px] text-rose-300">{overviewError}</div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((card) => (
          <div key={card.label} className="p-3.5 rounded-xl bg-slate-900 border border-slate-800">
            <div className="text-[11px] text-slate-400">{card.label}</div>
            <div className="mt-1 text-xl font-bold text-slate-100 tabular-nums">{card.value}</div>
            <p className="mt-1 text-[10px] text-slate-500">{card.hint}</p>
          </div>
        ))}
      </div>

      <div>
        {/* 趋势 */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
          <div className="text-xs font-semibold text-slate-200 mb-2">近 30 天评分趋势</div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData} margin={{ top: 8, right: 16, bottom: 0, left: -20 }}>
                <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 10 }} stroke="#334155" />
                <YAxis domain={[0, 5]} tick={{ fill: '#94a3b8', fontSize: 10 }} stroke="#334155" />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 11 }}
                  labelStyle={{ color: '#cbd5e1' }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="问数均分" stroke="#38bdf8" strokeWidth={2} dot={false} connectNulls />
                <Line type="monotone" dataKey="全站均分" stroke="#fbbf24" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* 低分待关注 */}
      <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-slate-200 flex items-center space-x-1.5">
            <MessageSquareWarning className="w-4 h-4 text-rose-400" />
            <span>低分待关注（近 7 天 ≤2 星）</span>
            {lowItems.length > 0 && (
              <span className="px-1.5 py-px rounded-full bg-rose-500/20 border border-rose-500/40 text-rose-300 text-[10px] font-bold">
                {lowItems.length}
              </span>
            )}
          </span>
          <span className="text-[10px] text-slate-500">最多展示 10 条，仅提示不自动创建运维事件</span>
        </div>
        {lowItems.length === 0 ? (
          <p className="py-5 text-center text-[11px] text-slate-500">近 7 天暂无低分评价</p>
        ) : (
          <div className="space-y-2">
            {lowItems.map((item) => (
              <div key={`low-${item.source}-${item.id}`} className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="flex items-center space-x-2">
                    <span className={`px-1.5 py-px rounded border text-[10px] ${item.source === 'query' ? 'text-sky-300 border-sky-500/40 bg-sky-500/10' : 'text-amber-300 border-amber-500/40 bg-amber-500/10'}`}>
                      {item.source === 'query' ? '问数评价' : '全站满意度'}
                    </span>
                    <span>{item.username || '匿名'}</span>
                    <StarBadge value={item.rating} />
                  </span>
                  <span className="text-[10px] text-slate-500">{item.createdAt}</span>
                </div>
                {item.question && <p className="mt-1 text-[11px] text-slate-300 truncate">问题：{item.question}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 明细 */}
      <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <span className="text-xs font-semibold text-slate-200">评价明细</span>
          <div className="flex items-center flex-wrap gap-2">
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value as RatingSource);
                setPage(1);
              }}
              className="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-300"
            >
              <option value="all">全部来源</option>
              <option value="query">问数评价</option>
              <option value="app">全站满意度</option>
            </select>
            <select
              value={String(ratingFilter)}
              onChange={(e) => {
                const value = e.target.value;
                setRatingFilter(value === 'all' ? 'all' : Number(value));
                setPage(1);
              }}
              className="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-300"
            >
              <option value="all">全部评分</option>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n} 星 · {RATING_LABELS[n]}
                </option>
              ))}
            </select>
            <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5">
              {RANGE_OPTIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => {
                    setDays(d);
                    setPage(1);
                  }}
                  className={`px-2 py-0.5 rounded-md text-[10px] font-medium transition-colors ${
                    days === d ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {d} 天
                </button>
              ))}
            </div>
            <button
              onClick={() => void exportCsv()}
              disabled={exporting}
              className="flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-slate-950 hover:bg-slate-800 text-cyan-300 border border-slate-800 disabled:opacity-50 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{exporting ? '导出中…' : '导出 CSV'}</span>
            </button>
          </div>
        </div>

        {itemsError && (
          <div className="mb-2 p-2 rounded-lg bg-rose-950/40 border border-rose-500/40 text-[11px] text-rose-300">{itemsError}</div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-slate-400 border-b border-slate-800">
                <th className="text-left py-2 pr-3 font-medium">来源</th>
                <th className="text-left py-2 pr-3 font-medium">用户</th>
                <th className="text-left py-2 pr-3 font-medium">评分</th>
                <th className="text-left py-2 pr-3 font-medium">关联问题</th>
                <th className="text-left py-2 font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              {(items?.items || []).map((item) => (
                <tr key={`${item.source}-${item.id}`} className="border-b border-slate-800/60 text-slate-300">
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <span className={`px-1.5 py-px rounded border text-[10px] ${item.source === 'query' ? 'text-sky-300 border-sky-500/40 bg-sky-500/10' : 'text-amber-300 border-amber-500/40 bg-amber-500/10'}`}>
                      {item.source === 'query' ? '问数评价' : '全站满意度'}
                    </span>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{item.username || '匿名'}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <StarBadge value={item.rating} />
                  </td>
                  <td className="py-2 pr-3 max-w-[14rem]">
                    <span className="line-clamp-2">{item.question || '—'}</span>
                  </td>
                  <td className="py-2 whitespace-nowrap text-slate-500">{item.createdAt}</td>
                </tr>
              ))}
              {!loadingItems && (items?.items.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-slate-500">
                    当前筛选条件下暂无评价
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between mt-3 text-[11px] text-slate-400">
          <span>
            共 {items?.total ?? 0} 条 · 第 {items?.page ?? 1}/{totalPages} 页
          </span>
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loadingItems}
              className="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 disabled:opacity-40 hover:bg-slate-800 transition-colors"
            >
              上一页
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loadingItems}
              className="px-2 py-1 rounded-lg bg-slate-950 border border-slate-800 disabled:opacity-40 hover:bg-slate-800 transition-colors"
            >
              下一页
            </button>
          </div>
        </div>
      </div>

      <p className="text-[10px] text-slate-500 leading-relaxed flex items-start space-x-1">
        <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
        <span>
          低分评价仅在看板提示，不自动创建运维事件；导出 CSV 由服务端写审计（含 UTF-8 BOM，Excel 直接打开不乱码）。
        </span>
      </p>
    </div>
  );
};
