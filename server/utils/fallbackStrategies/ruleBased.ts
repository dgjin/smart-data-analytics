/**
 * Rule-Based Fallback 策略实现
 * 
 * 适用场景：简单的时间范围查询、单表聚合查询
 * 优点：快速响应（无需调用 LLM），准确率可控
 * 缺点：仅覆盖有限模式，需持续扩展规则库
 */

import type { FallbackResult } from '../fallback/types.js';

/**
 * 时间范围匹配正则（支持多种中文表述）
 * 示例：2024-01-01 至 2024-01-31 / 2024 年 1 月到 2024 年 2 月 / January to February 2024
 */
const TIME_RANGE_PATTERNS = [
  // YYYY-MM-DD 格式
  /(\d{4}-\d{2}-\d{2})\s*(?:至 | 到|～|-)\s*(\d{4}-\d{2}-\d{2})/i,
  // YYYY 年 MM 月格式
  /(\d{4}) 年 (\d{1,2}) 月\s*(?:至 | 到 |~)?\s*(\d{4}) 年 (\d{1,2}) 月/i,
  // Month YYYY to Month YYYY
  /([A-Za-z]+)\s+(\d{4})\s*(?:to|through|-\s*)\s*([A-Za-z]+)\s+(\d{4})/i,
];

/**
 * 金额相关关键词映射（用于推断聚合函数）
 */
const AMOUNT_KEYWORDS = [
  '总额', '总和', '总计', '合计', 'sum', 'total', '总量', '数额',
  '收入', '营收', '支出', '成本', '费用', '利润', 'margin'
];

/**
 * 数量相关关键词映射
 */
const QUANTITY_KEYWORDS = [
  '数量', '件数', '笔数', 'count', 'number', '总量', '累计'
];

/**
 * 检测查询是否包含时间范围
 */
export function detectTimeRange(query: string): {
  detected: boolean;
  startDate?: string;
  endDate?: string;
  format?: 'iso' | 'chinese' | 'english';
} {
  const match1 = query.match(TIME_RANGE_PATTERNS[0]); // YYYY-MM-DD
  if (match1) {
    return {
      detected: true,
      startDate: match1[1],
      endDate: match1[2],
      format: 'iso'
    };
  }
  
  const match2 = query.match(TIME_RANGE_PATTERNS[1]); // YYYY 年 MM 月
  if (match2) {
    const start = `${match2[1]}-${String(parseInt(match2[2] || '1')).padStart(2, '0')}-01`;
    const end = `${match2[3]}-${String(parseInt(match2[4] || '1')).padStart(2, '0')}-01`;
    return { detected: true, startDate: start, endDate: end, format: 'chinese' };
  }
  
  const match3 = query.match(TIME_RANGE_PATTERNS[2]); // English month
  if (match3) {
    return { detected: false }; // MVP 暂不支持英文格式
  }
  
  return { detected: false };
}

/**
 * 检测查询是否包含聚合意图
 */
export function detectAggregationIntent(query: string): {
  hasAmountAgg: boolean;
  hasQuantityAgg: boolean;
} {
  const hasAmount = AMOUNT_KEYWORDS.some(keyword => query.includes(keyword));
  const hasQuantity = QUANTITY_KEYWORDS.some(keyword => query.includes(keyword));
  return { hasAmountAgg: hasAmount, hasQuantityAgg: hasQuantity };
}

/**
 * 生成时间范围 SQL 的基础模板
 * 注意：这里仅返回一个简化版本，实际执行时需在 runLiveQuery 中补全
 */
export function generateTimeRangeSQL(
  query: string,
  dataSourceId: string
): { sql: string; explanation: string } {
  const timeInfo = detectTimeRange(query);
  
  if (!timeInfo.detected || !timeInfo.startDate || !timeInfo.endDate) {
    throw new Error('未检测到有效时间范围');
  }

  const { hasAmountAgg, hasQuantityAgg } = detectAggregationIntent(query);
  
  // 假设有 sales 表和 date 字段（实际需要结合 schema 动态生成）
  const sql = hasAmountAgg
    ? `SELECT SUM(amount) as total_amount FROM sales WHERE date BETWEEN '${timeInfo.startDate}' AND '${timeInfo.endDate}'`
    : hasQuantityAgg
      ? `SELECT COUNT(*) as total_count FROM sales WHERE date BETWEEN '${timeInfo.startDate}' AND '${timeInfo.endDate}'`
      : `SELECT COUNT(*) as record_count FROM sales WHERE date BETWEEN '${timeInfo.startDate}' AND '${timeInfo.endDate}'`;

  return {
    sql,
    explanation: `基于时间范围规则生成：${timeInfo.startDate} → ${timeInfo.endDate}`
  };
}

/**
 * 应用规则化解析策略
 * 
 * 步骤：
 * 1. 检测时间范围模式
 * 2. 检测聚合意图
 * 3. 生成简化版 SQL（供 runLiveQuery 进一步加工）
 */
export async function applyRuleBasedResolution(
  query: string,
  context: { dsId?: string }
): Promise<FallbackResult> {
  const startTime = Date.now();
  
  try {
    // Step 1: 检测时间范围
    const timeInfo = detectTimeRange(query);
    if (!timeInfo.detected) {
      throw new Error('未检测到时间范围模式');
    }

    // Step 2: 检测聚合意图
    const aggInfo = detectAggregationIntent(query);

    // Step 3: 生成 SQL
    const dsId = context.dsId || 'unknown';
    const result = generateTimeRangeSQL(query, dsId);

    // 记录审计日志
    console.log(`[Rule-based Fallback] Generated SQL in ${Date.now() - startTime}ms`, {
      queryLength: query.length,
      sqlLength: result.sql.length,
      timeRange: `${timeInfo.startDate} -> ${timeInfo.endDate}`
    });

    return {
      success: true,
      strategy: 'rule_based',
      sql: result.sql,
      explanation: result.explanation
    };

  } catch (error) {
    console.warn('[Rule-based Fallback] Strategy failed:', error instanceof Error ? error.message : error);
    throw error;
  }
}
