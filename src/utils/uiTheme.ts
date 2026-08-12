/**
 * 全局 UI 主题（深色/浅色）切换工具。
 * 通过在 <html> 上切换 light 类，配合 index.css 中的 CSS 变量重映射实现浅色主题；
 * 选择持久化到 localStorage，页面加载前由 index.html 内联脚本应用，避免闪烁。
 */

export type UIThemeMode = 'dark' | 'light';

const STORAGE_KEY = 'app-ui-theme';

/** 主题变更自定义事件，供组件订阅同步状态 */
export const UI_THEME_EVENT = 'app-ui-theme-change';

export function getUITheme(): UIThemeMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyUITheme(mode: UIThemeMode): void {
  document.documentElement.classList.toggle('light', mode === 'light');
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 存储不可用时仅本次会话生效
  }
  window.dispatchEvent(new CustomEvent<UIThemeMode>(UI_THEME_EVENT, { detail: mode }));
}

export function toggleUITheme(): UIThemeMode {
  const next: UIThemeMode = getUITheme() === 'light' ? 'dark' : 'light';
  applyUITheme(next);
  return next;
}
