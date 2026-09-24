/**
 * 安装应用按钮（PWA）：仅当浏览器触发 beforeinstallprompt（Chrome/Edge 桌面 +
 * 安全上下文）且尚未安装时渲染；点击弹出浏览器原生安装框。
 * 其余环境（Firefox/Safari、HTTP 非 localhost、已安装）自动隐藏，无副作用。
 */
import React from 'react';
import { MonitorDown } from 'lucide-react';
import { usePwaInstall } from '../pwa/usePwaInstall';

export const InstallAppButton: React.FC = () => {
  const { canInstall, promptInstall, prompting } = usePwaInstall();
  if (!canInstall) return null;
  return (
    <button
      onClick={() => {
        void promptInstall();
      }}
      disabled={prompting}
      title="安装为桌面应用：独立窗口运行（如未弹出安装框，可点击地址栏右侧的安装图标）"
      className="flex items-center shrink-0 space-x-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-800/50 transition-colors disabled:opacity-50"
    >
      <MonitorDown className="w-3.5 h-3.5" />
      <span className="hidden xl:inline">{prompting ? '安装中…' : '安装应用'}</span>
    </button>
  );
};
