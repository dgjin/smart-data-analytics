import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.local / .env before reading any process.env values
dotenv.config({ path: path.join(__dirname, '.env.local') });
dotenv.config({ path: path.join(__dirname, '.env') });

import { initSchema } from './server/db';
import { authMiddleware, requireRole } from './server/auth';
import { llmEngineLabel, llmEngineInfo, listAvailableModels } from './server/llmClient';
import { summarizeLlmUsage } from './server/llmUsage';
import { startChainCleanupScheduler, cleanupExpiredIntermediateTables } from './server/analysisChain';
import { requestLogger } from './server/requestLogger';
import authRoutes from './server/routes/auth';
import adminRoutes from './server/routes/admin';
import datasourceRoutes from './server/routes/datasources';
import knowledgeRoutes from './server/routes/knowledge';
import sqlExampleRoutes from './server/routes/sqlExamples';
import metricRoutes from './server/routes/metrics';
import skillRoutes from './server/routes/skills';
import queryContextRoutes from './server/routes/queryContext';
import helpRoutes from './server/routes/help';
// P1-4 路由拆分：问数主链路 / 对话历史 / 报告三条业务线从本文件迁出
import queryRoutes from './server/routes/query';
import conversationRoutes from './server/routes/conversation';
import reportRoutes from './server/routes/report';

// LLM 通道（Ollama/Gemini）统一收敛在 server/llmClient.ts
// Input safety limits 已由 server/queryGuard.ts 接管（L1 输入层：500 字截断 + 注入拒绝）
// Rate limiter lives in ./server/rateLimiter (shared with route modules)
// 问数上下文加载（scope 白名单 + 敏感过滤 + 5min 缓存）在 ./server/schemaContext
// 问数/报告双链路实现：./server/liveQuery + simulatedQuery、./server/liveReport + simulatedReport

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  // Default to loopback-only for local development safety; set HOST=0.0.0.0 to expose.
  const HOST = process.env.HOST || '127.0.0.1';
  const isProd = process.env.NODE_ENV === 'production';

  // P0 生产安全检查：关键密钥缺失直接拒绝启动（fail-fast），
  // 防止 JWT 落到 dev 默认密钥被伪造 token（数据源凭据加密缺省时也依赖 JWT_SECRET）。
  if (isProd && !process.env.JWT_SECRET) {
    console.error('[Security] 生产环境必须设置 JWT_SECRET 环境变量，拒绝启动');
    process.exit(1);
  }

  // Initialize MySQL schema & seed data before accepting traffic
  await initSchema();

  // M3 中间表清洗链：启动时先清理一次过期中间表，之后每小时定时清理
  startChainCleanupScheduler();
  cleanupExpiredIntermediateTables().catch((err) => console.warn('[Chain] 启动清理失败:', err?.message || err));

  const jsonParser2mb = express.json({ limit: '2mb' });
  // M4 报告导出 body 含图表 base64 PNG，单独放宽（该路由自带 20mb 解析器），其余接口维持 2mb
  app.use((req, res, next) => (req.path === '/api/report/export' ? next() : jsonParser2mb(req, res, next)));

  // P0 安全响应头（等价 helmet 核心项，零依赖）；CSP 仅生产启用（Vite dev/HMR 依赖内联脚本）
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (isProd) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'"
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

  // 1d. API Endpoint: P2-4 LLM 用量统计（近 N 天按引擎/模型聚合，多引擎成本对比；仅管理员）
  app.get('/api/system/llm-usage', authMiddleware, requireRole('ADMIN'), async (req, res) => {
    try {
      const days = Number(req.query.days) || 7;
      const usage = await summarizeLlmUsage(days);
      res.json({ days, usage });
    } catch (err) {
      console.error('[LlmUsage] summarize failed:', err);
      res.status(500).json({ error: '用量统计获取失败' });
    }
  });

  // 2. Auth / RBAC / Data source management routes
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/datasources', datasourceRoutes);
  // Legacy alias: /api/datasource/test-connection -> /api/datasources/test-connection
  app.use('/api/datasource', datasourceRoutes);
  app.use('/api/knowledge', knowledgeRoutes);
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

  // Vite development middleware or production static handling
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`[Smart Data Analytics Engine] Running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}

startServer();
