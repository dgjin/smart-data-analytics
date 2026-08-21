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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 脚本路径候选：开发（server/pdfgen/）与打包（dist/ 上一级项目根）双环境 */
const PDF_SCRIPT_CANDIDATES = [
  path.join(__dirname, 'pdfgen', 'report_pdf.py'),
  path.join(__dirname, '..', 'server', 'pdfgen', 'report_pdf.py'),
  path.join(process.cwd(), 'server', 'pdfgen', 'report_pdf.py'),
];

/** 解析 ReportLab 脚本路径；不存在返回 null（部署环境缺 Python 资产时路由层优雅降级） */
export function resolvePdfScriptPath(): string | null {
  for (const p of PDF_SCRIPT_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** 环境探测：python3 + reportlab 是否可用（供测试跳过与路由健康检查） */
export function checkPdfEnv(): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', 'import reportlab; print(reportlab.Version)'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
 * 调用 ReportLab 脚本生成 PDF。
 * stdin 传 JSON（报告数据），stdout 收 PDF 二进制；非 0 退出码视为失败并带 stderr 摘要。
 */
export function runPdfGenerator(data: unknown, timeoutMs = 60000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const script = resolvePdfScriptPath();
    if (!script) {
      reject(new Error('PDF 生成脚本不存在（server/pdfgen/report_pdf.py 缺失）'));
      return;
    }
    let payload: string;
    try {
      payload = JSON.stringify(data);
    } catch {
      reject(new Error('报告数据序列化失败'));
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
