import { describe, it, expect, beforeEach } from 'vitest';

// Node 环境无浏览器全局，手动打桩 localStorage / document / window
const store: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  },
  configurable: true,
});

let lightClassOn = false;
// PWA：theme-color meta 桩（记录 applyUITheme 写入的 content）
let themeColorValue: string | null = null;
const metaStub = {
  setAttribute: (name: string, value: string) => {
    if (name === 'content') themeColorValue = value;
  },
};
Object.defineProperty(globalThis, 'document', {
  value: {
    documentElement: {
      classList: {
        toggle: (cls: string, on: boolean) => {
          if (cls === 'light') lightClassOn = on;
          return on;
        },
      },
    },
    querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? metaStub : null),
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'window', {
  value: { dispatchEvent: () => true },
  configurable: true,
});

import { getUITheme, applyUITheme, toggleUITheme } from './uiTheme';

describe('uiTheme: 深浅色主题切换', () => {
  beforeEach(() => {
    delete store['app-ui-theme'];
    lightClassOn = false;
    themeColorValue = null;
  });

  it('未保存或非法值默认深色', () => {
    expect(getUITheme()).toBe('dark');
    store['app-ui-theme'] = 'blue';
    expect(getUITheme()).toBe('dark');
  });

  it('保存 light 时读取为 light', () => {
    store['app-ui-theme'] = 'light';
    expect(getUITheme()).toBe('light');
  });

  it('applyUITheme(light) 在 html 上挂载 light 类并持久化', () => {
    applyUITheme('light');
    expect(lightClassOn).toBe(true);
    expect(store['app-ui-theme']).toBe('light');
    applyUITheme('dark');
    expect(lightClassOn).toBe(false);
    expect(store['app-ui-theme']).toBe('dark');
  });

  it('toggleUITheme 在深浅之间翻转', () => {
    expect(toggleUITheme()).toBe('light');
    expect(getUITheme()).toBe('light');
    expect(toggleUITheme()).toBe('dark');
    expect(getUITheme()).toBe('dark');
  });

  it('applyUITheme 同步 theme-color meta（PWA 窗口标题栏配色）', () => {
    applyUITheme('light');
    expect(themeColorValue).toBe('#f8fafc');
    applyUITheme('dark');
    expect(themeColorValue).toBe('#0f172a');
  });
});
