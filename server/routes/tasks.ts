/**
 * v0.9.2 异步任务查询路由（改进计划 2-1，挂载于 /api/tasks 前缀下）：
 * - GET /mine           我的最近任务列表（状态/进度/结果摘要）
 * - GET /:id            单任务状态（JSON 类任务 SUCCESS 时内联返回 result）
 * - GET /:id/download   文件类任务（PDF）结果下载
 * 鉴权：仅任务提交人本人或 ADMIN 可见/可下载。
 */
import { Router } from 'express';
import { existsSync } from 'node:fs';
import { authMiddleware } from '../auth';
import { getTask, listUserTasks } from '../taskQueue';
import { taskResultFile } from '../taskHandlers';

const router = Router();

router.get('/mine', authMiddleware, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 20;
    const tasks = await listUserTasks(req.user!.id, limit);
    return res.json({ tasks });
  } catch (err) {
    console.error('[Tasks] list failed:', err);
    return res.status(500).json({ error: '任务列表获取失败' });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const task = await getTask(String(req.params.id));
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.userId !== req.user!.id && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: '无权查看他人任务' });
    }
    // 文件类任务不内联二进制结果，提示走下载端点
    const result = task.result as any;
    if (result?.file === true) {
      const { file: _omit, ...meta } = result;
      return res.json({ ...task, result: { ...meta, downloadUrl: `/api/tasks/${task.id}/download` } });
    }
    return res.json(task);
  } catch (err) {
    console.error('[Tasks] get failed:', err);
    return res.status(500).json({ error: '任务状态获取失败' });
  }
});

router.get('/:id/download', authMiddleware, async (req, res) => {
  try {
    const task = await getTask(String(req.params.id));
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.userId !== req.user!.id && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: '无权下载他人任务结果' });
    }
    if (task.status !== 'SUCCESS') {
      return res.status(409).json({ error: task.status === 'FAILED' ? `任务失败：${task.error}` : '任务尚未完成' });
    }
    const result = task.result as any;
    if (result?.file !== true) {
      return res.status(400).json({ error: '该任务结果不是文件，请从任务详情读取' });
    }
    const file = taskResultFile(task.id);
    if (!existsSync(file)) {
      return res.status(410).json({ error: '结果文件已被清理，请重新发起任务' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(String(result.filename || 'report.pdf'))}`);
    return res.sendFile(file);
  } catch (err) {
    console.error('[Tasks] download failed:', err);
    return res.status(500).json({ error: '任务结果下载失败' });
  }
});

export default router;
