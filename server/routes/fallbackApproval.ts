import { Router, Request, Response } from 'express';
import { getPool } from '../infra/db.js';
import { authMiddleware, requireRole } from '../auth/auth.js';
import { UserRole } from '../../src/types/analytics.js';

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

/** 列表查询（管理员） */
router.get('/', authMiddleware, requireRole('ADMIN'), async (req: Request, res: Response) => {
  try {
    const [samples] = await getPool().query(`
      SELECT * FROM adversarial_samples 
      ORDER BY created_at DESC
    `) as any[];

    const resultSamples = (Array.isArray(samples) ? samples : []).map((s: any): AdversarialSample => ({
      id: s.id,
      original_query: s.original_query,
      original_sql: s.original_sql,
      error_message: s.error_message,
      data_source_id: s.data_source_id,
      user_id: s.user_id,
      annotation_status: s.annotation_status || 'PENDING',
      expected_sql: s.expected_sql,
      resolved_strategy: s.resolved_strategy,
      created_at: s.created_at,
    }));

    res.json({ success: true, samples: resultSamples });
  } catch (err: any) {
    console.error('[Admin] Fallback Approval Load Error:', err);
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
            
      // 若被采纳，自动注入 Few-Shot 学习库（可选扩展：写入知识库系统）
      if (action === 'approve') {
        const sampleSet = batch.filter(id => id > 0);
        if (sampleSet.length > 0) {
          const sampleQuery = await getPool().query(`
            SELECT original_query, expected_sql 
            FROM adversarial_samples 
            WHERE id IN (${placeholders})
          `, [status, timestamp, ...sampleSet]);
                
          const samples = sampleQuery[0] as any[];
          samples.forEach(s => {
            // TODO: 调用知识库服务，注入 Few-Shot 示例
            console.log(`[FewShot] Injecting approved sample:`, s);
          });
        }
      }
    }

    res.json({ success: true, message: `${ids.length} 个样本已${action === 'approve' ? '采纳' : '拒绝'}` });
  } catch (err: any) {
    console.error('[Admin] Batch Action Error:', err);
    res.status(500).json({ error: '批量操作失败：' + err.message });
  }
});

/** 单个审核（标注期望 SQL） */
router.put('/:id/review', authMiddleware, requireRole('ADMIN'), async (req: Request, res: Response) => {
  const { id } = req.params;
  const { expected_sql, status }: { expected_sql?: string; status: 'APPROVED' | 'REJECTED' } = req.body;

  try {
    // 先查询当前状态
    const [current] = await getPool().query(`
      SELECT annotation_status FROM adversarial_samples WHERE id = ?
    `) as any[];

    if (current.length === 0) {
      return res.status(404).json({ error: '样本不存在' });
    }

    const sample = current[0];
    if (sample.annotation_status !== 'PENDING') {
      return res.status(400).json({ error: '该样本已被处理，无法修改' });
    }

    const timestamp = new Date().toISOString();
    
    // PENDING → IN_REVIEW（中间态）
    await getPool().query(`
      UPDATE adversarial_samples 
      SET annotation_status = 'IN_REVIEW', updated_at = ?
      WHERE id = ?
    `, [timestamp, id]);

    // 最终状态确认（带 expected_sql 更新）
    if (expected_sql && status === 'APPROVED') {
      await getPool().query(`
        UPDATE adversarial_samples 
        SET annotation_status = ?, expected_sql = ?, resolved_strategy = 'human_approval', updated_at = ?
        WHERE id = ?
      `, [status, expected_sql, timestamp, id]);
    } else {
      await getPool().query(`
        UPDATE adversarial_samples 
        SET annotation_status = ?, updated_at = ?
        WHERE id = ?
      `, [status, timestamp, id]);
    }

    res.json({ success: true, message: '审核成功' });
  } catch (err: any) {
    console.error('[Admin] Review Sample Error:', err);
    res.status(500).json({ error: '审核失败：' + err.message });
  }
});

export default router;
