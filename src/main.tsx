import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {applyUITheme, getUITheme} from './utils/uiTheme';
import { configureApiAuth } from './api/client';
import { useAuthStore } from './hooks/useAuthStore';

// 与 index.html 内联脚本一致地应用持久化主题（兜底，保证组件读取到正确状态）
applyUITheme(getUITheme());

// P2-10 跨 store 解耦：组合根处注入会话能力（api 层不再反向依赖 auth store，消除循环依赖）
configureApiAuth({
  getToken: () => useAuthStore.getState().token ?? undefined,
  onUnauthorized: () => useAuthStore.getState().logout(),
  onMustChangePassword: () => useAuthStore.getState().markMustChangePassword(),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
