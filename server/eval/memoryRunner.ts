/**
 * 统一记忆体纠错召回离线评测（M3 验收）。
 * 指标：Top-1 准确率（正例期望记忆排第一）、负例零召回率（无关问题不得注入纠错记忆）。
 * 纯离线：用例内联候选记忆，走与线上一致的 rankCorrectionItems（rel 阈值 + 融合分排序），
 * 不连 DB、不调 LLM，秒级可跑，适合调相似度阈值/衰减参数时回归。
 *
 * 用法：npm run eval:memory [-- --min-accuracy 0.9 --file <集> --case mem-01,mem-02]
 */
import dotenv from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankCorrectionItems } from '../memory/correctionRanking';
import { normalizeErrorType } from '../memory/governance';
import type { MemoryItem } from '../memory/types';

/** 用例内联的最小记忆字段（可选字段给出宽松默认） */
interface MemoryCaseItemInput {
  id?: number;
  question?: string;
  content?: string;
  errorType?: string;
  confidence?: number;
  createdAt?: string;
  embedding?: number[];
}

export interface MemoryCase {
  id: string;
  query: string;
  items: MemoryItem[];
  /** 正例：期望排第一的记忆 id */
  expectTop?: number;
  /** 负例：期望零召回（不注入任何纠错记忆） */
  expectNone?: boolean;
  note?: string;
}

export interface MemoryCaseResult extends MemoryCase {
  negative: boolean;
  pass: boolean;
  /** 实际 top-1 记忆 id（0 表示无命中） */
  rankedIds: number[];
}

export interface MemorySummary {
  total: number;
  positive: number;
  negative: number;
  accuracy: number;
  top1: number;
  negativePass: number;
  belowThreshold: boolean;
  durationMs: number;
  results: MemoryCaseResult[];
}

