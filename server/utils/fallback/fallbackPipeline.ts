/**
 * NL2SQL Fallback 机制核心调度器
 * 
 * 设计原则:
 * 1. 三层策略降级:rule_based → simpler_prompt → human_approval
 * 2. 所有失败样本自动记录为 Hard Negative，用于后续对抗训练
 * 3. 返回结果包含是否应标注标记，供前端 UI 展示提示
 * 
 * ⚠️ 重要：本文件不直接导入 server 模块，外部功能通过参数注入
 */

import type { FallbackResult, FallbackStrategy, HardNegativeSample } from './types.js';
import { applyRuleBasedResolution } from '../fallbackStrategies/ruleBased.js';
import { applySimplerPromptStrategy } from '../fallbackStrategies/simplerPrompt.js';

const FALLBACK_STRATEGIES: FallbackStrategy[] = ['rule_based', 'simpler_prompt', 'human_approval'];

// 占位：真正的 logger 由调用者传入
const noopLogger = {
  info: (...args: any[]) => {},
  warn: (...args: any[]) => console.warn('[Fallback]', ...args),
  error: (...args: any[]) => console.error('[Fallback]', ...args)
};

type LoggerType = typeof noopLogger;

/**
 * 解析错误原因分类
 */
function classifyError(error: string): 'syntax_error' | 'semantic_error' | 'permission_denied' | 'unknown' {
  const errorMsg = error.toLowerCase();
  if (errorMsg.includes('syntax') || errorMsg.includes('parse')) return 'syntax_error';
  if (errorMsg.includes('permission') || errorMsg.includes('access denied')) return 'permission_denied';
  if (errorMsg.includes('column') || errorMsg.includes('table') || errorMsg.includes('undefined')) return 'semantic_error';
  return 'unknown';
}

/**
 * 主入口：解决阶段二解读失败
 * 
 * @param query 原始用户查询
 * @param failedSql 失败的 SQL
 * @param context 上下文信息
 * @param deps 外部依赖（DB、Logger 等）
 * @returns FallbackResult
 */
export async function resolveStageTwoFailure(
  query: string,
  failedSql: string,
  context: { dsId?: string; userId?: string; schema?: any[] },
  deps: {
    logger?: LoggerType;
    persistHardNegative?: (sample: Omit<HardNegativeSample, 'timestamp'>) => Promise<string>;
    logFallbackAudit?: (sql: string, params: any[]) => Promise<void>;
    /** Group B 策略检索器：从已审核 few-shot 示例库找相似问题的修正 SQL */
    retrieveApprovedFewShot?: (query: string, dsId: string) => Promise<{ question: string; sql: string } | null>;
  } = {}
): Promise<FallbackResult> {
  const logger = deps.logger || noopLogger;
  const startTime = Date.now();

  logger.info?.('[Fallback] Starting resolution', { 
    queryLength: query.length,
    strategiesRemaining: FALLBACK_STRATEGIES.length 
  });

  // 依次尝试三种策略
  for (const strategy of FALLBACK_STRATEGIES) {
    try {
      let result: FallbackResult;
      
      switch (strategy) {
        case 'rule_based':
          result = await applyRuleBasedResolution(query, { dsId: context.dsId });
          break;
          
        case 'simpler_prompt':
          // v0.9.47 P0 接通：原分支直接 throw 占位，三层降级实际只有一层
          result = await applySimplerPromptStrategy(query, {
            schema: context.schema,
            dsId: context.dsId,
            userId: context.userId,
          });
          break;
          
        case 'human_approval': {
          // v0.9.47 P0 接通：从已审核 few-shot 示例库检索相似问题的修正 SQL 直接复用
          //（同步链路无法等待人工，"人工介入"的价值在于复用此前的人工审核成果）
          const approved = deps.retrieveApprovedFewShot
            ? await deps.retrieveApprovedFewShot(query, context.dsId || '')
            : null;
          if (!approved) {
            throw new Error('No approved few-shot example matches this question');
          }
          result = {
            success: true,
            strategy: 'human_approval',
            sql: approved.sql,
            explanation: `复用人工审核通过的相似问题修正 SQL（原问题：「${approved.question.slice(0, 40)}」）`,
          };
          break;
        }
          
        default:
          throw new Error(`Unknown strategy: ${strategy}`);
      }
      
      if (result.success) {
        const latency = Date.now() - startTime;
        logger.info?.('[Fallback] Strategy succeeded', { 
          strategy,
          latency,
          queryId: context.dsId 
        });
        
        // 写入审计日志
        if (deps.logFallbackAudit) {
          await deps.logFallbackAudit(
            `INSERT INTO fallback_audit_log (trace_id, query, failed_sql, used_strategy, latency_ms, created_at) VALUES (?, ?, ?, ?, NOW())`,
            [context.dsId || '', query, failedSql, strategy]
          );
        }
        
        return result;
      }
      
      logger.warn?.('[Fallback] Strategy failed', { strategy });
      
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.warn?.('[Fallback] Strategy exception', { strategy, error: err.message });
      continue; // 继续尝试下一策略
    }
  }

  // 所有策略失败
  const totalLatency = Date.now() - startTime;
  logger.error?.('[Fallback] All strategies exhausted', { totalLatency });

  // 保存为待标注样本
  if (deps.persistHardNegative) {
    await deps.persistHardNegative({
      originalQuery: query,
      originalSql: failedSql,
      errorMessage: 'All automated strategies failed',
      dataSourceId: context.dsId || 'unknown',
      userId: context.userId || 'anonymous'
    }).catch(err => logger.error?.('[Fallback] Failed to persist hard negative:', err));
  }

  return {
    success: false,
    strategy: 'none',
    error: 'All fallback strategies exhausted',
    shouldBeAnnotated: true,
    explanation: '所有自动化策略均失败，建议移交人工审核'
  };
}
