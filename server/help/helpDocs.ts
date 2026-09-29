/**
 * 帮助文档读取（文档定位与读取的唯一入口，v0.9.88 自 routes/help.ts 迁出）：
 * - 用户使用指南（面向终端用户回答「系统怎么用」），缺失时回退《系统功能说明书》；
 * - 更新日志（按版本记录主要更新内容，供用户备查）。
 * GET 文档端点与帮助中心「智能问答」（POST /api/help/ask）共用本模块。
 * 兼容两种运行形态：
 * - 开发（tsx server.ts）：__dirname 为项目根/server/help
 * - 打包（node dist/server.cjs）：__dirname 为 dist/，文档经 process.cwd() 兜底定位
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 双环境获取模块目录：开发（tsx/ESM）下 __filename 不存在，走 import.meta.url；
// esbuild 打包 CJS 后 import.meta 会被置为空对象（import.meta.url = undefined），必须走 CJS 模块作用域的 __filename。
// 不能用 `typeof __dirname !== 'undefined' ? ...` 的 const 自引用写法（TDZ ReferenceError）。
const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url));

// 按优先级排列：用户使用指南（面向操作）优先，功能说明书（面向规格）兜底
export const MANUAL_FILENAMES = ['用户使用指南.md', '系统功能说明书.md'];
export const CHANGELOG_FILENAME = '更新日志.md';

// 候选路径：server/help -> server -> 项目根；以及打包后 dist -> 项目根。
// v0.9.79 起核心文档迁入 docs/核心文档/ 独立目录，旧路径保留兜底（兼容历史部署目录结构）。
export function candidatePathsFor(name: string): string[] {
  return [
    path.join(__dirname, '..', '..', 'docs', '核心文档', name),
    path.join(__dirname, '..', '..', '..', 'docs', '核心文档', name),
    path.join(process.cwd(), 'docs', '核心文档', name),
    path.join(__dirname, '..', '..', 'docs', name),
    path.join(__dirname, '..', '..', '..', 'docs', name),
    path.join(process.cwd(), 'docs', name),
  ];
}
export function candidatePaths(): string[] {
  return MANUAL_FILENAMES.flatMap(candidatePathsFor);
}

export function readDoc(paths: string[]): { markdown: string; updatedAt: string } | null {
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

export function readManual(): { markdown: string; updatedAt: string } | null {
  return readDoc(candidatePaths());
}
