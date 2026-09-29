/**
 * v0.9.84 首启初始化向导路由（挂载于 /api/setup，设计见 docs/首启初始化向导交互设计20260929.md §6.2）：
 * - GET  /state            向导状态 + 环境汇总（断点续做恢复）
 * - POST /step             保存步骤结果快照（{step,result}）
 * - POST /probe            单项探测（{kind:'llm'|'embedding'}）
 * - POST /pipeline         创建自动初始化流水线任务（{dataSourceId, subtask?} → {taskId}；subtask 仅重跑单个子任务）
 * - GET  /pipeline/:taskId  流水线进度（async_tasks 状态 + 子任务明细合并）
 * - GET  /checklist        待办确认清单（Step④）
 * - POST /skip             暂不提醒（{days}，L2 横幅静默）
 * - POST /complete         完成向导（任一 CTA 触发）
 * 鉴权：全端点 authMiddleware + requireRole('ADMIN')；写操作（POST）经 rateLimiter，
 * 读/轮询端点（state/pipeline/checklist）不挂限流，避免前端 2s 轮询触发 429（限流窗口 30 次/分钟）。
 * 多管理员并发：全局单行状态，后进者见「最近更新于 …」后可接管继续（设计 §七）。
 */
import { Router } from 'express';
import type mysql from 'mysql2/promise';
import { authMiddleware, requireRole } from '../auth/auth';
import { rateLimiter } from '../infra/rateLimiter';
import { ERROR_CODES } from '../infra/errorCodes';
import { logger } from '../infra/logger';
import { getErrorMessage } from '../infra/errorUtils';
import { getPool } from '../infra/db';
import { getTask, submitTask } from '../infra/taskQueue';
import {
  buildChecklist,
  buildSummary,
  collectEnvSummary,
  completeWizard,
  getPipelineSnapshot,
  getWizardState,
  probeEmbedding,
  probeLlm,
  saveStepResult,
  setPipelineTask,
  skipWizardReminder,
} from '../setupWizard';

const router = Router();

// GET /api/setup/state —— 向导状态 + 环境汇总 + 成果数字（前端进入向导 / 刷新恢复 / Step⑤ 总结卡）
router.get('/state', authMiddleware, requireRole('ADMIN'), async (_req, res) => {
  try {
    const [state, env, summary] = await Promise.all([getWizardState(), collectEnvSummary(), buildSummary()]);
    res.json({ ...state, env, summary });
  } catch (err) {
    logger.error(`[Setup] 状态读取失败: ${getErrorMessage(err)}`);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '向导状态获取失败' });
  }
});

// POST /api/setup/step —— 保存步骤结果快照（{step, result}；每步完成/跳过即调用，断点续做）
router.post('/step', rateLimiter, authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const step = Number(req.body?.step);
    if (!Number.isInteger(step) || step < 0 || step > 4) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'step 必须为 0..4 的整数' });
    }
    await saveStepResult(step, req.body?.result ?? {}, req.user!.username);
    return res.json({ ok: true });
  } catch (err) {
    logger.error(`[Setup] 步骤结果保存失败: ${getErrorMessage(err)}`);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '步骤结果保存失败' });
  }
});

// POST /api/setup/probe —— 单项探测（{kind:'llm'|'embedding'}；Step①② 按钮触发）
router.post('/probe', rateLimiter, authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const kind = String(req.body?.kind || '');
    if (kind === 'llm') return res.json(await probeLlm());
    if (kind === 'embedding') return res.json(await probeEmbedding());
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'kind 必须为 llm 或 embedding' });
  } catch (err) {
    logger.error(`[Setup] 探测失败: ${getErrorMessage(err)}`);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '环境探测失败' });
  }
});

