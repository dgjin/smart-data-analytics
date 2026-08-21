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
  /** 难度分类（六类分层）：single_agg/join/time/subquery/clarify/refuse；加载时缺省补 single_agg */
  category: string;
  /** 期望结果：result=执行准确率；clarify=应澄清；refuse=应拒答；加载时缺省补 result */
  expect: 'result' | 'clarify' | 'refuse';
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

/** 按难度分类的分层统计 */
export interface CategoryStat {
  total: number;
  pass: number;
  accuracy: number;
}

export interface EvalSummary {
  total: number;
  pass: number;
  fail: number;
  error: number;
  rateLimited: number;
  accuracy: number;
  avgDurationMs: number;
  /** 六类分层统计（category -> 该类 total/pass/accuracy） */
  byCategory: Record<string, CategoryStat>;
  /** 准确率阈值（P0-2 CI 门禁）；低于阈值 belowThreshold=true */
  minAccuracy?: number;
  belowThreshold?: boolean;
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
      category: typeof c.category === 'string' && c.category ? c.category : 'single_agg',
      expect: c.expect === 'clarify' || c.expect === 'refuse' ? (c.expect as 'clarify' | 'refuse') : ('result' as const),
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

/** 分层统计：按用例 category 聚合 total/pass/accuracy（纯函数，便于单测） */
export function computeCategoryStats(results: EvalCaseResult[], cases: EvalCase[]): Record<string, CategoryStat> {
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const byCategory: Record<string, CategoryStat> = {};
  for (const r of results) {
    const cat = caseById.get(r.caseId)?.category || 'single_agg';
    if (!byCategory[cat]) byCategory[cat] = { total: 0, pass: 0, accuracy: 0 };
    byCategory[cat].total++;
    if (r.status === 'pass') byCategory[cat].pass++;
  }
  for (const cat of Object.keys(byCategory)) {
    const s = byCategory[cat];
    s.accuracy = s.total > 0 ? s.pass / s.total : 0;
  }
  return byCategory;
}

/** 阈值判定：accuracy 低于 minAccuracy 视为不达标（P0-2 CI 门禁） */
export function isBelowThreshold(accuracy: number, minAccuracy?: number): boolean {
  return typeof minAccuracy === 'number' && accuracy < minAccuracy;
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
  /** 准确率阈值（0-1）；低于阈值 belowThreshold=true（P0-2 CI 门禁阻断依据） */
  minAccuracy?: number;
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
        // refreshCache=true：评测测的是 LLM 全链路准确率，必须旁路 L1/L2 结果缓存，
        // 否则同域近似问题会命中彼此缓存导致测量失真（P1-7 基线评测实测污染）
        body: JSON.stringify({ query: c.question, dataSourceId, refreshCache: true }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429) {
        result.status = 'rate-limited';
        result.reason = '触发配额/限流，跳过本用例（评测前可给服务端设 USER_QUERY_RATE_MAX 提额）';
      } else if (!res.ok) {
        result.status = 'error';
        result.reason = `HTTP ${res.status}`;
      } else {
        const data: any = await res.json();
        if (c.expect === 'clarify') {
          // 需澄清用例：期望返回 needClarification（歧义澄清，不执行 SQL）
          if (data?.needClarification === true) {
            result.status = 'pass';
          } else {
            result.status = 'fail';
            result.reason = data?.refused === true ? '期望澄清但被拒答' : '期望澄清但直接返回结果';
          }
        } else if (c.expect === 'refuse') {
          // 应拒答用例：期望返回 refused
          if (data?.refused === true) {
            result.status = 'pass';
          } else {
            result.status = 'fail';
            result.reason = data?.needClarification === true ? '期望拒答但触发澄清' : '期望拒答但返回了结果';
          }
        } else {
          const rows = data?.result?.rows;
          if (!data?.success || data?.refused === true || data?.needClarification === true || !Array.isArray(rows)) {
            result.status = 'error';
            result.reason = data?.refused === true ? '意外拒答' : data?.needClarification === true ? '意外触发澄清' : (data?.error || '响应缺少结果行');
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
  // 六类分层统计 + 阈值判定（纯函数，便于单测）
  const byCategory = computeCategoryStats(results, cases);
  const accuracy = results.length > 0 ? pass / results.length : 0;
  const minAccuracy = opts.minAccuracy;
  const belowThreshold = isBelowThreshold(accuracy, minAccuracy);
  const summary: EvalSummary = {
    total: results.length,
    pass,
    fail: results.filter((r) => r.status === 'fail').length,
    error: results.filter((r) => r.status === 'error').length,
    rateLimited: results.filter((r) => r.status === 'rate-limited').length,
    accuracy,
    avgDurationMs: results.length > 0 ? Math.round(results.reduce((s, r) => s + r.durationMs, 0) / results.length) : 0,
    byCategory,
    minAccuracy,
    belowThreshold,
    results,
  };

  const reportPath = join(HERE, `eval-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, JSON.stringify({ ...summary, dataSourceId, generatedAt: new Date().toISOString() }, null, 2));
  console.log(`[eval] 执行准确率: ${(summary.accuracy * 100).toFixed(1)}%（pass ${pass}/${summary.total}）· 报告: ${reportPath}`);
  for (const cat of Object.keys(byCategory).sort()) {
    const s = byCategory[cat];
    console.log(`[eval]   ${cat.padEnd(12)} ${(s.accuracy * 100).toFixed(1)}%（${s.pass}/${s.total}）`);
  }
  if (belowThreshold) {
    console.error(`[eval] ⚠️ 准确率 ${(accuracy * 100).toFixed(1)}% 低于阈值 ${(Number(minAccuracy) * 100).toFixed(0)}%（P0-2 门禁）`);
  }
  return summary;
}
