/**
 * Fallback Few-Shot 示例注入与检索服务（v0.9.47 P0 重写）
 *
 * 闭环链路：管理员审批采纳 → injectFewShotSamples 写入独立 few_shot_examples 表 →
 * fallback 策略（simpler_prompt / human_approval）按问题 bigram 相似度检索历史修正 SQL 复用。
 *
 * v0.9.45 版本将示例写入 knowledge_base，但其 INSERT 列（content/doc_type/updated_at）
 * 与该表真实结构（chunk_text，无 doc_type/updated_at）不匹配，且会污染业务知识 RAG 检索，故独立建表。
 */

import { getPool } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import { bigramOverlap } from '../query/queryFeedback.js';

/** Few-Shot 示例条目（检索返回） */
export interface FewShotExample {
  id: number;
  dataSourceId: string;
  question: string;
  expectedSQL: string;
}

/** 注入输入（snake_case，与审批 API 的样本形态一致） */
export interface FewShotInjectionSample {
  original_query: string;
  expected_sql: string;
  data_source_id: string;
  sample_id?: number;
}

/**
 * 将采纳的困难样本注入 few_shot_examples 表（分批插入，每批最多 10 条）
 */
export async function injectFewShotSamples(samples: FewShotInjectionSample[]): Promise<number> {
  const valid = samples.filter((s) => s.original_query && s.expected_sql);
  if (valid.length === 0) return 0;

  const BATCH_SIZE = 10;
  let inserted = 0;

  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const batch = valid.slice(i, i + BATCH_SIZE);

    try {
      const insertPromises = batch.map((sample) =>
        getPool().query(
          `INSERT INTO few_shot_examples (data_source_id, question, expected_sql, sample_source, sample_id)
           VALUES (?, ?, ?, 'fallback_approval', ?)`,
          [sample.data_source_id || 'default', sample.original_query.slice(0, 500), sample.expected_sql, sample.sample_id ?? null]
        )
      );

      await Promise.all(insertPromises);
      inserted += batch.length;
      logger.info('[FewShot] Batch injected:', { count: batch.length });
    } catch (err: any) {
      logger.error('[FewShot] Injection failed:', err.message);
      throw new Error(`Few-Shot 注入失败：${err.message}`, { cause: err });
    }
  }

  logger.info('[FewShot] Completed:', { inserted });
  return inserted;
}

/**
 * 检索相似 Few-Shot 示例：同数据源最近 100 条中按问题 bigram 重合打分
 * （与个人 few-shot 检索同口径，见 conversationHistory.ts），取 top-k。
 * 命中时异步累计 hit_count（失败不影响检索结果）。
 */
export async function retrieveFewShotExamples(
  query: string,
  dataSourceId?: string,
  limit: number = 3
): Promise<FewShotExample[]> {
  try {
    const [rows] = await getPool().query(
      `SELECT id, data_source_id, question, expected_sql FROM few_shot_examples
       WHERE data_source_id = ? ORDER BY id DESC LIMIT 100`,
      [dataSourceId || 'default']
    );

    const scored = (Array.isArray(rows) ? rows : [])
      .map((row: any) => ({
        id: Number(row.id),
        dataSourceId: String(row.data_source_id),
        question: String(row.question),
        expectedSQL: String(row.expected_sql),
        score: bigramOverlap(query, String(row.question)),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));

    if (scored.length > 0) {
      // fire-and-forget：命中计数仅用于运营观察，失败静默
      const ids = scored.map((s) => s.id);
      getPool()
        .query(`UPDATE few_shot_examples SET hit_count = hit_count + 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
        .catch((e: any) => logger.warn('[FewShot] hit_count update failed:', e?.message || e));
    }

    logger.debug('[FewShot] Retrieved:', { count: scored.length });
    return scored.map(({ id, dataSourceId, question, expectedSQL }) => ({ id, dataSourceId, question, expectedSQL }));
  } catch (err: any) {
    logger.error('[FewShot] Retrieval failed:', err.message);
    return [];
  }
}

/**
 * 检索单条最相似示例（human_approval 策略复用入口）：无相似样本返回 null
 */
export async function retrieveBestFewShot(
  query: string,
  dataSourceId?: string
): Promise<{ question: string; sql: string } | null> {
  const [best] = await retrieveFewShotExamples(query, dataSourceId, 1);
  return best ? { question: best.question, sql: best.expectedSQL } : null;
}
