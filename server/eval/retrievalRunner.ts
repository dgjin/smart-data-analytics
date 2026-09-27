/**
 * P3-3 知识库检索层评测运行器（v0.9.78，参照「RAG 准确率优化」文章的评估集方法论）。
 * 指标：Hit Rate@K（期望文档有任一块进入 top-K 的用例占比）、MRR（期望文档首次命中名次的倒数均值）、
 * 负例零注入率（域外/危险问题不得注入任何知识块，验收向量阈值 + 词法双条件防线）。
 * 与 evalRunner（端到端执行准确率，需 LLM）互补：本 runner 只测检索层、不调 LLM，秒级可跑，
 * 适合 embedding 模型/融合策略的 A/B 对比。
 *
 * 用法：npm run eval:retrieval [-- --top-k 6 --limit 10 --case rt01,rt02 --min-hit-rate 0.7 --file <集> --ds <数据源>]
 * 对比实验流程：EMBED_MODEL=qwen3-embedding:8b npm run reembed:embeddings（重嵌）→ 再跑本评测对比报告。
 */
import dotenv from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RowDataPacket } from 'mysql2/promise';
import { getPool, initSchema } from '../infra/db';
import { retrieveKnowledgeChunks } from '../knowledge/knowledgeBase';
import { TOP_K_CHUNKS } from '../knowledge/knowledgeBase';
import { currentEmbedModelId } from '../llm/llmClient';

export interface RetrievalCase {
  id: string;
  category: string;
  question: string;
  /** 期望命中的知识文档标题（与 knowledge_base.title 精确一致）；负例为空数组 */
  expectTitles: string[];
  note?: string;
}

export interface RetrievalCaseResult extends RetrievalCase {
  negative: boolean;
  /** 正例：期望标题是否进入 top-K；负例：是否零注入（titles 为空） */
  hit: boolean;
  /** 期望标题首次命中的名次（1-based）；未命中为 0 */
  rank: number;
  /** 实际注入的块数 */
  injected: number;
  /** 实际注入的去重标题（负例失败时的取证） */
  titles: string[];
}

export interface RetrievalSummary {
  total: number;
  positive: number;
  negative: number;
  hitRate: number;
  mrr: number;
  /** 负例零注入率（1 = 全部零注入） */
  negativePass: number;
  belowThreshold: boolean;
  durationMs: number;
  results: RetrievalCaseResult[];
}

