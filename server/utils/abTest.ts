/**
 * A/B Test Framework for Fallback Strategy Comparison
 * 
 * 为每次 fallback 决策分配实验组别，持续监控各策略效果
 * Group A: Rule-Based Strategy
 * Group B: Human Approval (Few-Shot Enhanced)
 */

import { getPool } from '../infra/db.js';
import { logger } from '../infra/logger.js';

/** A/B 实验配置 */
export const AB_TEST_CONFIG = {
  enabled: process.env.AB_TEST_ENABLED === 'true',
  experimentName: 'fallback_strategy_comparison',
  groupNameRuleBased: 'rule_based',     // Group A: Rule-Based
  groupNameHumanApproval: 'human_approval', // Group B: Human Approval + Few-Shot
  trafficSplit: {
    ruleBased: 0.5,        // 50% traffic to Rule-Based
    humanApproval: 0.5,    // 50% traffic to Human Approval
  },
};

/** A/B Test 实验分组结果 */
export interface ABAExperimentResult {
  experimentId: string;           // UUID
  query: string;
  failedSQL: string;
  assignedGroup: 'A' | 'B';       // Group A (Rule-Based) or Group B (Human Approval)
  selectedStrategy: string;
  success: boolean;
  latencyMs: number;
  createdAt: Date;
}

/**
 * 生成新的 A/B Test 实验 ID
 */
export function generateExperimentId(): string {
  return `exp_${Date.now()}_${Math.random().toString(36).substring(7)}_${Math.floor(Math.random() * 1000)}`;
}

/**
 * 根据配置为样本分配实验组别
 */
export function assignExperimentGroup(userId: number): 'A' | 'B' {
  if (!AB_TEST_CONFIG.enabled) {
    return Math.random() < 0.5 ? 'A' : 'B'; // Fallback to random
  }
  
  // 基于 userId + 时间戳的确定性哈希
  const hash = `${userId}-${new Date().toISOString()}`;
  const value = hashCode(hash);
  const splitValue = Math.abs(value % 100) / 100;
  
  // 按配置的流量比例分配
  const threshold = AB_TEST_CONFIG.trafficSplit.ruleBased;
  return splitValue < threshold ? 'A' : 'B';
}

/**
 * Hash 函数（DJB2）
 */
function hashCode(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return hash >>> 0;
}

/**
 * 创建 A/B Test 实验记录（数据库层面）
 */
export async function createExperimentRecord(params: Omit<ABAExperimentResult, 'experimentId' | 'createdAt'>): Promise<string> {
  try {
    const [result] = await getPool().query(`
      INSERT INTO fallback_ab_tests (
        experiment_id, query, failed_sql, assigned_group, 
        selected_strategy, success, latency_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [
      generateExperimentId(),
      params.query,
      params.failedSQL,
      params.assignedGroup,
      params.selectedStrategy,
      params.success,
      params.latencyMs,
    ] as any[]);

    return (result as any).insertId.toString();
  } catch (err: any) {
    logger.error('[ABTest] Create record failed:', err.message);
    throw err;
  }
}

/**
 * 获取当前实验状态和统计数据
 */
export async function getExperimentStats(days: number = 7): Promise<any> {
  try {
    const [statsRows] = await getPool().query(`
      SELECT 
        assigned_group,
        COUNT(*) as total_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
        ROUND(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as success_rate,
        AVG(latency_ms) as avg_latency_ms,
        MIN(latency_ms) as min_latency_ms,
        MAX(latency_ms) as max_latency_ms
      FROM fallback_ab_tests
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY assigned_group
    `, [days]);

    const stats = Array.isArray(statsRows) ? statsRows : [];
    
    return {
      days,
      groups: stats.reduce((acc: any, row: any) => ({
        ...acc,
        [row.assigned_group.toLowerCase()]: {
          totalRequests: row.total_requests,
          successCount: row.success_count,
          successRate: parseFloat(row.success_rate || '0'),
          avgLatencyMs: parseFloat(row.avg_latency_ms?.toFixed(2)) || 0,
          minLatencyMs: row.min_latency_ms,
          maxLatencyMs: row.max_latency_ms,
        },
      }), {}),
    };
  } catch (err: any) {
    logger.error('[ABTest] Get stats failed:', err.message);
    return { error: err.message };
  }
}

/**
 * 查询历史实验记录
 */
export async function queryExperimentRecords(limit: number = 100): Promise<ABAExperimentResult[]> {
  try {
    const [rows] = await getPool().query(`
      SELECT experiment_id, query, failed_sql, assigned_group, 
             selected_strategy, success, latency_ms, created_at
      FROM fallback_ab_tests
      ORDER BY created_at DESC
      LIMIT ?
    `, [limit]) as any[];

    return (Array.isArray(rows) ? rows : []).map((r: any): ABAExperimentResult => ({
      experimentId: r.experiment_id,
      query: r.query,
      failedSQL: r.failed_sql,
      assignedGroup: r.assigned_group.toUpperCase() as 'A' | 'B',
      selectedStrategy: r.selected_strategy,
      success: !!r.success,
      latencyMs: r.latency_ms,
      createdAt: new Date(r.created_at),
    }));
  } catch (err: any) {
    logger.error('[ABTest] Query records failed:', err.message);
    return [];
  }
}
