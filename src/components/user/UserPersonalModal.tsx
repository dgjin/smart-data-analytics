/**
 * v0.9.104 用户信息维护弹窗（REQ-16 个性化维护 / REQ-18 入口可见性）：昵称 / 头像 / 个人签名 + 偏好设置。
 * 打开时经 GET /api/user/personal 预填表单（未维护过时回退缺省值），保存经 PUT /api/user/personal 落库；
 * 提交前使用共用 normalizeUserPersonalInfo（flexQueryShared）做白名单校验，与服务端校验同一份逻辑。
 */
import React, { useEffect, useState } from 'react';
import { ImagePlus, UserCog, X } from 'lucide-react';
import { apiFetch } from '../../api/client';
import { useAnalyticsStore } from '../../hooks/useAnalyticsStore';
import { AMOUNT_UNITS } from '../../hooks/useAmountUnitStore';
import { applyUITheme } from '../../utils/uiTheme';
import { getErrorMessage } from '../../utils/errorUtils';
import {
  DEFAULT_USER_PERSONAL_INFO,
  USER_PERSONAL_FIELD_LIMITS,
  normalizeUserPersonalInfo,
  type ThemePreference,
  type UserAmountUnitPreference,
  type UserPersonalInfo,
} from '../flexquery/flexQueryShared';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

/** 缺省值副本（避免各状态共享同一可变对象） */
function emptyPersonalInfo(): UserPersonalInfo {
  return { ...DEFAULT_USER_PERSONAL_INFO, preferences: { ...DEFAULT_USER_PERSONAL_INFO.preferences } };
}

