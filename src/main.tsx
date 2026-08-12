import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {applyUITheme, getUITheme} from './utils/uiTheme';

// 与 index.html 内联脚本一致地应用持久化主题（兜底，保证组件读取到正确状态）
applyUITheme(getUITheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
