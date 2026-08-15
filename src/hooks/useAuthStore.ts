import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AuthUser, UserRole } from '../types/analytics';

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (...roles: UserRole[]) => boolean;
  /** 改密成功后清除标记，退出强制改密页 */
  clearMustChangePassword: () => void;
  /** 收到服务端 PASSWORD_CHANGE_REQUIRED 拦截时置位（如管理员重置了密码） */
  markMustChangePassword: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,

      // 使用裸 fetch 而非 apiFetch，避免 client.ts -> authStore 的循环依赖
      login: async (username, password) => {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || '登录失败');
        }
        // 切换账号时清理上一个账号的本地分析缓存
        localStorage.removeItem('analytics-store');
        set({ token: data.token, user: data.user });
      },

      logout: () => {
        localStorage.removeItem('analytics-store');
        set({ token: null, user: null });
      },

      hasRole: (...roles) => {
        const user = get().user;
        return !!user && roles.includes(user.role);
      },

      clearMustChangePassword: () => {
        const user = get().user;
        if (user?.mustChangePassword) {
          set({ user: { ...user, mustChangePassword: false } });
        }
      },

      markMustChangePassword: () => {
        const user = get().user;
        if (user && !user.mustChangePassword) {
          set({ user: { ...user, mustChangePassword: true } });
        }
      },
    }),
    {
      name: 'auth-store',
      partialize: (state) => ({ token: state.token, user: state.user }),
    }
  )
);
