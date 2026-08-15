/**
 * P2-10 前端 store 测试：认证状态流转（登录/登出/角色判断/强制改密标记）。
 * @vitest-environment jsdom
 */
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from './useAuthStore';
import { AuthUser } from '../types/analytics';

function fakeUser(over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 1,
    username: 'admin',
    role: 'ADMIN',
    mustChangePassword: false,
    ...over,
  } as AuthUser;
}

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ token: null, user: null });
  localStorage.clear();
});

describe('useAuthStore', () => {
  it('login 成功写入 token 与用户并清空旧缓存', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, token: 't1', user: fakeUser() }) }),
    );
    localStorage.setItem('analytics-store', 'stale');

    await act(async () => useAuthStore.getState().login('admin', 'admin123'));

    expect(useAuthStore.getState().token).toBe('t1');
    expect(useAuthStore.getState().user?.username).toBe('admin');
    expect(localStorage.getItem('analytics-store')).toBeNull();
  });

  it('login 失败抛出服务端错误文案且不写入状态', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ success: false, error: '密码错误' }) }),
    );
    await expect(useAuthStore.getState().login('admin', 'wrong')).rejects.toThrow('密码错误');
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('logout 清空登录态并清理本地缓存', () => {
    act(() => {
      useAuthStore.setState({ token: 't1', user: fakeUser() });
    });
    localStorage.setItem('analytics-store', 'x');

    act(() => useAuthStore.getState().logout());

    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem('analytics-store')).toBeNull();
  });

  it('hasRole 按当前用户角色判断（未登录恒 false）', () => {
    act(() => {
      useAuthStore.setState({ token: null, user: null });
    });
    expect(useAuthStore.getState().hasRole('ADMIN')).toBe(false);

    act(() => {
      useAuthStore.setState({ token: 't', user: fakeUser({ role: 'ANALYST' }) });
    });
    expect(useAuthStore.getState().hasRole('ADMIN')).toBe(false);
    expect(useAuthStore.getState().hasRole('ANALYST', 'ADMIN')).toBe(true);
  });

  it('markMustChangePassword / clearMustChangePassword 切换标记且未登录安全跳过', () => {
    act(() => {
      useAuthStore.setState({ token: null, user: null });
    });
    act(() => useAuthStore.getState().markMustChangePassword());
    expect(useAuthStore.getState().user).toBeNull();

    act(() => {
      useAuthStore.setState({ token: 't', user: fakeUser() });
    });
    act(() => useAuthStore.getState().markMustChangePassword());
    expect(useAuthStore.getState().user?.mustChangePassword).toBe(true);

    act(() => useAuthStore.getState().clearMustChangePassword());
    expect(useAuthStore.getState().user?.mustChangePassword).toBe(false);
  });
});
