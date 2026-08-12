/**
 * 系统帮助路由：实时读取 docs/系统功能说明书.md 并返回给前端渲染。
 * 文档是系统功能的单一事实源，功能更新时同步维护该文件即可，无需改代码。
 * 兼容两种运行形态：
 * - 开发（tsx server.ts）：__dirname 为项目根目录
 * - 打包（node dist/server.cjs）：__dirname 为 dist/，文档在上一级
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authMiddleware } from '../auth';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MANUAL_FILENAME = '系统功能说明书.md';

// 候选路径：server/routes -> server -> 项目根；以及打包后 dist -> 项目根
function candidatePaths(): string[] {
  return [
    path.join(__dirname, '..', '..', 'docs', MANUAL_FILENAME),
    path.join(__dirname, '..', '..', '..', 'docs', MANUAL_FILENAME),
    path.join(process.cwd(), 'docs', MANUAL_FILENAME),
  ];
}

function readManual(): { markdown: string; updatedAt: string } | null {
  for (const p of candidatePaths()) {
    try {
      if (fs.existsSync(p)) {
        const markdown = fs.readFileSync(p, 'utf-8');
        const updatedAt = fs.statSync(p).mtime.toISOString();
        return { markdown, updatedAt };
      }
    } catch {
      // 忽略单个候选失败，继续尝试下一个
    }
  }
  return null;
}

const router = Router();
router.use(authMiddleware);

// GET /api/help/manual —— 返回功能说明书 Markdown 与最后更新时间
router.get('/manual', (_req, res) => {
  const manual = readManual();
  if (!manual) {
    return res.status(404).json({ error: '功能说明书文件不存在，请联系管理员' });
  }
  return res.json(manual);
});

export default router;
