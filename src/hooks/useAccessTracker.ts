/**
 * v0.9.107 访问采集挂载点：登录页与登录后都会上报（匿名会话同样计入累计/今日访问）。
 * - activeTab 变化时上报模块热度（同一模块 60s 内由 accessTracker 节流）；
 * - 挂载期间维持在线心跳，卸载时停止。
 */
import { useEffect } from 'react';
import { reportVisit, startAccessHeartbeat } from '../utils/accessTracker';

export function useAccessTracker(module: string): void {
  useEffect(() => {
    reportVisit(module);
  }, [module]);

  useEffect(() => startAccessHeartbeat(), []);
}
