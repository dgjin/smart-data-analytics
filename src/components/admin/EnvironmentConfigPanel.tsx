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

export const EnvironmentConfigPanel: React.FC = () => {
  const user = useAuthStore((s) => s.user);
  const [configs, setConfigs] = useState<EnvConfigItem[]>([]);
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

  const handleSave = async () => {
    try {
      setSaving(true);
      const updates = configs.map(c => ({ key: c.key, value: c.value }));
      
      const res = await apiFetch('/api/admin/env-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '保存失败');
      
      showNotice('success', `已保存 ${updates.length} 个配置项`);
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
          <p className="text-xs text-slate-400 mt-0.5">修改后即时生效 · 无需重启服务 · 自动记录审计日志</p>
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
                  <th className="px-4 py-3 font-medium w-[280px] min-w-[280px]">当前值</th>
                  <th className="px-4 py-3 font-medium w-[160px] min-w-[160px]">更新时间</th>
                </tr>
              </thead>
              <tbody>
                {configs.map((config, idx) => (
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
                        value={config.value}
                        onChange={(e) => {
                          const next = [...configs];
                          next[idx].value = e.target.value;
                          setConfigs(next);
                        }}
                        disabled={saving}
                        placeholder="请输入新值"
                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-amber-500 disabled:opacity-50 font-mono text-xs"
                      />
                    </td>
                    <td className="px-4 py-3 text-slate-400 font-mono text-xs">
                      {new Date(config.updated_at).toLocaleString('zh-CN')}
                    </td>
                  </tr>
                ))}
                {configs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                      暂无配置数据（请先初始化数据库表）
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
      <div className="bg-amber-950/30 border border-amber-800/40 rounded-xl p-3 text-[10px] text-amber-200/80">
        ⚠️ 注意：敏感字段（如 MySQL_PASSWORD、JWT_SECRET）显示为 ***hidden***，修改时请重新输入明文
      </div>
    </div>
  );
};