export interface RunRetrievalOptions {
  casesFile?: string;
  dataSourceId?: string;
  topK?: number;
  limit?: number;
  caseIds?: string[];
  /** Hit Rate 门槛（0-1），低于该值以非零码退出 */
  minHitRate?: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/** 加载并校验检索评测集；缺 id/question 的用例直接剔除（防脏用例污染指标） */
export function loadRetrievalCases(path?: string): { dataSourceId: string; cases: RetrievalCase[] } {
  const file = path || join(HERE, 'retrievalCases.json');
  if (!existsSync(file)) throw new Error(`检索评测集不存在: ${file}`);
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  const dataSourceId = typeof raw?.dataSourceId === 'string' ? raw.dataSourceId : '';
  const cases = (Array.isArray(raw?.cases) ? raw.cases : [])
    .filter((c: Record<string, unknown>) => typeof c?.id === 'string' && typeof c?.question === 'string' && String(c.question).trim())
    .map((c: Record<string, unknown>) => ({
      id: String(c.id),
      category: String(c.category || 'single_agg'),
      question: String(c.question).trim(),
      expectTitles: Array.isArray(c.expectTitles) ? (c.expectTitles as unknown[]).map((t) => String(t)) : [],
      note: typeof c.note === 'string' ? c.note : undefined,
    }));
  return { dataSourceId, cases };
}

/** 逐条检索评测；负例（category=negative 或 expectTitles 为空）要求零注入 */
export async function runRetrievalEval(opts: RunRetrievalOptions = {}): Promise<RetrievalSummary> {
  const suite = loadRetrievalCases(opts.casesFile);
  const dataSourceId = opts.dataSourceId || suite.dataSourceId;
  if (!dataSourceId) throw new Error('检索评测集缺少 dataSourceId');
  const topK = opts.topK && opts.topK > 0 ? Math.floor(opts.topK) : TOP_K_CHUNKS;
  let cases = suite.cases;
  if (opts.caseIds && opts.caseIds.length > 0) {
    const ids = new Set(opts.caseIds);
    cases = cases.filter((c) => ids.has(c.id));
  }
  if (opts.limit && opts.limit > 0) cases = cases.slice(0, opts.limit);
  if (cases.length === 0) throw new Error('无待评测用例（检查 --case/--limit 过滤条件）');

  // 预检：知识库必须可读且非空——区分「检索无命中」与「DB/数据源配置错误」（后者静默全 miss 会误导优化方向）
  const [pre] = await getPool().query<RowDataPacket[]>(
    'SELECT COUNT(*) AS cnt FROM knowledge_base WHERE data_source_id = ?',
    [dataSourceId]
  );
  if (Number(pre[0]?.cnt) === 0) {
    throw new Error(`数据源 ${dataSourceId} 的知识库为空（或数据库未就绪）——请确认 initSchema 已执行且知识库有数据`);
  }

  const minHitRate = typeof opts.minHitRate === 'number' && opts.minHitRate >= 0 ? opts.minHitRate : 0.7;
  const t0 = Date.now();
  const results: RetrievalCaseResult[] = [];
  for (const c of cases) {
    const negative = c.category === 'negative' || c.expectTitles.length === 0;
    let titles: string[];
    try {
      const chunks = await retrieveKnowledgeChunks(dataSourceId, c.question, topK);
      titles = [...new Set(chunks.map((ch) => ch.title))];
    } catch {
      titles = [];
    }
    const rank = negative ? 0 : titles.findIndex((t) => c.expectTitles.includes(t)) + 1;
    results.push({
      ...c,
      negative,
      hit: negative ? titles.length === 0 : rank > 0,
      rank,
      injected: titles.length,
      titles,
    });
  }

  const pos = results.filter((r) => !r.negative);
  const neg = results.filter((r) => r.negative);
  const hits = pos.filter((r) => r.hit).length;
  const hitRate = pos.length > 0 ? hits / pos.length : 1;
  const mrr = pos.length > 0 ? pos.reduce((s, r) => s + (r.rank > 0 ? 1 / r.rank : 0), 0) / pos.length : 0;
  const negativePass = neg.length > 0 ? neg.filter((r) => r.hit).length / neg.length : 1;
  const summary: RetrievalSummary = {
    total: results.length,
    positive: pos.length,
    negative: neg.length,
    hitRate,
    mrr,
    negativePass,
    belowThreshold: hitRate < minHitRate || negativePass < 1,
    durationMs: Date.now() - t0,
    results,
  };

  // 报告生成物与 evalRunner 同目录（reports/ 子目录）
  const reportsDir = join(HERE, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `retrieval-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify(
      { ...summary, dataSourceId, topK, embedModel: currentEmbedModelId(), generatedAt: new Date().toISOString() },
      null,
      2
    )
  );

  console.log(`[retrieval] 模型 ${currentEmbedModelId()} · topK ${topK} · 用例 ${summary.total}（正 ${pos.length} / 负 ${neg.length}）`);
  console.log(
    `[retrieval] Hit Rate@${topK}: ${(hitRate * 100).toFixed(1)}%（${hits}/${pos.length}）· MRR ${mrr.toFixed(3)} · 负例零注入 ${neg.filter((r) => r.hit).length}/${neg.length} · 门槛 ${(minHitRate * 100).toFixed(0)}% · ${(summary.durationMs / 1000).toFixed(1)}s`
  );
  const byCategory = new Map<string, { hit: number; total: number }>();
  for (const r of results) {
    const s = byCategory.get(r.category) || { hit: 0, total: 0 };
    s.total++;
    if (r.hit) s.hit++;
    byCategory.set(r.category, s);
  }
  for (const cat of [...byCategory.keys()].sort()) {
    const s = byCategory.get(cat)!;
    console.log(`[retrieval]   ${cat.padEnd(12)} ${s.hit}/${s.total}`);
  }
  const misses = results.filter((r) => !r.hit);
  if (misses.length > 0) {
    console.log('[retrieval] 未通过用例:');
    for (const m of misses) {
      console.log(`  - ${m.id} [${m.category}] ${m.question}`);
      console.log(`    期望: ${m.expectTitles.join(' / ') || '(零注入)'}；实际: ${m.titles.join(' / ') || '(无)'}`);
    }
  }
  console.log(`[retrieval] 报告: ${reportPath}`);
  return summary;
}

function parseArgs(argv: string[]) {
  const opts: RunRetrievalOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top-k') opts.topK = Number(argv[++i]) || undefined;
    else if (a === '--limit') opts.limit = Number(argv[++i]) || undefined;
    else if (a === '--case') opts.caseIds = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--file') opts.casesFile = argv[++i];
    else if (a === '--ds') opts.dataSourceId = argv[++i];
    else if (a === '--min-hit-rate') {
      const v = Number(argv[++i]);
      // 支持 0-100 百分比或 0-1 小数两种写法
      if (Number.isFinite(v)) opts.minHitRate = v > 1 ? v / 100 : v;
    }
  }
  return opts;
}

// 直接运行（npm run eval:retrieval）时加载环境变量、初始化连接池、执行评测并以退出码反馈
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('retrievalRunner.ts');
if (isDirectRun) {
  // dotenv 先于惰性 env 读取（与 runEval.ts 同序）；initSchema 初始化 DB 连接池
  dotenv.config({ path: join(ROOT, '.env.local') });
  dotenv.config({ path: join(ROOT, '.env') });
  (async () => {
    try {
      await initSchema();
    } catch (err) {
      console.warn('[retrieval] 数据库初始化失败:', (err as Error)?.message || err);
    }
    return runRetrievalEval(parseArgs(process.argv.slice(2)));
  })()
    .then((s) => process.exit(s.belowThreshold ? 1 : 0))
    .catch((err) => {
      console.error('[retrieval] 运行失败:', err?.message || err);
      process.exit(2);
    });
}
