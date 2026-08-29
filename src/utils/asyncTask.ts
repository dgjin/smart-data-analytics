/**
 * v0.9.2 异步任务轮询（改进计划 2-1）：报告生成/PDF 导出等长任务提交后轮询任务状态。
 * 提交端点返回 202 { taskId }，本模块负责轮询 /api/tasks/:id 直到 SUCCESS/FAILED。
 * 鉴权复用 apiFetch（自动带 Bearer token + 401 会话失效处理）。
 */
import { apiFetch, parseApiErrorBody } from '../api/client';

export interface AsyncTaskStatus {
  id: string;
  type: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';
  progress: string;
  error: string;
  result?: any;
}

export interface PollTaskOptions {
  /** 轮询间隔（默认 2000ms） */
  intervalMs?: number;
  /** 整体超时（默认 12 分钟，覆盖分钟级报告链） */
  timeoutMs?: number;
  /** 进度文案变化回调（用于 UI 阶段提示） */
  onProgress?: (progress: string, status: 'PENDING' | 'RUNNING') => void;
}

/**
 * 轮询任务直到终态。SUCCESS 返回完整任务对象（含 result）；FAILED/超时抛 Error。
 * 网络抖动容忍：连续 5 次请求失败才放弃（轮询期间服务重启可自动恢复）。
 */
export async function pollTask(taskId: string, opts: PollTaskOptions = {}): Promise<AsyncTaskStatus> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 12 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  let lastProgress = '';
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    let task: AsyncTaskStatus | null = null;
    try {
      const resp = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        headers: { Accept: 'application/json' },
      });
      if (resp.status === 404) throw new Error('任务不存在或已被清理');
      if (!resp.ok) {
        const body = await parseApiErrorBody(resp);
        throw new Error(body.error);
      }
      task = (await resp.json()) as AsyncTaskStatus;
      consecutiveErrors = 0;
    } catch (err: any) {
      // 404 与 401（apiFetch 内抛 ApiError）不可恢复，直接抛；其余视为瞬时抖动
      const msg = String(err?.message || '');
      if (msg.includes('任务不存在') || err?.name === 'ApiError') throw err;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) {
        throw new Error(`任务状态查询连续失败：${msg || '网络异常'}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    if (task!.status === 'SUCCESS') return task!;
    if (task!.status === 'FAILED') throw new Error(task!.error || '任务执行失败');

    if (task!.progress && task!.progress !== lastProgress) {
      lastProgress = task!.progress;
      opts.onProgress?.(task!.progress, task!.status as 'PENDING' | 'RUNNING');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('任务等待超时，请稍后在任务列表中查看结果');
}

/**
 * 下载文件类任务结果（PDF 等）：fetch + blob 方式（<a href> 直链不带 Authorization 会 401）。
 * 文件名从 Content-Disposition 解析，失败回退 taskId。
 */
export async function downloadTaskResult(taskId: string): Promise<void> {
  const resp = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/download`);
  if (!resp.ok) {
    const body = await parseApiErrorBody(resp);
    throw new Error(body.error);
  }
  const blob = await resp.blob();
  const disposition = resp.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
  const filename = match ? decodeURIComponent(match[1]) : `${taskId}.pdf`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
