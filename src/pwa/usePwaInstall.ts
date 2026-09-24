/**
 * PWA 安装能力 Hook：监听 beforeinstallprompt / appinstalled 事件，提供应用内安装入口。
 *
 * 说明：
 * - 仅 Chrome/Edge 桌面（安全上下文：HTTPS 或 localhost）会触发 beforeinstallprompt，
 *   其余环境 canInstall 恒为 false，按钮自动隐藏（渐进增强，无副作用）；
 * - prompt() 消费事件后本次不可复用（Chrome 另有内置冷却期），置空按钮等待下次事件；
 * - 已安装（standalone 显示模式或 appinstalled 事件）后不再显示入口。
 */
import { useCallback, useEffect, useState } from 'react';

/** beforeinstallprompt 事件（Chrome 专有，DOM 类型库未收录，需自定义） */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** 是否以独立应用窗口运行（即已安装并从桌面启动） */
export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)')?.matches === true;
}

export interface PwaInstallState {
  /** 是否显示安装入口（可安装且尚未安装） */
  canInstall: boolean;
  /** 触发浏览器安装弹窗 */
  promptInstall: () => Promise<void>;
  /** 安装弹窗处理中（按钮禁用态） */
  prompting: boolean;
}

export function usePwaInstall(): PwaInstallState {
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(() => isStandaloneDisplay());
  const [prompting, setPrompting] = useState(false);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      // 阻止 Chrome 默认的迷你信息条，统一由应用内按钮承载安装入口
      event.preventDefault();
      setDeferredEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferredEvent(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredEvent || prompting) return;
    setPrompting(true);
    try {
      await deferredEvent.prompt();
      await deferredEvent.userChoice;
      // 事件已被消费：置空隐藏按钮；若 Chrome 冷却期后再次触发事件，按钮会重新出现
      setDeferredEvent(null);
    } catch {
      // prompt 偶发不可用（事件过期等）：静默等待下次事件
    } finally {
      setPrompting(false);
    }
  }, [deferredEvent, prompting]);

  return { canInstall: !installed && deferredEvent !== null, promptInstall, prompting };
}
