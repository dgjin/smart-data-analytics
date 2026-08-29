import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

// 双环境获取模块目录：开发（tsx/ESM）用 import.meta.url；打包 CJS 时 esbuild 自动降级为 __filename 的 file URL。
// 不能用 `typeof __dirname !== 'undefined' ? ...` 的 const 自引用写法（TDZ ReferenceError）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local / .env before reading any process.env values
dotenv.config({ path: path.join(__dirname, '.env.local') });
dotenv.config({ path: path.join(__dirname, '.env') });

import { initSchema } from './server/db';
import { isRedisEnabled, warmStateStore } from './server/stateStore';
import { authMiddleware, requireRole } from './server/auth';
import { llmEngineLabel, llmEngineInfo, listAvailableModels, startOllamaHealthChecks } from './server/llmClient';
import { summarizeLlmUsage, summarizeLlmUsageByUser } from './server/llmUsage';
import { startChainCleanupScheduler, cleanupExpiredIntermediateTables } from './server/analysisChain';
import { requestLogger } from './server/requestLogger';
import authRoutes from './server/routes/auth';
import adminRoutes from './server/routes/admin';
import datasourceRoutes from './server/routes/datasources';
// P3-1 知识库管理路由（新增）
import knowledgeManageRoutes from './server/routes/knowledge';
import externalKnowledgeRoutes from './server/routes/externalKnowledge';
import sqlExampleRoutes from './server/routes/sqlExamples';
import metricRoutes from './server/routes/metrics';
import skillRoutes from './server/routes/skills';
import queryContextRoutes from './server/routes/queryContext';
import accessRequestRoutes from './server/routes/accessRequests';
import exportRoutes from './server/routes/export';
import helpRoutes from './server/routes/help';
// P1-4 路由拆分：问数主链路 / 对话历史 / 报告三条业务线从本文件迁出
import queryRoutes from './server/routes/query';
import conversationRoutes from './server/routes/conversation';
import reportRoutes from './server/routes/report';
import reportTemplateRoutes from './server/routes/reportTemplates';
import queryReportRoutes from './server/routes/queryReports';
// P0-4 在线准确率度量看板（北极星指标聚合，仅 ADMIN）
import opsMetricsRoutes from './server/routes/opsMetrics';
// v0.9.2 异步任务队列（改进计划 2-1）
import taskRoutes from './server/routes/tasks';
import { startTaskWorker } from './server/taskQueue';
import { registerBuiltinTaskHandlers } from './server/taskHandlers';
// P2-5 SSE 断线续传：重放缓冲周期清扫（改进计划 2-5）
import { startSseReplaySweeper } from './server/sseReplayBuffer';

// LLM 通道（Ollama/Gemini）统一收敛在 server/llmClient.ts
// Input safety limits 已由 server/queryGuard.ts 接管（L1 输入层：500 字截断 + 注入拒绝）
// Rate limiter lives in ./server/rateLimiter (shared with route modules)
// 问数上下文加载（scope 白名单 + 敏感过滤 + 5min 缓存）在 ./server/schemaContext
// 问数/报告双链路实现：./server/liveQuery + simulatedQuery、./server/liveReport + simulatedReport

