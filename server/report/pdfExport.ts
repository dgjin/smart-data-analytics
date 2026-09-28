/**
 * v0.5.3 报告 PDF 导出：调用 Python ReportLab 子进程生成原生排版 PDF。
 * 替代前端 html2canvas 截图方案（错位/遮挡/oklch 不兼容等问题根治）：
 * 文本矢量排版（中文用内置 CID 字体 STSong-Light），图表 PNG 由前端截取嵌入。
 *
 * 安全设计：
 * - 数据经 stdin 管道传递（不进命令行参数，无注入面）
 * - 脚本路径白名单候选（非用户可控）
 * - 超时强制 kill（默认 60s），防止子进程挂起占用连接
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 双环境获取模块目录：开发（tsx/ESM）下 __filename 不存在，走 import.meta.url；
// esbuild 打包 CJS 后 import.meta 会被置为空对象（import.meta.url = undefined），必须走 CJS 模块作用域的 __filename。
// 注意：不能用 `typeof __dirname !== 'undefined' ? __dirname : ...` 的 const 自引用写法（TDZ 直接抛 ReferenceError）。
const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url));

/** 脚本路径候选：开发（server/pdfgen/）与打包（dist/ 上一级项目根）双环境 */
function resolveScriptPath(fileName: string): string | null {
  const candidates = [
    path.join(__dirname, 'pdfgen', fileName),
    path.join(__dirname, '..', 'server', 'pdfgen', fileName),
    path.join(process.cwd(), 'server', 'pdfgen', fileName),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** 解析报告 PDF 脚本路径（report_pdf.py）；不存在返回 null（部署环境缺 Python 资产时路由层优雅降级） */
export function resolvePdfScriptPath(): string | null {
  return resolveScriptPath('report_pdf.py');
}

/** 解析问数结果 PDF 脚本路径（query_pdf.py，v0.9.82）；不存在返回 null */
export function resolveQueryPdfScriptPath(): string | null {
  return resolveScriptPath('query_pdf.py');
}

/** 环境探测：python3 + reportlab 是否可用（供测试跳过与路由健康检查） */
export function checkPdfEnv(): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    // 探测需覆盖真实生成路径的关键导入链（reportlab.lib.colors → utils → PIL）；
    // 仅 import reportlab 顶层存在盲区：reportlab 懒加载时顶层可导入但子模块（PIL 等）在精简环境下可能失败，
    // 导致探测假阳性、生成才报错（husky pre-push 实测踩坑）
    const child = spawn('python3', ['-c', "import reportlab; from reportlab.lib.colors import HexColor; from PIL import Image; print(reportlab.Version)"], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGKILL'); resolve({ ok: false, reason: 'python3 探测超时' }); }
    }, 8000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, reason: 'python3 不可用' }); }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code === 0 && out.trim().length > 0 ? { ok: true } : { ok: false, reason: 'reportlab 未安装（pip install reportlab）' });
      }
    });
  });
}

/**
 * 调用 ReportLab 脚本生成 PDF（通用主体，v0.9.82 抽出供报告/问数双脚本复用）。
 * stdin 传 JSON（文档数据），stdout 收 PDF 二进制；非 0 退出码视为失败并带 stderr 摘要。
 */
function runPdfScript(script: string | null, missingScriptMessage: string, data: unknown, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!script) {
      reject(new Error(missingScriptMessage));
      return;
    }
    let payload: string;
    try {
      payload = JSON.stringify(data);
    } catch {
      reject(new Error('PDF 导出数据序列化失败'));
      return;
    }

    const child = spawn('python3', [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`PDF 生成超时（>${timeoutMs / 1000}s）`));
      }
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => errChunks.push(d));
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`PDF 生成进程启动失败：${err.message}`));
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
      if (code !== 0) {
        reject(new Error(`PDF 生成失败（退出码 ${code}）：${stderr.slice(0, 200)}`));
        return;
      }
      const pdf = Buffer.concat(chunks);
      if (pdf.length === 0 || pdf.subarray(0, 5).toString() !== '%PDF-') {
        reject(new Error(`PDF 生成失败：输出非法（${stderr.slice(0, 200) || '空输出'}）`));
        return;
      }
      resolve(pdf);
    });

    child.stdin.write(payload, (err) => {
      if (err && !settled) {
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error(`PDF 生成数据写入失败：${err.message}`));
        return;
      }
      child.stdin.end();
    });
  });
}

/** 报告 PDF：调用 report_pdf.py 生成（报告卡片导出链路） */
export function runPdfGenerator(data: unknown, timeoutMs = 60000): Promise<Buffer> {
  return runPdfScript(resolvePdfScriptPath(), 'PDF 生成脚本不存在（server/pdfgen/report_pdf.py 缺失）', data, timeoutMs);
}

/** 问数结果 PDF：调用 query_pdf.py 生成（v0.9.82 问数结果导出链路） */
export function runQueryPdfGenerator(data: unknown, timeoutMs = 60000): Promise<Buffer> {
  return runPdfScript(resolveQueryPdfScriptPath(), 'PDF 生成脚本不存在（server/pdfgen/query_pdf.py 缺失）', data, timeoutMs);
}