export const UserPersonalModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const dataSources = useAnalyticsStore((s) => s.dataSources);

  const [form, setForm] = useState<UserPersonalInfo>(emptyPersonalInfo);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 读取失败时仍以缺省值展示表单，仅提示（不阻塞维护）
  const [loadWarn, setLoadWarn] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/user/personal');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '个性化信息读取失败');
        if (cancelled) return;
        setForm({
          ...emptyPersonalInfo(),
          ...data,
          preferences: { ...DEFAULT_USER_PERSONAL_INFO.preferences, ...(data.preferences || {}) },
        });
      } catch (err) {
        if (!cancelled) setLoadWarn(getErrorMessage(err) || '个性化信息读取失败，将以缺省值展示');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patchPreferences = (patch: Partial<UserPersonalInfo['preferences']>) =>
    setForm((prev) => ({ ...prev, preferences: { ...prev.preferences, ...patch } }));

  const onAvatarFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setNotice({ type: 'error', text: '头像仅支持图片文件' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (dataUrl.length > USER_PERSONAL_FIELD_LIMITS.avatar) {
        setNotice({ type: 'error', text: `头像数据过大（不超过 ${USER_PERSONAL_FIELD_LIMITS.avatar} 字节）` });
        return;
      }
      setForm((prev) => ({ ...prev, avatar: dataUrl }));
      setNotice(null);
    };
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (saving) return;
    const parsed = normalizeUserPersonalInfo(form);
    // 注：必须显式 `=== false`——默认 tsconfig 未开 strict，`!parsed.ok` 不会窄化联合类型
    if (parsed.ok === false) {
      setNotice({ type: 'error', text: parsed.error });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const res = await apiFetch('/api/user/personal', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.value),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '个性化信息保存失败');
      const saved: UserPersonalInfo = {
        ...parsed.value,
        ...data,
        preferences: { ...parsed.value.preferences, ...(data.preferences || {}) },
      };
      setForm(saved);
      // 主题偏好即时生效；system 交由系统深浅色逻辑跟随，不在此覆盖
      if (saved.preferences.theme === 'light' || saved.preferences.theme === 'dark') {
        applyUITheme(saved.preferences.theme);
      }
      setNotice({ type: 'success', text: '个性化信息已保存' });
    } catch (err) {
      setNotice({ type: 'error', text: getErrorMessage(err) || '个性化信息保存失败' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 bg-slate-900 border border-slate-700 rounded-2xl p-6 space-y-4 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 className="font-bold text-slate-100 text-sm flex items-center space-x-2">
            <UserCog className="w-4 h-4 text-cyan-400" />
            <span>用户信息维护</span>
          </h3>
          <button
            onClick={onClose}
            title="关闭"
            className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="py-10 text-center text-xs text-slate-400">正在加载个性化信息…</div>
        ) : (
          <div className="space-y-4 text-xs">
            {loadWarn && (
              <div className="p-2.5 rounded-lg border bg-amber-950/60 border-amber-800/60 text-amber-300">{loadWarn}</div>
            )}

            {/* 头像 */}
            <div className="flex items-center space-x-4">
              {form.avatar ? (
                <img
                  src={form.avatar}
                  alt="头像预览"
                  className="w-14 h-14 rounded-full object-cover border border-slate-700 bg-slate-950"
                />
              ) : (
                <div className="w-14 h-14 rounded-full bg-gradient-to-tr from-indigo-600 to-cyan-500 flex items-center justify-center text-base font-bold text-white shadow">
                  <UserCog className="w-6 h-6" />
                </div>
              )}
              <div className="flex-1 space-y-1.5">
                <label className="text-slate-300 font-medium block">头像</label>
                <div className="flex items-center space-x-2">
                  <label className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer">
                    <ImagePlus className="w-3.5 h-3.5 text-cyan-400" />
                    <span>上传图片</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        onAvatarFile(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {form.avatar && (
                    <button
                      onClick={() => setForm((prev) => ({ ...prev, avatar: '' }))}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700"
                    >
                      清除
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={form.avatar.startsWith('data:') ? '' : form.avatar}
                  onChange={(e) => setForm((prev) => ({ ...prev, avatar: e.target.value.trim() }))}
                  placeholder="或填写图片 URL（留空为默认头像）"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>

            {/* 昵称 */}
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">昵称</label>
              <input
                type="text"
                value={form.nickname}
                maxLength={USER_PERSONAL_FIELD_LIMITS.nickname}
                onChange={(e) => setForm((prev) => ({ ...prev, nickname: e.target.value }))}
                placeholder="留空则展示账号名"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-cyan-500"
              />
            </div>

            {/* 个人签名 */}
            <div className="space-y-1">
              <label className="text-slate-300 font-medium">个人签名</label>
              <textarea
                value={form.signature}
                maxLength={USER_PERSONAL_FIELD_LIMITS.signature}
                onChange={(e) => setForm((prev) => ({ ...prev, signature: e.target.value }))}
                placeholder="留空则不展示"
                rows={2}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none focus:border-cyan-500 resize-none"
              />
            </div>

            {/* 偏好设置 */}
            <div className="pt-2 border-t border-slate-800 space-y-3">
              <div className="text-slate-300 font-semibold">偏好设置</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-slate-400">界面主题</label>
                  <select
                    value={form.preferences.theme}
                    onChange={(e) => patchPreferences({ theme: e.target.value as ThemePreference })}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500"
                  >
                    {THEME_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-slate-400">金额单位</label>
                  <select
                    value={form.preferences.amountUnit}
                    onChange={(e) => patchPreferences({ amountUnit: e.target.value as UserAmountUnitPreference })}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500"
                  >
                    <option value="">跟随全局</option>
                    {AMOUNT_UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-slate-400">默认数据源</label>
                <select
                  value={form.preferences.defaultDataSourceId}
                  onChange={(e) => patchPreferences({ defaultDataSourceId: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-slate-200 focus:outline-none focus:border-cyan-500"
                >
                  <option value="">不指定（跟随当前选择）</option>
                  {dataSources.map((ds) => (
                    <option key={ds.id} value={ds.id}>
                      {ds.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {notice && (
              <div
                className={`p-2.5 rounded-lg border ${
                  notice.type === 'success'
                    ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-300'
                    : 'bg-rose-950/60 border-rose-800/60 text-rose-300'
                }`}
              >
                {notice.text}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700"
          >
            关闭
          </button>
          <button
            onClick={save}
            disabled={loading || saving}
            className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold shadow"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
};
