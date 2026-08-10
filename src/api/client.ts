import { useAuthStore } from '../hooks/useAuthStore';

/**
 * 统一 fetch 封装：自动注入 Authorization: Bearer <token>。
 * 收到 401 响应时清空本地会话（App 会因此渲染登录页）。
 * options 透传（支持 signal 供 AbortController 使用）。
 */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = useAuthStore.getState().token;

  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(path, { ...options, headers });

  if (response.status === 401) {
    useAuthStore.getState().logout();
    throw new Error('登录已失效，请重新登录');
  }

  return response;
}
