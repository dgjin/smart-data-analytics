/**
 * Simpler Prompt Fallback 策略实现
 * 
 * 适用场景：阶段二 LLM 失败后的降级生成
 * 核心策略：
 * 1. 简化 Schema 提示（仅关键表和字段）
 * 2. 添加对话历史作为 few-shot 示例
 * 3. 更直白的自然语言引导
 * 优点：提高复杂查询的成功率，降低幻觉
 * 缺点：可能丢失部分语义信息
 */

import type { FallbackResult } from '../fallback/types.js';
import { callLLMJson, ChatMessage } from '../../llm/llmClient.js';
import { logger } from '../../infra/logger.js';

/**
 * 简化 Schema 提取策略（仅保留关键表和字段）
 */
export function extractMinimalSchema(schema: any[]): string[] {
  // 仅返回用户最常访问的 5-10 张表
  const KEY_TABLES = ['sales', 'customers', 'products', 'orders', 'users'];
  const minimalSchema = schema.filter((table: any) => 
    KEY_TABLES.some(key => table.table_name?.toLowerCase().includes(key))
  );
  
  return minimalSchema.map(table => 
    `${table.table_name}: ${table.columns?.map((c: any) => c.column_name).join(', ') || ''}`
  );
}

/**
 * 构建 Few-Shot 对话历史（最近 3 条成功问答）
 */
export async function buildFewShotHistory(
  dataSourceId: string,
  userId: string,
  maxCount: number = 3
): Promise<string> {
  try {
    // TODO: 待 conversation_history 表创建后启用真实数据
    // 当前返回模拟示例
    return `
【Few-Shot 示例】
Q: "上个月的销售额是多少？"
A: SELECT SUM(amount) as total_sales FROM sales WHERE date >= '2024-08-01' AND date <= '2024-08-31'

Q: "哪个客户购买了最多产品？"
A: SELECT customer_id, COUNT(*) as purchase_count FROM orders GROUP BY customer_id ORDER BY purchase_count DESC LIMIT 1

【继续生成新 SQL】
    `.trim();
  } catch (err) {
    logger.warn('[SimplerPrompt] Failed to build few-shot history:', err instanceof Error ? err.message : err);
    return '';
  }
}

/**
 * 构建简化版 Prompt
 */
export function buildSimplerPrompt(
  query: string,
  minimalSchema: string[],
  fewShot: string
): string {
  return `你是一位数据分析专家，请根据以下简化的数据库结构生成 SELECT-only SQL。

${fewShot}

【数据库结构（简化版）】
${minimalSchema.join('\n')}

【用户问题】
${query}

要求：
1. 只生成标准 SQL，不要包含解释文字
2. 使用上述表结构和字段名
3. 如果无法确定，返回空字符串
4. 确保 SQL 符合 MySQL 语法规范`;
}

/**
 * 应用 Simplier Prompt 策略
 */
export async function applySimplerPromptStrategy(
  query: string,
  context: {
    schema?: any[];
    history?: any[];
    dsId?: string;
    userId?: string;
  }
): Promise<FallbackResult> {
  const startTime = Date.now();
  
  try {
    // Step 1: 提取简化 schema
    const minimalSchema = context.schema ? extractMinimalSchema(context.schema) : [];
    
    // Step 2: 构建 few-shot 历史
    const fewShot = await buildFewShotHistory(
      context.dsId || '',
      context.userId || '',
      3
    );
    
    // Step 3: 构建 prompt
    const prompt = buildSimplerPrompt(query, minimalSchema, fewShot);
    
    // Step 4: 调用 LLM
    logger.info('[SimplerPrompt] Calling LLM with simplified prompt', {
      queryLength: query.length,
      schemaSize: minimalSchema.length,
      fewShotPresent: !!fewShot
    });
    
    const resultString = await callLLMJson(
      'You are a SQL expert. Generate only SELECT-only SQL.',
      prompt,
      []
    );
    
    let result: { sql: string };
    try {
      result = JSON.parse(resultString);
    } catch (err) {
      throw new Error('LLM returned invalid JSON: ' + err);
    }
    
    if (!result.sql) {
      throw new Error('LLM returned empty SQL');
    }
    
    const latency = Date.now() - startTime;
    logger.info('[SimplerPrompt] LLM generated SQL successfully', {
      latency,
      sqlLength: result.sql.length
    });
    
    return {
      success: true,
      strategy: 'simpler_prompt',
      sql: result.sql.trim(),
      explanation: `简化 Prompt + Few-Shot 策略生成 (${latency}ms)`
    };
    
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('[SimplerPrompt] Strategy failed:', err.message);
    throw err;
  }
}
