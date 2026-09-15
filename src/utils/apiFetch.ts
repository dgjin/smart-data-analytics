/**
 * API 请求封装工具
 * 统一的 fetch 封装，处理错误和响应
 */
import { logger } from './logger';

export async function apiFetch<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    logger.error('[apiFetch] Error:', error);
    throw error;
  }
}

export default apiFetch;