// POST /api/setup/pipeline —— 创建自动初始化流水线任务（{dataSourceId, subtask?} → {taskId}；前端 2s 轮询进度）
// subtask 可选：仅重跑单个子任务（失败行内 [重试]），其余已成功子任务不重跑
router.post('/pipeline', rateLimiter, authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const dataSourceId = String(req.body?.dataSourceId || '');
    if (!dataSourceId) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: 'dataSourceId 必填' });
    }
    const subtask = typeof req.body?.subtask === 'string' ? req.body.subtask.slice(0, 40) : '';
    // 防重：同一时刻仅允许一个在途流水线任务（并发执行会互相覆盖 step_results.pipeline 快照）
    const [running] = await getPool().query<mysql.RowDataPacket[]>(
      "SELECT id FROM async_tasks WHERE type = 'setup_pipeline' AND status IN ('PENDING','RUNNING') LIMIT 1",
    );
    if (running[0]) {
      return res.status(409).json({ code: ERROR_CODES.CONFLICT, error: '已有流水线任务执行中，请等待完成后再操作', taskId: String(running[0].id) });
    }
    const [rows] = await getPool().query<mysql.RowDataPacket[]>(
      'SELECT id, name FROM data_sources WHERE id = ? LIMIT 1',
      [dataSourceId],
    );
    if (!rows[0]) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '数据源不存在' });
    }
    const user = req.user!;
    const submitted = await submitTask(
      'setup_pipeline',
      {
        dataSourceId,
        ...(subtask ? { subtask } : {}),
        // worker 侧以提交时快照作审计身份（与报告类任务一致）
        user: { id: user.id, username: user.username, role: user.role, department: user.department },
      },
      { id: user.id, username: user.username },
    );
    if (!submitted) {
      return res.status(429).json({ code: ERROR_CODES.RATE_LIMITED, error: '在途任务过多，请稍后再试' });
    }
    await setPipelineTask(submitted.taskId);
    return res.json({ taskId: submitted.taskId });
  } catch (err) {
    logger.error(`[Setup] 流水线创建失败: ${getErrorMessage(err)}`);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '流水线创建失败' });
  }
});

// GET /api/setup/pipeline/:taskId —— 流水线进度（async_tasks 状态 + 子任务明细；轮询端点不限流）
router.get('/pipeline/:taskId', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    const taskId = String(req.params.taskId);
    const task = await getTask(taskId);
    if (!task || task.type !== 'setup_pipeline') {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '流水线任务不存在' });
    }
    const snapshot = await getPipelineSnapshot();
    return res.json({
      taskId: task.id,
      status: task.status,
      progress: task.progress,
      error: task.error,
      subtasks: snapshot?.subtasks ?? [],
      result: task.status === 'SUCCESS' ? task.result : undefined,
    });
  } catch (err) {
    logger.error(`[Setup] 流水线进度读取失败: ${getErrorMessage(err)}`);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '流水线进度获取失败' });
  }
});

// GET /api/setup/checklist —— 待办确认清单（Step④；五项动态状态 + 深链）
router.get('/checklist', authMiddleware, requireRole('ADMIN'), async (_req, res) => {
  try {
    const items = await buildChecklist();
    res.json(items);
  } catch (err) {
    logger.error(`[Setup] 待办清单构建失败: ${getErrorMessage(err)}`);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '待办清单获取失败' });
  }
});

// POST /api/setup/skip —— 暂不提醒（{days} 默认 7；L2 横幅静默至 skipped_until）
router.post('/skip', rateLimiter, authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    await skipWizardReminder(Number(req.body?.days) || 7);
    return res.json({ ok: true });
  } catch (err) {
    logger.error(`[Setup] 静默设置失败: ${getErrorMessage(err)}`);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '静默设置失败' });
  }
});

// POST /api/setup/complete —— 完成向导（status='completed'；L1/L2 引导永久消失）
router.post('/complete', rateLimiter, authMiddleware, requireRole('ADMIN'), async (req, res) => {
  try {
    await completeWizard(req.user!.username);
    return res.json({ ok: true });
  } catch (err) {
    logger.error(`[Setup] 完成向导失败: ${getErrorMessage(err)}`);
    return res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '完成向导失败' });
  }
});

export default router;
