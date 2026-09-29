/**
 * v0.9.85 首启初始化向导：JSON 请求封装（认证 apiFetch + 统一错误规范化）。
 * 错误抛 SetupApiError（携带 status 与响应体）：Step③ 借 status===409 + data.taskId 接管在途流水线任务。
 */
import { apiFetch } from '../../api/client';

export class SetupApiError extends Error {
  readonly status: number;
  readonly data: Record<string, unknown>;

  constructor(message: string, status: number, data: Record<string, unknown>) {
    super(message);
    this.name = 'SetupApiError';
    this.status = status;
    this.data = data;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, options);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new SetupApiError((data.error as string) || `请求失败（HTTP ${res.status}）`, res.status, data);
  }
  return data as T;
}

export function setupGet<T = Record<string, unknown>>(path: string): Promise<T> {
  return request<T>(path);
}

export function setupPost<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}
