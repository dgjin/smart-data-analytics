/**
 * zod 统一输入校验基础设施（v0.9.114 P0-2）。
 *
 * 渐进策略：新代码与「无 sanitize 覆盖的裸露写路由」用 zod；
 * 已有 sanitizeXxxInput 判别联合的存量路由保持不变（错误格式深度耦合，不强行替换）。
 *
 * 与手写 sanitize 的关系：
 * - sanitize 返回 { ok, error } 判别联合，由路由自行 return res.status(400)；
 * - 本模块 validateBody/validateQuery 同样返回 { ok, data | error } 判别联合，
 *   风格对齐、可内联使用，错误文案由 zod issues 生成，与现有 { error } 响应格式一致。
 */
import { z } from 'zod';

/** 业务可读的单条校验错误（取 zod issues 首条，拼路径前缀） */
export function firstIssueMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return '请求参数不合法';
  const path = issue.path.filter((p) => typeof p === 'string' || typeof p === 'number').join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

export interface Validated<T> {
  ok: true;
  data: T;
}

/**
 * 校验请求体，返回判别联合（与 sanitize 风格对齐，便于路由内联使用）。
 * 不抛异常，由路由决定返回 400 的时机与文案包装。
 */
export function validateBody<S extends z.ZodType>(
  schema: S,
  body: unknown
): { ok: true; data: z.infer<S> } | { ok: false; error: string } {
  const r = schema.safeParse(body ?? {});
  if (!r.success) return { ok: false, error: firstIssueMessage(r.error) };
  return { ok: true, data: r.data };
}

/** 校验 query 参数（值均为 string，schema 内用 z.coerce 转换） */
export function validateQuery<S extends z.ZodType>(
  schema: S,
  query: unknown
): { ok: true; data: z.infer<S> } | { ok: false; error: string } {
  const r = schema.safeParse(query ?? {});
  if (!r.success) return { ok: false, error: firstIssueMessage(r.error) };
  return { ok: true, data: r.data };
}

// ---------- 通用原子 schema（跨模块复用） ----------

/** 非空去空白字符串，可设最大长度 */
export const nonEmptyString = (max = 200) => z.string().trim().min(1).max(max);

/** 正整数 ID（路径参数或 body 字段），兼容数字与数字字符串 */
export const idSchema = z.coerce.number().int().positive();

/** dataSourceId：本系统统一为字符串标识 */
export const dataSourceIdSchema = z.string().trim().min(1).max(128);

/** 布尔开关（严格 boolean，拒绝字符串 '1'/'true'） */
export const booleanSchema = z.boolean();

/** 分页 limit：1-200，默认 50 */
export const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

/** 分页 offset：非负整数，默认 0 */
export const offsetSchema = z.coerce.number().int().min(0).default(0);