// 进程级异常兜底：Express 4 不会自动接管 async 路由的 Promise rejection（请求会挂起并触发
// unhandledRejection，Node 15+ 默认直接崩溃退出）。这里记录日志而非崩溃，
// 保证单次链路异常不拖垮整个服务；具体路由已在各自 try/catch 中补齐响应。
process.on('unhandledRejection', (reason) => {
  console.error('[Fatal] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Fatal] uncaughtException:', err);
});

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  // Default to loopback-only for local development safety; set HOST=0.0.0.0 to expose.
  const HOST = process.env.HOST || '127.0.0.1';
  // 生产模式判定：显式 NODE_ENV=production，或直接运行打包产物（node dist/server.cjs，__dirname 位于 dist）
  // —— 避免直接启动构建产物时误入 Vite dev server 分支
  const isProd = process.env.NODE_ENV === 'production' || path.basename(__dirname) === 'dist';

  // P0 生产安全检查：关键密钥缺失直接拒绝启动（fail-fast），
  // 防止 JWT 落到 dev 默认密钥被伪造 token（数据源凭据加密缺省时也依赖 JWT_SECRET）。
  if (isProd && !process.env.JWT_SECRET) {
    console.error('[Security] 生产环境必须设置 JWT_SECRET 环境变量，拒绝启动');
    process.exit(1);
  }

  // Initialize MySQL schema & seed data before accepting traffic
  await initSchema();

  // P2-13 多实例：启动时预热 Redis 连接（消除 offlineQueue 禁用在连接建立窗口内的
  // 限流 fail-closed 429 / 缓存全未命中冷启动抖动）；超时仅告警不阻断（降级路径安全）
  if (isRedisEnabled()) {
    const warm = await warmStateStore(5000);
    if (warm) console.log('[stateStore] Redis ready（多实例共享状态已外置）');
    else console.warn('[stateStore] Redis 预热超时（5s），启动继续——限流将 fail-closed、缓存 fail-open 直至连接恢复');
  }

  // M3 中间表清洗链：启动时先清理一次过期中间表，之后每小时定时清理
  startChainCleanupScheduler();
  cleanupExpiredIntermediateTables().catch((err) => console.warn('[Chain] 启动清理失败:', err?.message || err));

  // v0.9.2 长任务队列（改进计划 2-1）：注册处理器 + 启动内置 worker（含孤儿任务恢复）
  registerBuiltinTaskHandlers();
  startTaskWorker();
  // v0.9.3 LLM 多后端（改进计划 2-2）：Ollama 后端池健康检查（摘除节点自动恢复接入）
  startOllamaHealthChecks();
  // P2-5 SSE 断线续传：重放缓冲周期清扫（终态 TTL 10 分钟 / 进行中 30 分钟）
  startSseReplaySweeper();

  const jsonParser2mb = express.json({ limit: '2mb' });
  const jsonParser10mb = express.json({ limit: '10mb' });
  // M4 报告导出与 v0.9.2 异步 PDF 导出 body 含图表 base64 PNG，单独放宽（路由自带 20mb 解析器），其余接口维持 2mb；
  // 知识库导入 body 为整份 JSON 备份文件（含全部知识文档原文），单独放宽至 10mb
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/report/export')) return next();
    if (req.path === '/api/knowledge/import') return jsonParser10mb(req, res, next);
    return jsonParser2mb(req, res, next);
  });

  // P0 安全响应头（等价 helmet 核心项，零依赖）；CSP 仅生产启用
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    
    if (isProd) {
      // 生产环境 CSP - 允许内联脚本和 eval（需要运行时动态注入）
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'"
      );
    } else {
      // 开发环境 CSP - 更宽松，允许 HMR 和内联脚本
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*; font-src 'self';"
      );
    }
    
    next();
  });

  // P2 可观测性：requestId + API 访问日志（位于鉴权之前，被拒请求同样有留痕）
  app.use(requestLogger);

  console.log(`[AI Engine] ${llmEngineLabel()}`);

  // 1. API Endpoint: Health check (public)
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // 1b. API Endpoint: 当前 AI 引擎信息（登录用户；前端按实际模型展示提示，不暴露内网地址）
  app.get('/api/system/engine', authMiddleware, (_req, res) => {
    res.json(llmEngineInfo());
  });

  // 1c. API Endpoint: 可选模型目录（供用户自选；Ollama 实时列已安装模型，qwen/gemini 按密钥配置列入）
  app.get('/api/system/models', authMiddleware, async (_req, res) => {
    try {
      const models = await listAvailableModels();
      res.json({ models });
    } catch (err) {
      console.error('[Models] list failed:', err);
      res.status(500).json({ error: '模型目录获取失败' });
    }
  });

  // 1d. API Endpoint: P2-4 LLM 用量统计（近 N 天按引擎/模型 + 按用户聚合，多引擎成本对比与用户消耗审计；仅管理员）
  app.get('/api/system/llm-usage', authMiddleware, requireRole('ADMIN'), async (req, res) => {
    try {
      const days = Number(req.query.days) || 7;
      const [usage, byUser] = await Promise.all([summarizeLlmUsage(days), summarizeLlmUsageByUser(days)]);
      res.json({ days, usage, byUser });
    } catch (err: any) {
      console.error('[LlmUsage] summarize failed:', err?.message || err);
      res.status(500).json({ error: '用量统计获取失败' });
    }
  });

  // 2. Auth / RBAC / Data source management routes
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/datasources', datasourceRoutes);
  // P3-1 知识库管理路由（新增）
  app.use('/api/knowledge', knowledgeManageRoutes);
  // Legacy alias: /api/datasource/test-connection -> /api/datasources/test-connection
  app.use('/api/datasource', datasourceRoutes);
  // 外部知识库接入（接口配置仅 ADMIN；问数链路自动检索注入）
  app.use('/api/knowledge-external', externalKnowledgeRoutes);
  app.use('/api/metrics', metricRoutes);
  app.use('/api/sql-examples', sqlExampleRoutes);
  app.use('/api/skills', skillRoutes);
  app.use('/api/query', queryContextRoutes);
  app.use('/api/help', helpRoutes);

  // 3/3a-3e/3b-1/3b-2. P1-4 拆分：问数主链路与衍生端点（见 server/routes/query.ts）
  app.use('/api/query', queryRoutes);
  // 对话历史管理（见 server/routes/conversation.ts）
  app.use('/api/conversations', conversationRoutes);
  // 4/4-pre/4a. 报告生成/计划/导出（见 server/routes/report.ts）
  app.use('/api/report', reportRoutes);
  // v0.5.0 报告模板管理（见 server/routes/reportTemplates.ts）
  app.use('/api/report-templates', reportTemplateRoutes);
  // v0.5.0 智能问数报告中心（见 server/routes/queryReports.ts）
  app.use('/api/query-reports', queryReportRoutes);
  // P0-4 在线准确率度量看板（见 server/routes/opsMetrics.ts）
  app.use('/api/ops', opsMetricsRoutes);
  // P2-11 权限申请审批流（见 server/routes/accessRequests.ts）
  app.use('/api/access-requests', accessRequestRoutes);
  // P2-12 DLP 统一导出通道（CSV 水印 + 下载审批，见 server/routes/export.ts）
  app.use('/api/export', exportRoutes);
  // v0.9.2 异步任务查询/下载（见 server/routes/tasks.ts）
  app.use('/api/tasks', taskRoutes);

  // API 兜底 404：所有未匹配的 /api/* 请求（任意方法）统一返回 JSON，
  // 避免 Express 默认 404 HTML 页面导致前端 res.json() 抛出 "Unexpected token '<', <!DOCTYPE..."
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  // 全局错误兜底：任何路由/中间件抛出的异常统一返回 JSON（含 body 解析失败等），
  // 避免 Express 默认错误处理返回 HTML 错误页
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    const status = Number(err?.status) || Number(err?.statusCode) || 500;
    console.error('[Fatal] unhandled route error:', err?.message || err);
    res.status(status).json({ error: err?.message || '服务器内部错误' });
  });

  // Vite development middleware or production static handling
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // SPA fallback：必须在所有 API 路由之后注册（/api 404 已在上文处理），其余路径回退 index.html
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`[Smart Data Analytics Engine] Running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}

startServer();
