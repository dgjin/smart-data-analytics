/**
 * 帮助文档读取（文档定位与读取的唯一入口，v0.9.88 自 routes/help.ts 迁出）：
 * - 用户使用指南（面向终端用户回答「系统怎么用」），缺失时回退《系统功能说明书》；
 * - 更新日志（按版本记录主要更新内容，供用户备查）；
 * - 架构图（v0.9.100 帮助中心「架构图」页签；v0.9.101 起改用 docs/diagrams/ 下 archify 生成的
 *   自包含交互式 HTML 视图器为单一事实源，前端 iframe 内嵌，可缩放 / 切换主题 / 导出）。
 * GET 文档/架构图端点与帮助中心「智能问答」（POST /api/help/ask）共用本模块。
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

// ---------- 架构图（v0.9.100 帮助中心「架构图」页签） ----------

export interface DiagramSpec {
  id: string;
  title: string;
  description: string;
  filename: string;
}

/** 帮助中心「架构图」页签展示的三张核心图（docs/diagrams/ 交互式 HTML 产物为单一事实源，重新生成后帮助内自动跟随） */
export const DIAGRAM_SPECS: DiagramSpec[] = [
  {
    id: 'derivation',
    title: '智能问数推导过程图',
    description: '从自然语言提问、语义理解与 SQL 生成到结果解读的完整推导链路',
    filename: '智能问数推导过程图.html',
  },
  {
    id: 'func-flow',
    title: '系统功能流程图',
    description: '数据接入、问数分析、报表导出与系统管理的功能全流程',
    filename: '系统功能流程图.html',
  },
  {
    id: 'architecture',
    title: '完整系统架构图',
    description: '前端应用、Express 服务、数据层、LLM 引擎与自动运维的整体架构',
    filename: '完整系统架构图.html',
  },
];

/** 图文件候选路径：docs/diagrams/（与帮助文档同款双环境回退策略） */
export function diagramCandidatePaths(name: string): string[] {
  return [
    path.join(__dirname, '..', '..', 'docs', 'diagrams', name),
    path.join(__dirname, '..', '..', '..', 'docs', 'diagrams', name),
    path.join(process.cwd(), 'docs', 'diagrams', name),
  ];
}

export interface DiagramItem extends DiagramSpec {
  /** 产物是否存在（false 时前端按单图降级展示，仅全缺才 404） */
  available: boolean;
  /** 自包含交互式 HTML 视图器全文（带 data-embed 嵌入标记，前端经 iframe srcDoc 渲染） */
  html: string | null;
  updatedAt: string | null;
}

/**
 * 注入 archify「嵌入模式」标记（v0.9.101）：给产物 <html> 开标签补 data-embed="true"，
 * 视图器据此收紧内边距 / 隐藏页头副标题与引导卡 / 精简重动画，适配帮助面板内嵌场景。
 * 仅替换首个 `<html `（产物中唯一的真实开标签），开标签已含标记时原样返回（幂等）。
 */
function withEmbedFlag(html: string): string {
  if (/<html[^>]*\sdata-embed=/i.test(html)) return html;
  return html.replace('<html ', '<html data-embed="true" ');
}

/** 读取三张核心图的交互式 HTML（复用 readDoc 的缺失容忍：单图失败标记 available=false，不抛错） */
export function readDiagrams(): DiagramItem[] {
  return DIAGRAM_SPECS.map((spec) => {
    const doc = readDoc(diagramCandidatePaths(spec.filename));
    return {
      ...spec,
      available: doc !== null,
      html: doc ? withEmbedFlag(doc.markdown) : null,
      updatedAt: doc?.updatedAt ?? null,
    };
  });
}
