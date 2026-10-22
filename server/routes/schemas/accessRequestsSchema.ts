/**
 * 权限申请审批流 zod schema（v0.9.114 P0-2 渐进示范）。
 * 仅覆盖原手写 String(...).trim() 的输入契约，业务规则（存在性/重复/状态机）仍在路由内。
 */
import { z } from 'zod';
import { dataSourceIdSchema } from '../../infra/validate';

/**
 * POST / 申请创建。
 * 对齐原语义：dataSourceId 去空白判空必填；reason 去空白、超长截断至 500、判空必填。
 */
export const createAccessRequestSchema = z.object({
  dataSourceId: dataSourceIdSchema,
  reason: z
    .string()
    .trim()
    .transform((s) => s.slice(0, 500))
    .pipe(z.string().min(1, { message: '请填写申请理由' })),
});
export type CreateAccessRequestInput = z.infer<typeof createAccessRequestSchema>;

/** POST /:id/approve|reject 决策备注：可选，超长截断（与原 .slice(0,300) 语义一致，不拒绝） */
export const decideNoteSchema = z.object({
  note: z
    .string()
    .trim()
    .transform((s) => s.slice(0, 300))
    .optional()
    .default(''),
});
export type DecideNoteInput = z.infer<typeof decideNoteSchema>;
