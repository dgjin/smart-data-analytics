/**
 * P0-1 NL2SQL 准确率评测运行器。
 * 指标定义：执行准确率（Execution Accuracy）= 生成 SQL 与 golden SQL 执行结果集一致的用例占比。
 * 结果集比较采用标准「关系等价」：行内取值排序 + 行间排序（ordered=true 的 Top-N 用例按行序比较），
 * 对列别名/列顺序/等价写法（COUNT(1) vs COUNT(*)）天然宽容，只关心数值正确性。
 * 运行方式：npm run eval -- --limit 5（本地 LLM 单问 1-5 分钟，建议分批跑并留意用户配额）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { executeSafeSql } from '../sqlExecutor';

export interface EvalCase {
  id: string;
  question: string;
  goldenSql: string;
  /** Top-N 类用例结果行序有意义（ORDER BY + LIMIT），按行序比较 */
  ordered?: boolean;
}

export interface EvalSuite {
  dataSourceId: string;
  cases: EvalCase[];
}

export interface EvalCaseResult {
  caseId: string;
  question: string;
  status: 'pass' | 'fail' | 'error' | 'rate-limited';
  reason?: string;
  generatedSql?: string;
  durationMs: number;
}

export interface EvalSummary {
  total: number;
  pass: number;
  fail: number;
  error: number;
  rateLimited: number;
  accuracy: number;
  avgDurationMs: number;
  results: EvalCaseResult[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** 加载并校验评测集；缺 id/question/goldenSql 的用例直接剔除（防止脏用例污染指标） */
export function loadEvalCases(path?: string): EvalSuite {
  const file = path || join(HERE, 'evalCases.json');
  if (!existsSync(file)) throw new Error(`评测集不存在: ${file}`);
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  const dataSourceId = typeof raw?.dataSourceId === 'string' ? raw.dataSourceId : '';
  const cases = (Array.isArray(raw?.cases) ? raw.cases : [])
    .filter(
      (c: any) =>
        c && typeof c.id === 'string' && typeof c.question === 'string' && c.question.trim() &&
        typeof c.goldenSql === 'string' && /^select/i.test(c.goldenSql.trim())
    )
    .map((c: any) => ({
      id: c.id,
      question: c.question.trim(),
      goldenSql: c.goldenSql.trim(),
      ordered: c.ordered === true,
    }));
  if (!dataSourceId) throw new Error('评测集缺少 dataSourceId');
  if (cases.length === 0) throw new Error('评测集为空');
  return { dataSourceId, cases };
}

/** 单元格归一化：数值保留 6 位小数（容忍浮点误差），字符串 trim，空值统一 '' */
export function normalizeCell(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)))) {
    const n = Number(v);
    if (Number.isFinite(n)) return String(Math.round(n * 1e6) / 1e6);
  }
  return String(v).trim();
}

/** 单行归一化为「排序后的取值元组」：忽略列别名与列顺序差异 */
export function normalizeRow(row: any): string {
  if (!row || typeof row !== 'object') return normalizeCell(row);
  return JSON.stringify(Object.keys(row).map((k) => normalizeCell(row[k])).sort());
}

/**
 * 结果集等价比较（关系语义）：
 * - 默认无序多重集比较（排序后逐行比对）
 * - ordered=true 时按行序比较（行内取值仍排序，容忍列序差异）
 */
export function compareRowSets(a: any[], b: any[], ordered = false): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const na = a.map(normalizeRow);
  const nb = b.map(normalizeRow);
  if (!ordered) {
    na.sort();
    nb.sort();
  }
  return na.every((v, i) => v === nb[i]);
}

/** 从 SQL 中提取引用的表名（golden SQL 执行时的白名单，来源可信故从宽） */
export function extractTableNames(sql: string): string[] {
  const out = new Set<string>();
  const re = /(?:from|join)\s+`?([A-Za-z_][\w]*)`?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.add(m[1]);
  return [...out];
}

/** 执行 golden SQL（经安全执行层，与问数链路同口径） */
export async function executeGoldenSql(dataSourceId: string, sql: string): Promise<{ ok: true; rows: any[] } | { ok: false; reason: string }> {
  const tables = extractTableNames(sql).map((name) => ({ name }));
  const res = await executeSafeSql(dataSourceId, sql, tables);
  if (res.ok === false) return { ok: false, reason: res.reason };
  return { ok: true, rows: res.result.rows };
}

