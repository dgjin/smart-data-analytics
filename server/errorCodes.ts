/**
 * P1-8 统一错误码：错误响应增量附带 code 字段（error 文案保持不变）。
 * 前端可按 code 做精准分支（提示分级 / 静默降级 / 引导操作），而非解析中文文案。
 * 命名约定：全大写蛇形（SCREAMING_SNAKE_CASE），按"失败原因"而非 HTTP 状态命名。
 */
export const ERROR_CODES = {
  /** 请求参数校验失败（含输入超长 / 指令内容被拒） */
  INVALID_INPUT: 'INVALID_INPUT',
  /** 角色或权限不足（含越权访问他人资源） */
  FORBIDDEN: 'FORBIDDEN',
  /** P2-11 无该数据源访问权限（可通过权限申请审批流开通） */
  DS_ACCESS_DENIED: 'DS_ACCESS_DENIED',
  /** 管理员已停用该数据源的智能问数功能 */
  AI_SWITCHED_OFF: 'AI_SWITCHED_OFF',
  /** 触发限流 */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 同一数据源上一个查询仍在进行中 */
  QUERY_IN_FLIGHT: 'QUERY_IN_FLIGHT',
  /** 分析计划无效或已过期（已被消费 / 不存在） */
  PLAN_INVALID: 'PLAN_INVALID',
  /** 提交问题与分析计划不匹配 */
  PLAN_MISMATCH: 'PLAN_MISMATCH',
  /** 目标资源不存在 */
  NOT_FOUND: 'NOT_FOUND',
  /** SQL 未通过安全校验被拒绝执行 */
  SQL_REJECTED: 'SQL_REJECTED',
  /** AI/LLM 服务不可用（超时、配额、网络） */
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  /** 服务端内部错误（未归类的兜底） */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
