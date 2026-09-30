import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {applyUITheme, getUITheme} from './utils/uiTheme';
import { configureApiAuth } from './api/client';
import { useAuthStore } from './hooks/useAuthStore';
import { ErrorBoundary } from './components/ErrorBoundary';
import { registerServiceWorker } from './pwa/register';
import { initClientErrorReporting } from './utils/clientErrorReporter';
import { useAnalyticsStore } from './hooks/useAnalyticsStore';

// 与 index.html 内联脚本一致地应用持久化主题（兜底，保证组件读取到正确状态）
applyUITheme(getUITheme());

// P2-10 跨 store 解耦：组合根处注入会话能力（api 层不再反向依赖 auth store，消除循环依赖）
configureApiAuth({
  getToken: () => useAuthStore.getState().token ?? undefined,
  onUnauthorized: () => useAuthStore.getState().logout(),
  onMustChangePassword: () => useAuthStore.getState().markMustChangePassword(),
});

// PWA：注册 Service Worker（仅生产环境；参见 src/pwa/register.ts）
registerServiceWorker();

// v0.9.94 前端错误回流（日志评估 P2-12）：全局错误/未处理 Promise 采样上报
// /api/ops/client-errors → 归集为 source=client 运维事件（getPage 惰性读取当前功能 Tab，
// 为无 URL 路由 SPA 提供事件去重实体的页面区隔度）
initClientErrorReporting({ getPage: () => useAnalyticsStore.getState().activeTab });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
