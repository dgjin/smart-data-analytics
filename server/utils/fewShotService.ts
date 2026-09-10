/**
 * Fallback Few-Shot Knowledge Injection Service
 * 
 * 当人类专家采纳困难样本时，自动将 approved SQL 注入知识库作为 Few-Shot 示例
 * 后续 Simpler Prompt 策略会从知识库中检索相似 query 的历史成功 SQL 作为示例
 */

import { getPool } from '../infra/db.js';
import { logger } from '../infra/logger.js';

/** Few-Shot 知识条目类型 */
export interface FewShotKnowledge {
  dataSourceId: string;
  title: string;
  content: string;       // 原始用户查询 + 修正 SQL 的格式化文本
  metadata: {
    originalQuery: string;
    expectedSQL: string;
    annotationStatus: 'APPROVED';
    resolvedStrategy: 'human_approval';
  };
  createdAt: Date;
}

/**
 * 将批准的困难样本注入 Few-Shot 知识库
 */
export async function injectFewShotSamples(samples: Array<{
  original_query: string;
  expected_sql: string;
  data_source_id: string;
}>): Promise<void> {
  const BATCH_SIZE = 10;
  
  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
    const batch = samples.slice(i, i + BATCH_SIZE);
    
    try {
      // 分批插入每批最多 10 个
      const insertPromises = batch.map(sample => {
        const fewShotContent = `
## User Query
${sample.original_query}

## Correct SQL Response
${sample.expected_sql}

## Data Source
${sample.data_source_id || 'default'}

## Notes
- Resolved via: human_approval
- Status: APPROVED
          `.trim();

        const dataSourceId = sample.data_source_id || 'default';
        const title = `Fallback-SQL-${dataSourceId}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        
        return getPool().query(`
          INSERT INTO knowledge_base (
            data_source_id, title, content, doc_type, created_at, updated_at
          ) VALUES (?, ?, ?, 'FEW_SHOT', NOW(), NOW())
        `, [dataSourceId, title, fewShotContent]);
      });
      
      await Promise.all(insertPromises);
      
      logger.info('[FewShot] Batch injected:', { count: batch.length });
    } catch (err: any) {
      logger.error('[FewShot] Injection failed:', err.message);
      throw new Error(`Few-Shot 注入失败：${err.message}`);
    }
  }

  logger.info('[FewShot] Completed:', { count: samples.length });
}

/**
 * 从知识库中检索 Few-Shot 示例
 */
export async function retrieveFewShotExamples(
  query: string,
  dataSourceId?: string,
  limit: number = 5
): Promise<FewShotKnowledge[]> {
  try {
    const [rows] = await getPool().query(`
      SELECT id, data_source_id, title, content, created_at
      FROM knowledge_base
      WHERE doc_type = 'FEW_SHOT'
        ${dataSourceId ? 'AND data_source_id = ?' : ''}
      ORDER BY created_at DESC
      LIMIT ?
    `, [
      ...(dataSourceId ? [dataSourceId] : []),
      limit,
    ] as any[]);

    const results = (Array.isArray(rows) ? rows : []).map((row: any): FewShotKnowledge => ({
      dataSourceId: row.data_source_id,
      title: row.title,
      content: row.content,
      metadata: {
        originalQuery: '',
        expectedSQL: '',
        annotationStatus: 'APPROVED',
        resolvedStrategy: 'human_approval',
      },
      createdAt: new Date(row.created_at),
    }));

    logger.debug('[FewShot] Retrieved:', { count: results.length });
    return results;
  } catch (err: any) {
    logger.error('[FewShot] Retrieval failed:', err.message);
    return [];
  }
}
