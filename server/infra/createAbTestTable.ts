/**
 * Database Migration: Create A/B Test Experiment Table
 * 
 * 用于记录每次 fallback 决策的实验分组和效果数据
 * 表名：fallback_ab_tests
 */

import { getPool } from './db.js';
import { logger } from './logger.js';

export async function createAbTestTable(): Promise<void> {
  const connection = await getPool().getConnection();
  
  try {
    await connection.beginTransaction();
    
    // 创建 A/B Test 实验记录表
    await connection.query(`
      CREATE TABLE IF NOT EXISTS fallback_ab_tests (
        id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        experiment_id VARCHAR(64) NOT NULL UNIQUE COMMENT '实验 ID (UUID)',
        query TEXT NOT NULL COMMENT '原始用户查询',
        failed_sql VARCHAR(1024) NOT NULL COMMENT '失败的初始 SQL',
        assigned_group ENUM('A', 'B') NOT NULL COMMENT '分配组别：A=Rule-Based, B=Human Approval',
        selected_strategy VARCHAR(50) NOT NULL COMMENT '实际使用的策略',
        success TINYINT(1) DEFAULT 0 COMMENT '是否成功 (0/1)',
        latency_ms INT UNSIGNED DEFAULT 0 COMMENT '延迟 (毫秒)',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
        
        INDEX idx_created_at (created_at),
        INDEX idx_assigned_group (assigned_group),
        INDEX idx_success (success),
        INDEX idx_experiment_id (experiment_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT='A/B Test 实验记录表 - 对比不同 fallback 策略的效果'
    `);
    
    // 检查索引是否存在
    const [indexes] = await connection.query(`
      SHOW INDEX FROM fallback_ab_tests
    `) as any[];
    
    console.log('[ABTest DB] Table fallback_ab_tests ensured exists');
    console.log('[ABTest DB] Indexes:', indexes?.map((idx: any) => idx.Key_name).join(', ') || 'none');
    
    await connection.commit();
  } catch (err: any) {
    await connection.rollback();
    logger.error('[ABTest DB] Failed to create table:', err);
    throw err;
  } finally {
    connection.release();
  }
}

// 如果直接运行此文件（非导入），自动执行创建
if (require.main === module) {
  createAbTestTable()
    .then(() => {
      console.log('✅ A/B Test table creation completed!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Failed to create A/B Test table:', err.message);
      process.exit(1);
    });
}
