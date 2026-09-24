/**
 * 离线横幅：网络断开时全局提示（数据功能不可用），恢复在线后自动消失。
 * 与 Service Worker 的离线壳缓存配合：壳可离线打开，数据链路依赖网络。
 */
import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../pwa/useOnlineStatus';

export const OfflineBanner: React.FC = () => {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div className="fixed top-16 left-0 right-0 z-40 flex items-center justify-center gap-2 bg-amber-500/95 text-slate-900 text-xs font-semibold py-1.5 shadow-md pointer-events-none">
      <WifiOff className="w-3.5 h-3.5" />
      当前处于离线状态：数据查询、报表与保存功能暂不可用，网络恢复后自动恢复
    </div>
  );
};
