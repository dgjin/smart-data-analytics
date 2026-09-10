/**
 * 主动学习 - PENDING 样本优先级排序算法
 * 
 * 核心思想：通过多因子评分模型对 PENDING 样本进行优先级排序，
 * 优先处理高价值样本以提高 Few-Shot 知识库质量
 */

import { getPool } from '../infra/db.js';
import { logger } from '../infra/logger.js';

/** 样本优先级得分 */
export interface SamplePriorityScore {
  id: number;
  originalQuery: string;
  originalSQL: string;
  errorMessage: string;
  dataSourceId: string;
  userId: number;
  annotationStatus: 'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED';
  expectedSQL: string | null;
  resolvedStrategy: string | null;
  createdAt: Date;
  
  // Priority scores
  ageScore: number;           // 时间衰减分 (0-10)
  frequencyScore: number;     // 高频错误分 (0-30)
  complexityScore: number;    // 查询复杂度分 (0-25)
  diversityScore: number;     // 多样性探索分 (0-10)
  userWeightScore: number;    // 重要用户加权分 (0-25)
  
  totalScore: number;         // 总分 (0-100)
  rank: number;               // 排名
}

/**
 * 计算样本优先级分数并排序
 * @param samples Raw database rows
 * @returns Sorted samples with priority scores
 */
export async function prioritizePendingSamples(): Promise<SamplePriorityScore[]> {
  try {
    // 获取所有 PENDING 样本
    const [pendingRows] = await getPool().query(`
      SELECT id, original_query, original_sql, error_message, data_source_id, user_id, 
             annotation_status, expected_sql, resolved_strategy, created_at
      FROM adversarial_samples
      WHERE annotation_status = 'PENDING'
      ORDER BY created_at DESC
    `) as any[];

    if (!Array.isArray(pendingRows) || pendingRows.length === 0) {
      return [];
    }

    // 统计各数据源的错误频率
    const errorFrequencyMap = new Map<string, number>();
    pendingRows.forEach(row => {
      const key = row.data_source_id || 'default';
      errorFrequencyMap.set(key, (errorFrequencyMap.get(key) || 0) + 1);
    });
    const maxFrequency = Math.max(...Array.from(errorFrequencyMap.values()), 1);

    // 分析各 SQL 模板的出现次数（用于去重）
    const sqlTemplateMap = new Map<string, number>();
    pendingRows.forEach(row => {
      const template = normalizeSQLTemplate(row.original_sql);
      sqlTemplateMap.set(template, (sqlTemplateMap.get(template) || 0) + 1);
    });

    // 为每个样本计算优先级分数
    const now = new Date();
    const scoredSamples: SamplePriorityScore[] = pendingRows.map((row): SamplePriorityScore => {
      const dataSourceId = row.data_source_id || 'default';
      const ageHours = (now.getTime() - new Date(row.created_at).getTime()) / 36e5;
      
      // 1. 时间衰减分 (0-10): 越老的样本分数越高，鼓励尽快审核积压样本
      // exponential decay: score = 10 * e^(-age_hours / half_life), half_life = 24 hours
      const ageScore = Math.min(10, Math.round(10 * Math.exp(-ageHours / 24)));

      // 2. 高频错误分 (0-30): 同一数据源出现次数越多分数越高
      const frequency = errorFrequencyMap.get(dataSourceId) || 1;
      const frequencyScore = Math.round(30 * (frequency / maxFrequency));

      // 3. 查询复杂度分 (0-25): SQL 长度、关键词数量作为复杂度指标
      const complexityScore = Math.round(25 * Math.min(1, row.original_sql.length / 500));

      // 4. 多样性探索分 (0-10): 基于 SQL 模板的唯一性，鼓励覆盖多样场景
      const sqlTemplate = normalizeSQLTemplate(row.original_sql);
      const templateCount = sqlTemplateMap.get(sqlTemplate) || 1;
      const diversityScore = Math.round(10 * (1 - Math.log(templateCount) / Math.log(maxFrequency + 1)));

      // 5. 重要用户加权分 (0-25): 假设 userId 越大权重越高（可根据实际调整）
      const normalizedUserId = row.userId / 1000; // 假设最大用户数 1000
      const userWeightScore = Math.round(25 * normalizedUserId);

      const totalScore = ageScore + frequencyScore + complexityScore + diversityScore + userWeightScore;

      return {
        ...row,
        ageScore,
        frequencyScore,
        complexityScore,
        diversityScore,
        userWeightScore,
        totalScore,
        rank: 0, // 待排序填充
      };
    });

    // 按总分降序排序
    scoredSamples.sort((a, b) => b.totalScore - a.totalScore);
    
    // 填充排名
    scoredSamples.forEach((sample, index) => {
      sample.rank = index + 1;
    });

    logger.info('[ActiveLearning] Prioritized PENDING samples:', {
      count: scoredSamples.length,
      topScore: scoredSamples[0]?.totalScore || 0,
      avgScore: scoredSamples.reduce((sum, s) => sum + s.totalScore, 0) / scoredSamples.length,
    });

    return scoredSamples;
  } catch (err: any) {
    logger.error('[ActiveLearning] Prioritization failed:', err.message);
    return []; // Fail-safe
  }
}

/**
 * 标准化 SQL 模板（去除具体数值和字符串）
 * 示例："SELECT SUM(amount) FROM sales WHERE date='2024-01-01'" 
 *   → "SELECT SUM(?) FROM sales WHERE date=?"
 */
function normalizeSQLTemplate(sql: string): string {
  return sql
    .replace(/\d+/g, '?')         // 数字占位符
    .replace(/'[^']*'/g, '?')     // 单引号字符串占位符
    .replace(/"[^"]*"/g, '?')     // 双引号字符串占位符
    .trim()
    .toUpperCase();
}