export interface RunEvalOptions {
  baseUrl?: string;
  username?: string;
  password?: string;
  dataSourceId?: string;
  /** 仅运行指定用例（逗号分隔 id） */
  caseIds?: string[];
  /** 仅运行前 N 条（分批跑，规避每小时配额） */
  limit?: number;
  perCaseTimeoutMs?: number;
}

/** 执行评测：逐条走 HTTP 问数链路（真实端到端，含防御层/圈表/执行），统计执行准确率 */
export async function runEval(opts: RunEvalOptions = {}): Promise<EvalSummary> {
  const baseUrl = opts.baseUrl || process.env.EVAL_BASE_URL || 'http://127.0.0.1:3000';
  const username = opts.username || process.env.EVAL_USER || 'admin';
  const password = opts.password || process.env.EVAL_PASS || 'admin123';
  const timeoutMs = opts.perCaseTimeoutMs || 10 * 60 * 1000;

  const suite = loadEvalCases();
  const dataSourceId = opts.dataSourceId || suite.dataSourceId;
  let cases = suite.cases;
  if (opts.caseIds && opts.caseIds.length > 0) {
    const ids = new Set(opts.caseIds);
    cases = cases.filter((c) => ids.has(c.id));
  }
  if (opts.limit && opts.limit > 0) cases = cases.slice(0, opts.limit);

  // 登录获取 token
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!loginRes.ok) throw new Error(`评测登录失败: HTTP ${loginRes.status}`);
  const token = String((await loginRes.json())?.token || '');

  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    const startedAt = Date.now();
    const result: EvalCaseResult = { caseId: c.id, question: c.question, status: 'error', durationMs: 0 };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${baseUrl}/api/query/natural-language`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: c.question, dataSourceId }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429) {
        result.status = 'rate-limited';
        result.reason = '触发配额/限流，跳过本用例';
      } else if (!res.ok) {
        result.status = 'error';
        result.reason = `HTTP ${res.status}`;
      } else {
        const data: any = await res.json();
        const rows = data?.result?.rows;
        if (!data?.success || !Array.isArray(rows)) {
          result.status = 'error';
          result.reason = data?.error || '响应缺少结果行';
        } else {
          result.generatedSql = String(data?.result?.finalSql || data?.executedSql || '');
          const golden = await executeGoldenSql(dataSourceId, c.goldenSql);
          if (golden.ok === false) {
            result.status = 'error';
            result.reason = `golden SQL 执行失败: ${golden.reason}`;
          } else if (compareRowSets(rows, golden.rows, c.ordered)) {
            result.status = 'pass';
          } else {
            result.status = 'fail';
            result.reason = `结果集不一致（生成 ${rows.length} 行 / golden ${golden.rows.length} 行）`;
          }
        }
      }
    } catch (err: any) {
      result.status = 'error';
      result.reason = err?.name === 'AbortError' ? `超时（>${Math.round(timeoutMs / 1000)}s）` : String(err?.message || err);
    }
    result.durationMs = Date.now() - startedAt;
    results.push(result);
    // 逐条即时输出，便于长耗时评测观察进度
    console.log(`[eval] ${c.id} ${result.status.padEnd(12)} ${(result.durationMs / 1000).toFixed(1)}s ${result.reason || ''}`);
  }

  const pass = results.filter((r) => r.status === 'pass').length;
  const summary: EvalSummary = {
    total: results.length,
    pass,
    fail: results.filter((r) => r.status === 'fail').length,
    error: results.filter((r) => r.status === 'error').length,
    rateLimited: results.filter((r) => r.status === 'rate-limited').length,
    accuracy: results.length > 0 ? pass / results.length : 0,
    avgDurationMs: results.length > 0 ? Math.round(results.reduce((s, r) => s + r.durationMs, 0) / results.length) : 0,
    results,
  };

  const reportPath = join(HERE, `eval-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, JSON.stringify({ ...summary, dataSourceId, generatedAt: new Date().toISOString() }, null, 2));
  console.log(`[eval] 执行准确率: ${(summary.accuracy * 100).toFixed(1)}%（pass ${pass}/${summary.total}）· 报告: ${reportPath}`);
  return summary;
}
