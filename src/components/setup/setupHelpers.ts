/**
 * 首启向导共享纯函数（v0.9.114 P1-2 拆分自 setupUi.tsx）：
 * 与组件分文件存放，保证 setupUi.tsx 只导出组件、Fast Refresh HMR 边界正确。
 */
import type { StepLevel } from './setupUi';

/** 子任务/检查项状态 → 图标等级 */
export function subtaskLevel(state: string): StepLevel {
  if (state === 'success') return 'ok';
  if (state === 'failed') return 'block';
  if (state === 'skipped') return 'warn';
  if (state === 'running') return 'running';
  return 'pending';
}
