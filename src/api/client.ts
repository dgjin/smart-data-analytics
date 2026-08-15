/**
 * 统一 fetch 封装：自动注入 Authorization: Bearer <token>。
 * 收到 401 响应时清空本地会话（App 会因此渲染登录页）。
 * options 透传（支持 signal 供 AbortController 使用）。
 *
 * P2-10 跨 store 解耦：本模块不再直接 import useAuthStore，
 * 会话侧能力（取 token / 登出 / 强制改密）由组合根 main.tsx 通过 configureApiAuth 注入，
 * 消除 api 层 ↔ auth store 的潜在循环依赖。
 */

/** 会话能力注入接口（未配置时 apiFetch 退化为裸 fetch + 错误抛出） */
export interface ApiAuthHandlers {
  getToken: () => string | undefined;
  onUnauthorized: () => void;
  onMustChangePassword: () => void;
}

let authHandlers: ApiAuthHandlers | null = null;

/** 组合根（main.tsx）启动时接线，注入会话能力 */
export function configureApiAuth(handlers: ApiAuthHandlers): void {
  authHandlers = handlers;
}

/**
 * P1-8 带 code 的 API 错误：message 为用户可读文案，code 对齐 server/errorCodes.ts（服务端增量下发）。
 * 调用方可按 code 精准分支，未带 code 的错误（网络异常等）code 为 undefined。
 */
export class ApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

/** 解析错误响应体：返回 { error, code }，HTTP 非 2xx 时的统一读取入口（body 非合法 JSON 时兜底） */
export async function parseApiErrorBody(resp: Response): Promise<{ error: string; code?: string }> {
  const body = await resp.clone().json().catch(() => null);
  return {
    error: (body?.error as string) || `请求失败（HTTP ${resp.status}）`,
    code: typeof body?.code === 'string' ? body.code : undefined,
  };
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = authHandlers?.getToken();

  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(path, { ...options, headers });

  if (response.status === 401) {
    authHandlers?.onUnauthorized();
    throw new ApiError('登录已失效，请重新登录', 'UNAUTHORIZED');
  }

  // P0-1 首登/被重置密码强制改密：服务端 403 拦截后切到强制改密页（会话保留）
  if (response.status === 403) {
    const body = await response.clone().json().catch(() => null);
    if (body?.code === 'PASSWORD_CHANGE_REQUIRED') {
      authHandlers?.onMustChangePassword();
      throw new ApiError(body.error || '请先修改密码', 'PASSWORD_CHANGE_REQUIRED');
    }
  }

  return response;
}
