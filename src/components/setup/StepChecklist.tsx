/**
 * 向导 Step④ 待办确认清单：GET /api/setup/checklist 五项动态状态 + 深链处理。
 * 无硬门槛（均可稍后处理）；首次加载成功即写入步骤快照，供断点续做定位。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SetupStatusIcon, outlineBtn, type StepLevel } from './setupUi';
import { setupGet } from './setupApi';
import type { SetupChecklistItem, SetupStepProps } from './setupTypes';

export interface StepChecklistProps extends SetupStepProps {
  /** 深链：'admin:*' 关闭向导跳系统管理；'setup:step2' 由 SetupWizard 拦截回第②步 */
  onNavigate: (link: string) => void;
}

const itemLevel = (status: SetupChecklistItem['status']): StepLevel => (status === 'done' ? 'ok' : status === 'warn' ? 'warn' : 'pending');

export const StepChecklist: React.FC<StepChecklistProps> = ({ onResult, onReadyChange, onNavigate }) => {
  const [items, setItems] = useState<SetupChecklistItem[] | null>(null);
  const [error, setError] = useState('');
  const savedRef = useRef(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const list = await setupGet<SetupChecklistItem[]>('/api/setup/checklist');
      setItems(list);
      if (!savedRef.current) {
        savedRef.current = true;
        void onResult({ done: true, at: new Date().toISOString() });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '待办清单加载失败');
    } finally {
      // 无硬门槛：加载失败也允许继续
      onReadyChange(true);
    }
  }, [onResult, onReadyChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = (items || []).filter((it) => it.status !== 'done').length;

  return (
    <div className="space-y-3.5">
      {items === null && !error && <div className="text-xs text-slate-400">清单加载中…</div>}

      {items && (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 divide-y divide-slate-800/70">
          {items.map((it) => (
            <div key={it.key} className="flex items-start gap-3 px-4 py-3">
              <SetupStatusIcon level={itemLevel(it.status)} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-slate-100">{it.title}</div>
                <div className="text-xs text-slate-400 mt-0.5">{it.detail}</div>
              </div>
              {it.link && (
                <button type="button" className={`${outlineBtn} shrink-0`} onClick={() => onNavigate(it.link as string)}>
                  去处理
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {items && (
        <div className="text-xs text-slate-500">
          {pending > 0
            ? `仍有 ${pending} 项待处理，可稍后在「系统管理」中继续（不影响向导完成）。`
            : '待办事项均已处理完毕。'}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-rose-300">{error}</span>
          <button type="button" className={outlineBtn} onClick={() => void load()}>
            重新加载
          </button>
        </div>
      )}
    </div>
  );
};
