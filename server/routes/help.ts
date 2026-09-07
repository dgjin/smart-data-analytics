/**
 * 系统帮助路由：实时读取 docs 下帮助文档并返回给前端渲染。
 * - GET /manual：用户使用指南（面向终端用户回答「系统怎么用」），缺失时回退《系统功能说明书》；
 * - GET /changelog：更新日志（按版本记录主要更新内容，供用户备查，v0.9.36）。
 * 兼容两种运行形态：
 * - 开发（tsx server.ts）：__dirname 为项目根目录
 * - 打包（node dist/server.cjs）：__dirname 为 dist/，文档在上一级
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authMiddleware } from '../auth/auth';

// 双环境获取模块目录：开发（tsx/ESM）下 __filename 不存在，走 import.meta.url；
// esbuild 打包 CJS 后 import.meta 会被置为空对象（import.meta.url = undefined），必须走 CJS 模块作用域的 __filename。
// 不能用 `typeof __dirname !== 'undefined' ? ...` 的 const 自引用写法（TDZ ReferenceError）。
const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url));

// 按优先级排列：用户使用指南（面向操作）优先，功能说明书（面向规格）兜底
const MANUAL_FILENAMES = ['用户使用指南.md', '系统功能说明书.md'];
const CHANGELOG_FILENAME = '更新日志.md';

// 候选路径：server/routes -> server -> 项目根；以及打包后 dist -> 项目根
function candidatePathsFor(name: string): string[] {
  return [
    path.join(__dirname, '..', '..', 'docs', name),
    path.join(__dirname, '..', '..', '..', 'docs', name),
    path.join(process.cwd(), 'docs', name),
  ];
}
function candidatePaths(): string[] {
  return MANUAL_FILENAMES.flatMap(candidatePathsFor);
}

function readDoc(paths: string[]): { markdown: string; updatedAt: string } | null {
  for (const p of paths) {
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

function readManual(): { markdown: string; updatedAt: string } | null {
  return readDoc(candidatePaths());
}

const router = Router();
router.use(authMiddleware);

// GET /api/help/manual —— 返回功能说明书 Markdown 与最后更新时间
router.get('/manual', (_req, res) => {
  const manual = readManual();
  if (!manual) {
    return res.status(404).json({ error: '使用指南文件不存在，请联系管理员' });
  }
  return res.json(manual);
});

// GET /api/help/changelog —— 返回更新日志 Markdown 与最后更新时间（v0.9.36）
router.get('/changelog', (_req, res) => {
  const changelog = readDoc(candidatePathsFor(CHANGELOG_FILENAME));
  if (!changelog) {
    return res.status(404).json({ error: '更新日志文件不存在，请联系管理员' });
  }
  return res.json(changelog);
});

export default router;
