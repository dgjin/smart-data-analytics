import { Router, Request, Response } from 'express';
import { getPool } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import { authMiddleware, requireRole } from '../auth/auth.js';
import { injectFewShotSamples } from '../utils/fewShotService.js';
import { prioritizePendingSamples, SamplePriorityScore } from '../utils/activeLearning.js';

const router = Router();

/** 困难样本类型定义 */
interface AdversarialSample {
  id: number;
  original_query: string;
  original_sql: string;
  error_message: string;
  data_source_id: string;
  user_id: number;
  annotation_status: 'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED';
  expected_sql: string | null;
  resolved_strategy: string | null;
  created_at: Date;
}

/** 列表查询（管理员） - 按优先级分数排序 */
router.get('/', authMiddleware, requireRole('ADMIN'), async (req: Request, res: Response) => {
  try {
    const samples = await prioritizePendingSamples();

    if (samples.length === 0) {
      return res.json({ success: true, samples: [], message: '暂无待审核样本' });
    }

    // 响应简化版本（前端不需要所有内部字段）
    const responseSamples = samples.map((s): any => ({
      id: s.id,
      original_query: s.originalQuery,
      original_sql: s.originalSQL,
      error_message: s.errorMessage,
      data_source_id: s.dataSourceId,
      user_id: s.userId,
      annotation_status: s.annotationStatus,
      expected_sql: s.expectedSQL,
      resolved_strategy: s.resolvedStrategy,
      created_at: s.createdAt,
      // Priority scores
      total_score: s.totalScore,
      rank: s.rank,
    }));

    res.json({ 
      success: true, 
      samples: responseSamples,
      priorityInfo: {
        totalCount: samples.length,
        topScore: samples[0].totalScore,
        avgScore: Math.round(samples.reduce((sum, s) => sum + s.totalScore, 0) / samples.length),
        sortingMethod: 'active_learning_multi_factor',
      },
    });
  } catch (err: any) {
    logger.error('[Admin] Fallback Approval Load Error:', err);
    res.status(500).json({ error: '加载样本失败：' + err.message });
  }
});

/** 批量操作（approve/reject） */
router.post('/batch', authMiddleware, requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { ids, action }: { ids: number[]; action: 'approve' | 'reject' } = req.body;
  
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '无效的参数' });
  }

  try {
    // 分批更新（防止 SQL 过长）
    const BATCH_SIZE = 10;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
            
      const status = action === 'approve' ? 'APPROVED' : 'REJECTED';
      const timestamp = new Date().toISOString();
            
      // PENDING → APPROVED/REJECTED
      await getPool().query(`
        UPDATE adversarial_samples 
        SET annotation_status = ?, updated_at = ?
        WHERE id IN (${placeholders}) AND annotation_status = 'PENDING'
      `, [status, timestamp, ...batch]);
            
      // 若被采纳，自动注入 Few-Shot 学习库
      if (action === 'approve') {
        const sampleSet = batch.filter(id => id > 0);
        if (sampleSet.length > 0) {
          // v0.9.47 P0 修复：占位符按 sampleSet 重建（原按 batch 构建，filter 后数量不匹配）；
          // 参数对齐 [status, timestamp, ...] 多余错位已移除（原前两个参数顶替了 id 位置）
          const samplePlaceholders = sampleSet.map(() => '?').join(',');
          const sampleQuery = await getPool().query(`
            SELECT id, original_query, expected_sql, data_source_id 
            FROM adversarial_samples 
            WHERE id IN (${samplePlaceholders})
          `, [...sampleSet]);
                
          const samples = (sampleQuery[0] as any[])
            // 只注入带修正 SQL 的样本（批量采纳未填 expected_sql 的跳过，避免注入空示例）
            .filter((s: any) => s.expected_sql)
            .map((s: any) => ({
              original_query: s.original_query,
              expected_sql: s.expected_sql,
              data_source_id: s.data_source_id,
              sample_id: s.id,
            }));
          
          if (samples.length > 0) {
            try {
              await injectFewShotSamples(samples);
            } catch (err: any) {
              logger.error('[FallbackApproval] Few-Shot injection failed:', err.message);
              // Fail-open: 不影响审批流程的返回
            }
          }
        }
      }
    }

    res.json({ success: true, message: `${ids.length} 个样本已${action === 'approve' ? '采纳' : '拒绝'}` });
  } catch (err: any) {
    logger.error('[Admin] Batch Action Error:', err);
    res.status(500).json({ error: '批量操作失败：' + err.message });
  }
});

/** 单个审核（标注期望 SQL） */
router.put('/:id/review', authMiddleware, requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { expected_sql, status }: { expected_sql?: string; status: 'APPROVED' | 'REJECTED' } = req.body;

  try {
    // 先查询当前状态
    // v0.9.47 P0 修复：原 SELECT 有 ? 占位符但未传 [id] 参数 → ？原样发给 MySQL 必然 500
    const [current] = await getPool().query(`
      SELECT id, original_query, data_source_id, annotation_status FROM adversarial_samples WHERE id = ?
    `, [id]) as any[];

    if (current.length === 0) {
      return res.status(404).json({ error: '样本不存在' });
    }

    const sample = current[0];
    if (sample.annotation_status !== 'PENDING') {
      return res.status(400).json({ error: '该样本已被处理，无法修改' });
    }

    const timestamp = new Date().toISOString();
    
    // v0.9.47 P0 修复：原"先置 IN_REVIEW 再终态"两步非原子（无事务，第二步失败会卡死中间态），
    // 合并为单步原子 UPDATE（WHERE 带状态条件，并发重复处理时 affectedRows=0）
    if (expected_sql && status === 'APPROVED') {
      const [updateResult] = await getPool().query(`
        UPDATE adversarial_samples 
        SET annotation_status = ?, expected_sql = ?, resolved_strategy = 'human_approval', updated_at = ?
        WHERE id = ? AND annotation_status = 'PENDING'
      `, [status, expected_sql, timestamp, id]) as any[];

      if (updateResult.affectedRows === 0) {
        return res.status(409).json({ error: '该样本已被其他管理员处理' });
      }

      // 审核通过的修正 SQL 同步注入 Few-Shot 示例库（fail-open，不影响审批结果）
      try {
        await injectFewShotSamples([{
          original_query: String((current[0] as any).original_query ?? ''),
          expected_sql,
          data_source_id: String((current[0] as any).data_source_id ?? ''),
          sample_id: Number(id),
        }]);
      } catch (err: any) {
        logger.error('[FallbackApproval] Few-Shot injection failed:', err.message);
      }
    } else {
      const [updateResult] = await getPool().query(`
        UPDATE adversarial_samples 
        SET annotation_status = ?, updated_at = ?
        WHERE id = ? AND annotation_status = 'PENDING'
      `, [status, timestamp, id]) as any[];

      if (updateResult.affectedRows === 0) {
        return res.status(409).json({ error: '该样本已被其他管理员处理' });
      }
    }

    res.json({ success: true, message: '审核成功' });
  } catch (err: any) {
    logger.error('[Admin] Review Sample Error:', err);
    res.status(500).json({ error: '审核失败：' + err.message });
  }
});

export default router;
