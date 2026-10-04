/**
 * v0.9.94 前端错误上报（日志评估 P2-12）：window.onerror / unhandledrejection 采样回流。
 *
 * - POST /api/ops/client-errors  接收前端全局错误。刻意匿名可报（登录页错误也须回流），
 *   故不在 requireOpsAccess 保护范围（挂载于 /api/ops 系列 router 之前，避免被其鉴权拦截）；
 *   防护依靠：IP 固定分钟窗口限流（getStateStore.incrWindow——多实例 Redis 共享，
 *   内存模式单机回退；独立限额，错误爆发不挤占全局 RATE_LIMIT_MAX 桶）+ 字段全量截断。
 * - 事件归集：recordOpsEvent（source=client / category=FRONTEND / severity=ERROR），
 *   同页面同键错误 15 分钟窗口自动合并（dedup_count 计次），不灌表不刷屏。
 * - 日志落盘（v0.9.96 修订）：上报摘要改走 logger.warn（stderr → app_server.log →
 *   ship_app_logs → Loki），使前端异常进入自动运维智能体 triage 证据链——此前 debug
 *   不落盘导致白屏类故障证据缺失、根因置信度恒低于闸门 1 阈值被转人工；
 *   防噪仍由双端限流 + 15 分钟事件合并兜底。
 * - 一切异常 fail-open：限流/归集失败绝不影响前端（上报本身是旁路数据，丢失无害）。
 */
import { Router } from 'express';
import { recordOpsEvent } from '../infra/opsEvents';
import { getStateStore } from '../infra/stateStore';
import { logger } from '../infra/logger';

const router = Router();

/** 独立限额（条/分钟/IP）：前端错误低频，20 足够；超限说明前端在错误风暴中，丢弃上报防放大 */
const CLIENT_ERROR_MAX_PER_MINUTE = 20;

function truncate(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

router.post('/', async (req, res) => {
  // 限流：固定分钟窗口；存储异常 fail-open（上报丢失可接受，不可挡死前端）
  try {
    const ip = req.ip || 'unknown';
    const bucket = Math.floor(Date.now() / 60_000);
    const n = await getStateStore().incrWindow(`ce:${ip}:${bucket}`, 70);
    if (n > CLIENT_ERROR_MAX_PER_MINUTE) {
      return res.status(429).json({ error: '上报过于频繁，请稍后再试' });
    }
  } catch {
    /* fail-open */
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const message = truncate(body.message, 500).trim();
  if (!message) return res.status(400).json({ error: 'message 必填' });

  // 事件实体（去重键）：优先前端标注的页面标识（如当前功能 Tab——本应用为无 URL 路由 SPA，
  // pathname 恒为 /，前端标注才有页面区隔度）；缺省回退 URL pathname（去 query/hash）
  let page = truncate(body.page, 128).trim();
  if (!page) {
    page = truncate(body.url, 500);
    try {
      if (page) page = new URL(page).pathname;
    } catch {
      /* 相对路径等非完整 URL：保留原文 */
    }
  }

  recordOpsEvent({
    source: 'client',
    category: 'FRONTEND',
    severity: 'ERROR',
    message,
    entityType: 'page',
    entityId: page.slice(0, 128),
    detail: {
      file: truncate(body.source, 300),
      lineno: Number(body.lineno) || 0,
      colno: Number(body.colno) || 0,
      stack: truncate(body.stack, 2000),
      userAgent: truncate(body.userAgent, 300),
      version: truncate(body.version, 40),
    },
  });
  logger.warn(`[ClientError] ${message}${page ? ` @ ${page}` : ''}`);
  return res.json({ success: true });
});

export default router;
