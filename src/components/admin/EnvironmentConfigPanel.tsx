import React, { useEffect, useState } from 'react';
import { Settings, AlertCircle } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAuthStore } from '../../hooks/useAuthStore';
import { UserRole } from '../../types/analytics';

interface EnvConfigItem {
  key: string;
  value: string;
  category: 'database' | 'ai_engine' | 'auth' | 'system';
  description?: string;
  is_sensitive: boolean;
  updated_at: string;
  /** v0.9.61 运行时对账：该键在运行时（process.env）是否已配置 */
  runtime_configured?: boolean;
  /** v0.9.61 运行时对账：非敏感键的运行时实际值（敏感键仅暴露已配置布尔） */
  runtime_value?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  database: '数据库配置',
  ai_engine: 'AI 引擎配置',
  auth: '认证授权',
  system: '系统参数'
};

const CATEGORY_COLORS: Record<string, string> = {
  database: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  ai_engine: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  auth: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  system: 'bg-slate-500/15 text-slate-300 border-slate-500/30'
};

/** 格式化更新时间；空值或非法日期显示 '-'（防 Invalid Date 泄漏到界面） */
const formatUpdatedAt = (value?: string): string => {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('zh-CN');
};

export const EnvironmentConfigPanel: React.FC = () => {
  const user = useAuthStore((s) => s.user);
  const [configs, setConfigs] = useState<EnvConfigItem[]>([]);
  /**
   * v0.9.61 编辑草稿：仅记录用户显式修改过的键（key → 新值）。
   * 提交时只报送变更项——未修改的敏感字段不再全量回传，杜绝脱敏串覆盖真实值。
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (user?.role !== 'ADMIN') return;
    loadConfigs();
  }, []);

  const loadConfigs = async () => {
    try {
      setLoading(true);
      const res = await apiFetch('/api/admin/env-config');
      const data = await res.json();
      if (data.success) {
        setConfigs(data.data || []);
        setDrafts({});
      } else {
        showNotice('error', data.error || '加载配置失败');
      }
    } catch (err: any) {
      showNotice('error', err.message || '网络错误');
    } finally {
      setLoading(false);
    }
  };

  const showNotice = (type: 'success' | 'error', text: string) => {
    setNotice({ type, text });
    setTimeout(() => setNotice(null), 4000);
  };

  /** 变更项：非敏感按「与当前值不同」判定，敏感字段留空=不修改（仅非空输入视为变更） */
  const changedEntries = (): Array<{ key: string; value: string }> =>
    Object.entries(drafts).filter(([key, val]) => {
      const item = configs.find((c) => c.key === key);
      if (!item) return false;
      if (item.is_sensitive) return val !== '';
      return val !== item.value;
    }).map(([key, value]) => ({ key, value }));

  const handleSave = async () => {
    const updates = changedEntries();
    if (updates.length === 0) {
      showNotice('error', '没有检测到修改（敏感字段留空表示不修改）');
      return;
    }
    try {
      setSaving(true);
      const res = await apiFetch('/api/admin/env-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '保存失败');

      const applied: string[] = Array.isArray(data.applied) ? data.applied : [];
      const delayed = updates.length - applied.length;
      showNotice(
        'success',
        delayed > 0
          ? `已保存 ${updates.length} 项 · 即时生效 ${applied.length} 项（其余将在重启后生效）`
          : `已保存 ${updates.length} 项，已即时生效`
      );
      loadConfigs();
    } catch (err: any) {
      showNotice('error', err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  // 非 ADMIN 用户直接返回空
  if (user?.role !== 'ADMIN') {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-center space-x-3">
        <Settings className="w-5 h-5 text-amber-400" />
        <div>
          <h3 className="font-bold text-slate-100 text-sm">环境配置管理</h3>
          <p className="text-xs text-slate-400 mt-0.5">保存后即时写入运行时（多数配置无需重启）· 面板值优先于 .env.local · 自动记录审计日志</p>
        </div>
      </div>

      {/* Notice */}
      {notice && (
        <div
          className={`p-3 rounded-xl border text-xs flex items-center space-x-2 ${
            notice.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
              : 'bg-rose-950/60 border-rose-800/60 text-rose-300'
          }`}
        >
          {notice.type === 'success' ? (
            <AlertCircle className="w-4 h-4 shrink-0" />
          ) : null}
          <span>{notice.text}</span>
        </div>
      )}

      {/* Config Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400">加载中...</div>
        ) : (
          <>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400 bg-slate-950/50">
                  <th className="px-4 py-3 font-medium w-[100px]">分类</th>
                  <th className="px-4 py-3 font-medium w-[160px] min-w-[160px]">变量名</th>
                  <th className="px-4 py-3 font-medium flex-1 min-w-[200px]">描述</th>
                  <th className="px-4 py-3 font-medium w-[280px] min-w-[280px]">当前值 / 运行时</th>
                  <th className="px-4 py-3 font-medium w-[160px] min-w-[160px]">更新时间</th>
                </tr>
              </thead>
              <tbody>
                {configs.map((config) => {
                  const draft = drafts[config.key];
                  // 敏感字段留空=不修改；非敏感字段草稿为空串表示清空（重启后回退 .env.local）
                  const inputValue = config.is_sensitive ? (draft ?? '') : (draft ?? config.value);
                  // 面板保存值非空且与运行时不一致（典型：MYSQL_* 连接配置）→ 提示重启生效
                  const mismatch =
                    !config.is_sensitive && config.value !== '' && (config.runtime_value || '') !== config.value;
                  return (
                    <tr
                      key={config.key}
                      className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <span
                          className={`px-3 py-1 rounded-full border text-xs font-semibold whitespace-nowrap ${
                            CATEGORY_COLORS[config.category] || CATEGORY_COLORS.system
                          }`}
                        >
                          {CATEGORY_LABELS[config.category] || config.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-200">{config.key}</td>
                      <td className="px-4 py-3 text-slate-400">{config.description || '-'}</td>
                      <td className="px-4 py-3">
                        <input
                          type={config.is_sensitive ? 'password' : 'text'}
                          value={inputValue}
                          onChange={(e) => setDrafts((prev) => ({ ...prev, [config.key]: e.target.value }))}
                          disabled={saving}
                          placeholder={
                            config.is_sensitive
                              ? config.runtime_configured
                                ? '已配置（输入新值以修改）'
                                : '未配置（输入以启用）'
                              : '请输入新值'
                          }
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-50 font-mono text-xs"
                        />
                        <div
                          className={`mt-1 text-[10px] font-mono break-all ${
                            mismatch ? 'text-amber-400' : 'text-slate-500'
                          }`}
                        >
                          {config.is_sensitive
                            ? `运行时：${config.runtime_configured ? '已配置' : '未配置'}`
                            : `运行时：${config.runtime_value || '未设置（跟随 .env.local / 默认值）'}`}
                          {mismatch ? ' ⚠ 重启后同步' : ''}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-400 font-mono text-xs">
                        {formatUpdatedAt(config.updated_at)}
                      </td>
                    </tr>
                  );
                })}
                {configs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                      暂无配置数据（服务启动时自动初始化）
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-end space-x-2 pt-2">
        <button
          onClick={loadConfigs}
          disabled={saving}
          className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 disabled:opacity-50"
        >
          刷新
        </button>
        <button
          onClick={handleSave}
          disabled={saving || loading || user?.role !== 'ADMIN'}
          className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold shadow-lg shadow-amber-600/30"
        >
          {saving ? '保存中...' : '保存配置'}
        </button>
      </div>

      {/* Tips */}
      <div className="bg-amber-950/30 border border-amber-800/40 rounded-xl p-3 text-[10px] text-amber-200/80 space-y-1">
        <p>⚠️ 生效说明：普通配置保存后即时生效（面板值优先于 .env.local，重启后保持）；数据库连接配置（MYSQL_*）需直接修改 .env.local 并重启，面板仅登记。</p>
        <p>🔒 敏感字段已配置时输入框留空即不修改；如需清空某项配置，请在 .env.local 中调整后重启。</p>
        <p>⏱ 修改 JWT_SECRET 会使所有登录态立即失效，且已加密的数据源凭据需重新录入，请谨慎操作。</p>
      </div>
    </div>
  );
};
