/**
 * v0.9.2 长任务队列（改进计划 2-1）：MySQL 任务表 + 内置 worker，不引入外部 MQ。
 *
 * 场景：报告生成（双阶段 LLM 链，分钟级）、问数报告、PDF 导出（Python 子进程）。
 * 同步端点长时间占用 HTTP 连接与用户并发槽，且实例重启任务即丢失；
 * 队列化后提交即返回 taskId，worker 独立并发执行，前端轮询获取结果。
 *
 * 隔离设计：
 * - worker 并发上限 TASK_WORKER_CONCURRENCY（默认 2），与交互问数互不争抢用户并发槽；
 * - 任务内 SQL 执行走分析链连接池（见 sqlExecutor 连接池分级）；
 * - 每用户在途任务上限 TASK_QUEUE_USER_MAX（默认 3），防排队风暴。
 *
 * 崩溃恢复：RUNNING 任务心跳（默认每 5s）超时 90s 视为孤儿，
 * attempts < 2 自动回 PENDING 重跑，否则标 FAILED（不静默丢任务）。
 */
import { randomUUID } from 'node:crypto';
import type mysql from 'mysql2/promise';
import { getPool } from './db';

export type TaskType = 'report_generate' | 'report_generate_from_query' | 'report_export_pdf';
export type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface AsyncTask {
  id: string;
  type: TaskType;
  status: TaskStatus;
  userId: number;
  username: string;
  progress: string;
  error: string;
  attempts: number;
  result?: unknown;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** 任务处理器：payload 为提交时快照；reportProgress 更新进度文案并顺带心跳 */
export type TaskHandler = (
  payload: any,
  ctx: { taskId: string; reportProgress: (text: string) => Promise<void> },
) => Promise<unknown>;

const handlers = new Map<TaskType, TaskHandler>();

export function registerTaskHandler(type: TaskType, handler: TaskHandler): void {
  handlers.set(type, handler);
}

/** 配置（环境变量可覆盖，非法值回退默认） */
export function taskWorkerConcurrency(): number {
  const n = Number(process.env.TASK_WORKER_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.min(10, Math.floor(n)) : 2;
}
export function taskUserQueueMax(): number {
  const n = Number(process.env.TASK_QUEUE_USER_MAX);
  return Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : 3;
}
export function taskHeartbeatTimeoutMs(): number {
  const n = Number(process.env.TASK_HEARTBEAT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 10000 ? n : 90_000;
}
export function taskExecTimeoutMs(): number {
  const n = Number(process.env.TASK_EXEC_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 30_000 ? n : 10 * 60_000;
}

/** 孤儿任务重试上限：超过后不再回队列，标 FAILED 防无限循环 */
export const TASK_MAX_ATTEMPTS = 2;

/** 建表（幂等；由 initSchema 调用） */
export async function ensureTaskTable(pool?: mysql.Pool): Promise<void> {
  const p = pool ?? getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS async_tasks (
      id VARCHAR(48) PRIMARY KEY,
      type VARCHAR(32) NOT NULL,
      status ENUM('PENDING','RUNNING','SUCCESS','FAILED') NOT NULL DEFAULT 'PENDING',
      user_id INT NOT NULL,
      username VARCHAR(50) NOT NULL DEFAULT '',
      payload_json MEDIUMTEXT,
      result_json MEDIUMTEXT NULL,
      error VARCHAR(500) NOT NULL DEFAULT '',
      progress VARCHAR(100) NOT NULL DEFAULT '',
      attempts INT NOT NULL DEFAULT 0,
      worker_id VARCHAR(64) NOT NULL DEFAULT '',
      heartbeat_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      started_at TIMESTAMP NULL DEFAULT NULL,
      finished_at TIMESTAMP NULL DEFAULT NULL,
      INDEX idx_tasks_status (status, created_at),
      INDEX idx_tasks_user (user_id, created_at),
      INDEX idx_tasks_heartbeat (status, heartbeat_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  // 存量迁移：id 列放宽到 48（task_<uuid> 为 41 字符；MODIFY 幂等）
  try {
    await p.query('ALTER TABLE async_tasks MODIFY COLUMN id VARCHAR(48) NOT NULL');
  } catch {
    // 列已是目标宽度或表刚创建时跳过
  }
}

/** 提交任务：同用户在途（PENDING/RUNNING）超上限时拒绝，返回 null 由路由转 429 */
export async function submitTask(
  type: TaskType,
  payload: unknown,
  user: { id: number; username: string },
  pool?: mysql.Pool,
): Promise<{ taskId: string } | null> {
  const p = pool ?? getPool();
  const [rows] = await p.query(
    "SELECT COUNT(*) AS cnt FROM async_tasks WHERE user_id = ? AND status IN ('PENDING','RUNNING')",
    [user.id]
  );
  if (Number((rows as any[])[0]?.cnt) >= taskUserQueueMax()) return null;
  const taskId = `task_${randomUUID()}`;
  await p.query(
    'INSERT INTO async_tasks (id, type, status, user_id, username, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
    [taskId, type, 'PENDING', user.id, user.username, JSON.stringify(payload ?? {})]
  );
  return { taskId };
}

/**
 * 原子领取下一个待执行任务（MySQL 8 SKIP LOCKED：多 worker/多实例不会重复领取）。
 * 无任务返回 null。
 */
export async function claimNextTask(workerId: string, pool?: mysql.Pool): Promise<{ id: string; type: TaskType; payload: any } | null> {
  const p = pool ?? getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      "SELECT id, type, payload_json, attempts FROM async_tasks WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
    );
    const row = (rows as any[])[0];
    if (!row) {
      await conn.commit();
      return null;
    }
    await conn.query(
      "UPDATE async_tasks SET status = 'RUNNING', worker_id = ?, started_at = COALESCE(started_at, NOW()), heartbeat_at = NOW(), attempts = attempts + 1 WHERE id = ?",
      [workerId, row.id]
    );
    await conn.commit();
    let payload: any = {};
    try {
      payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
    } catch {
      payload = {};
    }
    return { id: String(row.id), type: row.type as TaskType, payload };
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

export async function heartbeatTask(taskId: string, workerId: string, progress?: string, pool?: mysql.Pool): Promise<void> {
  const p = pool ?? getPool();
  if (progress !== undefined) {
    await p.query('UPDATE async_tasks SET heartbeat_at = NOW(), progress = ? WHERE id = ? AND worker_id = ?', [progress.slice(0, 100), taskId, workerId]);
  } else {
    await p.query('UPDATE async_tasks SET heartbeat_at = NOW() WHERE id = ? AND worker_id = ?', [taskId, workerId]);
  }
}

export async function completeTask(taskId: string, result: unknown, pool?: mysql.Pool): Promise<void> {
  const p = pool ?? getPool();
  await p.query(
    "UPDATE async_tasks SET status = 'SUCCESS', result_json = ?, progress = '', finished_at = NOW() WHERE id = ?",
    [JSON.stringify(result ?? null), taskId]
  );
}

export async function failTask(taskId: string, error: string, pool?: mysql.Pool): Promise<void> {
  const p = pool ?? getPool();
  await p.query(
    "UPDATE async_tasks SET status = 'FAILED', error = ?, finished_at = NOW() WHERE id = ?",
    [String(error || '任务执行失败').slice(0, 500), taskId]
  );
}

/**
 * 孤儿任务回收：RUNNING 且心跳超时 → attempts 未超限回 PENDING 重跑，否则 FAILED。
 * 启动时调用一次 + worker 周期巡检。返回回收数量（观测用）。
 */
export async function recoverOrphanTasks(pool?: mysql.Pool, timeoutMs = taskHeartbeatTimeoutMs()): Promise<number> {
  const p = pool ?? getPool();
  const [rows] = await p.query(
    "SELECT id, attempts FROM async_tasks WHERE status = 'RUNNING' AND heartbeat_at < NOW() - INTERVAL ? SECOND",
    [Math.ceil(timeoutMs / 1000)]
  );
  const orphans = rows as any[];
  for (const row of orphans) {
    if (Number(row.attempts) < TASK_MAX_ATTEMPTS) {
      await p.query(
        "UPDATE async_tasks SET status = 'PENDING', worker_id = '', progress = '服务重启后重新排队' WHERE id = ?",
        [row.id]
      );
    } else {
      await p.query(
        "UPDATE async_tasks SET status = 'FAILED', error = '服务重启导致任务中断（已达最大重试次数）', finished_at = NOW() WHERE id = ?",
        [row.id]
      );
    }
  }
  return orphans.length;
}

/** 行记录 → API 出参（result 仅 SUCCESS 时解析下发；鉴权在路由层） */
export function toAsyncTask(row: any): AsyncTask {
  let result: unknown;
  if (row.status === 'SUCCESS' && row.result_json != null) {
    try {
      result = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json;
    } catch {
      result = null;
    }
  }
  return {
    id: String(row.id),
    type: row.type,
    status: row.status,
    userId: Number(row.user_id),
    username: String(row.username || ''),
    progress: String(row.progress || ''),
    error: String(row.error || ''),
    attempts: Number(row.attempts || 0),
    ...(result !== undefined ? { result } : {}),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at ? String(row.finished_at) : null,
  };
}

export async function getTask(taskId: string, pool?: mysql.Pool): Promise<AsyncTask | null> {
  const p = pool ?? getPool();
  const [rows] = await p.query('SELECT * FROM async_tasks WHERE id = ?', [taskId]);
  const row = (rows as any[])[0];
  return row ? toAsyncTask(row) : null;
}

export async function listUserTasks(userId: number, limit = 20, pool?: mysql.Pool): Promise<AsyncTask[]> {
  const p = pool ?? getPool();
  const [rows] = await p.query(
    'SELECT * FROM async_tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, Math.min(100, Math.max(1, limit))]
  );
  return (rows as any[]).map(toAsyncTask);
}

// ---------------- worker 循环 ----------------

const workerId = `w_${process.pid}_${randomUUID().slice(0, 8)}`;
let workerTimer: NodeJS.Timeout | null = null;
let runningCount = 0;

async function runOneTask(task: { id: string; type: TaskType; payload: any }): Promise<void> {
  const handler = handlers.get(task.type);
  if (!handler) {
    await failTask(task.id, `未注册的任务类型：${task.type}`);
    return;
  }
  const reportProgress = async (text: string) => {
    await heartbeatTask(task.id, workerId, text).catch(() => undefined);
  };
  // 执行期心跳：长任务（分钟级 LLM 链）默认每 5s 续命，防被孤儿回收误判
  const hbTimer = setInterval(() => {
    void heartbeatTask(task.id, workerId).catch(() => undefined);
  }, 5000);
  // 执行超时兜底：超时后标失败（底层连接/子进程可能仍在，由各自超时机制收敛）
  let timeoutTimer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new Error('任务执行超时')), taskExecTimeoutMs());
  });
  try {
    const result = await Promise.race([handler(task.payload, { taskId: task.id, reportProgress }), timeoutPromise]);
    await completeTask(task.id, result);
    console.log(`[TaskQueue] ${task.type} ${task.id} 完成`);
  } catch (err: any) {
    await failTask(task.id, err?.message || String(err));
    console.warn(`[TaskQueue] ${task.type} ${task.id} 失败:`, err?.message || err);
  } finally {
    clearInterval(hbTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

async function workerTick(): Promise<void> {
  // 孤儿巡检搭车 worker 周期（低频：约每 15 tick ≈ 30s 一次）
  tickCount += 1;
  if (tickCount % 15 === 1) {
    const recovered = await recoverOrphanTasks().catch(() => 0);
    if (recovered > 0) console.warn(`[TaskQueue] 回收孤儿任务 ${recovered} 个`);
  }
  while (runningCount < taskWorkerConcurrency()) {
    const task = await claimNextTask(workerId);
    if (!task) return;
    runningCount += 1;
    void runOneTask(task).finally(() => {
      runningCount -= 1;
    });
  }
}

let tickCount = 0;

/** 启动 worker（幂等）；先做一次孤儿回收覆盖"停机期间 RUNNING 任务" */
export function startTaskWorker(intervalMs = 2000): void {
  if (workerTimer) return;
  void recoverOrphanTasks().then((n) => {
    if (n > 0) console.warn(`[TaskQueue] 启动回收孤儿任务 ${n} 个`);
  }).catch((err) => console.warn('[TaskQueue] 启动孤儿回收失败:', err?.message || err));
  workerTimer = setInterval(() => {
    void workerTick().catch((err) => console.warn('[TaskQueue] worker tick 失败:', err?.message || err));
  }, intervalMs);
  workerTimer.unref?.();
  console.log(`[TaskQueue] worker 已启动（并发上限 ${taskWorkerConcurrency()}，workerId=${workerId}）`);
}

/** 测试/停机用 */
export function stopTaskWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
