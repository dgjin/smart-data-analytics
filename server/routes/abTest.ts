/**
 * A/B Test Analytics API Routes
 * 
 * 提供实验统计数据查询和历史记录查看接口
 */

import { Router, Request, Response } from 'express';
import { authMiddleware, requireRole } from '../auth/auth.js';
import { getExperimentStats, queryExperimentRecords } from '../utils/abTest.js';

const router = Router();

/**
 * GET: 获取 A/B Test 统计数据（管理员权限）
 * @param days 统计天数范围（默认最近 7 天）
 */
router.get(
  '/stats',
  authMiddleware,
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const days = parseInt(req.query.days as string) || 7;
      
      const stats = await getExperimentStats(days);
      
      if ('error' in stats) {
        return res.status(500).json({ 
          success: false, 
          error: stats.error 
        });
      }
      
      res.json({
        success: true,
        data: stats,
      });
    } catch (err: any) {
      console.error('[ABTest Stats Error]', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);

/**
 * GET: 查询历史实验记录（管理员权限）
 * @param limit 返回条数限制（默认 100 条）
 */
router.get(
  '/records',
  authMiddleware,
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      
      const records = await queryExperimentRecords(limit);
      
      res.json({
        success: true,
        data: records,
        count: records.length,
      });
    } catch (err: any) {
      console.error('[ABTest Records Error]', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);

/**
 * GET: 快速概览（最近 24 小时）
 */
router.get(
  '/overview',
  authMiddleware,
  requireRole('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const stats = await getExperimentStats(1); // 最近 1 天
      
      if ('error' in stats) {
        return res.status(500).json({ 
          success: false, 
          error: stats.error 
        });
      }
      
      // 计算关键指标对比
      const groupA = stats.groups.rule_based || {};
      const groupB = stats.groups.human_approval || {};
      
      const improvement = groupB.successRate && groupA.successRate 
        ? ((groupB.successRate - groupA.successRate) / groupA.successRate * 100).toFixed(2)
        : '0';
      
      const latencyImprovement = groupB.avgLatencyMs && groupA.avgLatencyMs
        ? ((groupA.avgLatencyMs - groupB.avgLatencyMs) / groupA.avgLatencyMs * 100).toFixed(2)
        : '0';
      
      res.json({
        success: true,
        data: {
          ...stats,
          keyMetrics: {
            totalRequests: (groupA.totalRequests || 0) + (groupB.totalRequests || 0),
            successRateGap: parseFloat(improvement as string),
            latencyImprovement: parseFloat(latencyImprovement as string),
            recommendedStrategy: groupB.successRate > groupA.successRate ? 'human_approval' : 'rule_based',
          },
        },
      });
    } catch (err: any) {
      console.error('[ABTest Overview Error]', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);

export default router;
