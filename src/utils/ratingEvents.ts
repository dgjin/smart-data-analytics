/**
 * v0.9.108 评分变更事件：评价提交成功后广播，侧边栏评分统计立即刷新（无需等待 60s 轮询）。
 * 用轻量自定义事件而非全局 store，避免问数/评价/侧边栏之间额外耦合。
 */
export const RATING_UPDATED_EVENT = 'app:rating-updated';

export function notifyRatingUpdated(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(RATING_UPDATED_EVENT));
  } catch {
    /* 事件派发失败不影响提交结果 */
  }
}