export interface RunMemoryEvalOptions {
  casesFile?: string;
  caseIds?: string[];
  /** 准确率门槛（0-1），低于该值以非零码退出 */
  minAccuracy?: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
/** 评测常量化：排序取全量候选，便于诊断（真实召回 limit 默认 2，不影响 top-1 与零召回判定） */
const RANK_LIMIT = 10;

function toMemoryItem(raw: MemoryCaseItemInput, idx: number): MemoryItem {
  return {
    id: Number(raw.id) || idx + 1,
    kind: 'CORRECTION',
    dataSourceId: 'eval',
    userId: null,
    question: String(raw.question || '').trim(),
    content: String(raw.content || '').trim(),
    errorType: normalizeErrorType(raw.errorType),
    expectedSql: '',
    embedding: Array.isArray(raw.embedding) && raw.embedding.length > 0 ? raw.embedding : null,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.9,
    hits: 0,
    lastUsedAt: null,
    status: 'ACTIVE',
    source: 'ADMIN',
    createdBy: 'eval',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
  };
}

/** 加载并校验评测集；缺 id/query/items 或未声明期望的用例直接剔除（防脏用例污染指标） */
export function loadMemoryCases(path?: string): MemoryCase[] {
  const file = path || join(HERE, 'memoryCases.json');
  if (!existsSync(file)) throw new Error(`记忆评测集不存在: ${file}`);
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  return (Array.isArray(raw?.cases) ? raw.cases : [])
    .filter((c: Record<string, unknown>) => {
      const hasExpect = typeof c?.expectTop === 'number' || c?.expectNone === true;
      return typeof c?.id === 'string' && typeof c?.query === 'string' && String(c.query).trim() && Array.isArray(c?.items) && hasExpect;
    })
    .map((c: Record<string, unknown>) => ({
      id: String(c.id),
      query: String(c.query).trim(),
      items: (c.items as MemoryCaseItemInput[]).filter((it) => it && String(it.question || '').trim()).map(toMemoryItem),
      expectTop: typeof c.expectTop === 'number' ? c.expectTop : undefined,
      expectNone: c.expectNone === true,
      note: typeof c.note === 'string' ? c.note : undefined,
    }));
}

/** 逐条评测：负例要求零召回；正例要求期望记忆排 top-1 */
export function runMemoryEval(opts: RunMemoryEvalOptions = {}): MemorySummary {
  let cases = loadMemoryCases(opts.casesFile);
  if (opts.caseIds && opts.caseIds.length > 0) {
    const ids = new Set(opts.caseIds);
    cases = cases.filter((c) => ids.has(c.id));
  }
  if (cases.length === 0) throw new Error('无待评测用例（检查 --case 过滤条件或评测集内容）');

  const minAccuracy = typeof opts.minAccuracy === 'number' && opts.minAccuracy >= 0 ? opts.minAccuracy : 0.9;
  const t0 = Date.now();
  const results: MemoryCaseResult[] = cases.map((c) => {
    const ranked = rankCorrectionItems(c.query, c.items, { limit: RANK_LIMIT });
    const rankedIds = ranked.map((r) => r.item.id);
    const negative = c.expectNone === true || c.expectTop === undefined;
    const pass = negative ? rankedIds.length === 0 : rankedIds[0] === c.expectTop;
    return { ...c, negative, pass, rankedIds };
  });

  const pos = results.filter((r) => !r.negative);
  const neg = results.filter((r) => r.negative);
  const top1 = pos.filter((r) => r.pass).length;
  const negativePass = neg.length > 0 ? neg.filter((r) => r.pass).length / neg.length : 1;
  const accuracy = results.length > 0 ? results.filter((r) => r.pass).length / results.length : 0;
  const summary: MemorySummary = {
    total: results.length,
    positive: pos.length,
    negative: neg.length,
    accuracy,
    top1,
    negativePass,
    belowThreshold: accuracy < minAccuracy || negativePass < 1,
    durationMs: Date.now() - t0,
    results,
  };

  const reportsDir = join(HERE, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `memory-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, JSON.stringify({ ...summary, generatedAt: new Date().toISOString() }, null, 2));

  console.log(`[memory] 用例 ${summary.total}（正 ${pos.length} / 负 ${neg.length}）· 相似度通道 bigram（离线）`);
  console.log(
    `[memory] Top-1 ${top1}/${pos.length} · 负例零召回 ${neg.filter((r) => r.pass).length}/${neg.length} · 准确率 ${(accuracy * 100).toFixed(1)}% · 门槛 ${(minAccuracy * 100).toFixed(0)}% · ${(summary.durationMs / 1000).toFixed(2)}s`
  );
  const misses = results.filter((r) => !r.pass);
  if (misses.length > 0) {
    console.log('[memory] 未通过用例:');
    for (const m of misses) {
      const expect = m.negative ? '(零召回)' : String(m.expectTop);
      console.log(`  - ${m.id} ${m.query}`);
      console.log(`    期望: ${expect}；实际排序: ${m.rankedIds.join(' > ') || '(无)'}`);
    }
  }
  console.log(`[memory] 报告: ${reportPath}`);
  return summary;
}

function parseArgs(argv: string[]) {
  const opts: RunMemoryEvalOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--case') opts.caseIds = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--file') opts.casesFile = argv[++i];
    else if (a === '--min-accuracy') {
      const v = Number(argv[++i]);
      // 支持 0-100 百分比或 0-1 小数两种写法
      if (Number.isFinite(v)) opts.minAccuracy = v > 1 ? v / 100 : v;
    }
  }
  return opts;
}

// 直接运行（npm run eval:memory）：纯离线，dotenv 仅用于读取治理参数（半衰期等）
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('memoryRunner.ts');
if (isDirectRun) {
  dotenv.config({ path: join(ROOT, '.env.local') });
  dotenv.config({ path: join(ROOT, '.env') });
  try {
    const summary = runMemoryEval(parseArgs(process.argv.slice(2)));
    process.exit(summary.belowThreshold ? 1 : 0);
  } catch (err) {
    console.error('[memory] 运行失败:', (err as Error)?.message || err);
    process.exit(2);
  }
}
