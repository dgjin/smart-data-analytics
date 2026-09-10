/**
 * Simpler Prompt Fallback 策略实现
 * 
 * 适用场景：阶段二 LLM 失败后的降级生成
 * 核心策略：
 * 1. 简化 Schema 提示（仅关键表和字段）
 * 2. 添加真实 few-shot 示例（对抗训练库 + 个人对话沉淀）
 * 3. 更直白的自然语言引导
 * 优点：提高复杂查询的成功率，降低幻觉
 * 缺点：可能丢失部分语义信息
 */

import type { FallbackResult } from '../fallback/types.js';
import { callLLMText } from '../../llm/llmClient.js';
import { logger } from '../../infra/logger.js';
import { retrieveFewShotExamples } from '../fewShotService.js';
import { loadConversationFewShot } from '../../query/conversationHistory.js';

/**
 * 简化 Schema 提取策略（控制 token 预算：前 8 张表、每表前 12 列）
 * v0.9.47 P0 修复：原实现按硬编码 KEY_TABLES 过滤且读 table_name/column_name
 * （真实字段为 name），导致任何数据源都得到空 schema
 */
export function extractMinimalSchema(schema: any[]): string[] {
  const TABLE_BUDGET = 8;
  const COLUMN_BUDGET = 12;
  return schema
    .filter((table: any) => table?.name)
    .slice(0, TABLE_BUDGET)
    .map((table: any) => {
      const cols = (table?.columns || [])
        .slice(0, COLUMN_BUDGET)
        .map((c: any) => c?.name)
        .filter(Boolean);
      return `${table.name}: ${cols.join(', ')}`;
    });
}

/**
 * 构建真实 Few-Shot 对话历史：
 * 一级取对抗训练库（管理员已采纳的困难样本，bigram 相似度检索），
 * 二级补充个人对话沉淀（本人同数据源执行成功的问答对）。
 * v0.9.47 P0 修复：原实现返回硬编码假示例（sales/orders 假表），会误导 LLM
 */
export async function buildFewShotHistory(
  query: string,
  dataSourceId: string,
  userId: string,
  maxCount: number = 3
): Promise<string> {
  try {
    const approved = await retrieveFewShotExamples(query, dataSourceId, 2);
    const uid = parseInt(userId, 10);
    const personal = Number.isFinite(uid)
      ? await loadConversationFewShot(uid, dataSourceId, query).catch(() => [])
      : [];

    const pairs = [
      ...approved.map((s) => ({ question: s.question, sql: s.expectedSQL })),
      ...personal,
    ].slice(0, maxCount);

    if (pairs.length === 0) return '';
    return (
      '【Few-Shot 示例】\n' +
      pairs.map((p) => `Q: "${p.question}"\nA: ${p.sql}`).join('\n\n') +
      '\n\n【参考以上示例风格，生成新 SQL】'
    );
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
${fewShot ? '\n' + fewShot + '\n' : ''}
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
 * 应用 Simpler Prompt 策略
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
    
    // Step 2: 构建真实 few-shot 历史（对抗训练库 + 个人沉淀）
    const fewShot = await buildFewShotHistory(
      query,
      context.dsId || '',
      context.userId || '',
      3
    );
    
    // Step 3: 构建 prompt
    const prompt = buildSimplerPrompt(query, minimalSchema, fewShot);
    
    // Step 4: 调用 LLM（纯文本通道——prompt 要求返回纯 SQL，
    // v0.9.47 P0 修复：原 callLLMJson + JSON.parse 对纯 SQL 文本必然抛错）
    logger.info('[SimplerPrompt] Calling LLM with simplified prompt', {
      queryLength: query.length,
      schemaSize: minimalSchema.length,
      fewShotPresent: !!fewShot
    });
    
    const rawSql = await callLLMText(
      'You are a SQL expert. Generate only a single SELECT-only SQL statement, no explanations, no markdown fences.',
      prompt
    );
    const sql = rawSql.replace(/```(?:sql)?/gi, '').trim();

    if (!sql || !/^select\b/i.test(sql)) {
      throw new Error('LLM returned invalid SQL');
    }
    
    const latency = Date.now() - startTime;
    logger.info('[SimplerPrompt] LLM generated SQL successfully', {
      latency,
      sqlLength: sql.length
    });
    
    return {
      success: true,
      strategy: 'simpler_prompt',
      sql,
      explanation: `简化 Prompt + Few-Shot 策略生成 (${latency}ms)`
    };
    
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('[SimplerPrompt] Strategy failed:', err.message);
    throw err;
  }
}
