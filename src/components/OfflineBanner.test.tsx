/**
 * 离线横幅组件单测：离线渲染 / 在线隐藏 / 恢复后消失。
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OfflineBanner } from './OfflineBanner';

afterEach(cleanup);

describe('OfflineBanner', () => {
  it('在线时不渲染横幅', () => {
    render(<OfflineBanner />);
    expect(screen.queryByText(/当前处于离线状态/)).toBeNull();
  });

  it('触发 offline 事件后渲染横幅，恢复 online 后消失', () => {
    render(<OfflineBanner />);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText(/当前处于离线状态/)).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByText(/当前处于离线状态/)).toBeNull();
  });
});
