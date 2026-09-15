/**
 * 错误提取辅助（质量优化 Stage 4）：catch 变量由 `any` 收敛为 unknown 后的统一提取入口。
 *
 * 语义对齐原 `err?.message || err` 惯用法：Error → message；字符串 → 原样；
 * 带 message 的对象 → message；其余（null/数字/无 message 对象）→ String(err)，
 * 与模板插值行为一致，保证 any 清零为零行为变化。
 */

/** 提取错误消息（等价替换 `err?.message || err` 与 `err.message`） */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  return String(err);
}

/** 提取错误码（等价替换 `err?.code`）；无码时返回空串 */
export function getErrorCode(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    if (typeof code === 'number') return String(code);
  }
  return '';
}

/** 判断是否带指定属性（catch 体内自定义字段的窄化守卫） */
export function hasProp<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return Boolean(value) && typeof value === 'object' && key in (value as object);
}

/** 是否为 AbortError（等价替换 `err?.name === 'AbortError'`，行为严格一致） */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: unknown }).name === 'AbortError';
}
