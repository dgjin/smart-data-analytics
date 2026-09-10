/**
 * NL2SQL Fallback 机制核心类型定义
 * 
 * 设计原则：
 * - 三层策略降级：rule_based → simpler_prompt → human_approval
 * - 所有失败样本自动记录为 Hard Negative，用于后续对抗训练
 * - 返回结果需包含是否应标注的标记，供前端 UI 展示提示
 */

export type FallbackStrategy = 'rule_based' | 'simpler_prompt' | 'human_approval' | 'none';

export interface FallbackResult {
  /** 是否成功生成可用 SQL */
  success: boolean;
  
  /** 使用的策略（'none'表示所有策略都失败） */
  strategy: FallbackStrategy;
  
  /** 生成的 SQL（success=true 时必有） */
  sql?: string;
  
  /** 解释说明（为什么使用这个策略） */
  explanation?: string;
  
  /** 错误信息（success=false 时必有） */
  error?: string;
  
  /** 是否应标记为待优化样本（用于对抗训练） */
  shouldBeAnnotated?: boolean;
  
  /** 标注任务 ID（strategy='human_approval'时提供） */
  annotationQueueId?: string;
}

export interface HardNegativeSample {
  /** 原始用户查询 */
  originalQuery: string;
  
  /** 失败的 SQL */
  originalSql: string;
  
  /** 错误原因 */
  errorMessage: string;
  
  /** 数据源 ID */
  dataSourceId: string;
  
  /** 用户 ID */
  userId: string;
  
  /** 时间戳 */
  timestamp: Date;
}

export interface AnnotationTask {
  /** 任务 ID */
  id: string;
  
  /** 关联的困难样本 ID */
  sampleId: string;
  
  /** 待修正的自然语言查询 */
  query: string;
  
  /** 失败的 SQL */
  failedSql: string;
  
  /** 期望的正确 SQL（由管理员填写） */
  expectedSql?: string;
  
  /** 备注说明 */
  notes?: string;
  
  /** 状态 */
  status: 'pending' | 'in_review' | 'approved' | 'rejected';
  
  /** 创建时间 */
  createdAt: Date;
  
  /** 审核人 */
  reviewerId?: string;
  
  /** 审核时间 */
  reviewedAt?: Date;
}

/**
 * 外部依赖接口（解耦 server 模块依赖）*/
export interface FallbackDependencies {
  /** 持久化困难样本到数据库 */
  persistHardNegative: (sample: Omit<HardNegativeSample, 'timestamp'>) => Promise<string>;
  
  /** 创建人工标注任务 */
  createAnnotationTask: (sampleId: string, query: string, failedSql: string, userId: string) => Promise<string>;
  
  /** 记录 fallback 审计日志 */
  logFallbackAudit: (traceId: string, query: string, failedSql: string, strategy: string, latencyMs: number) => Promise<void>;
}
