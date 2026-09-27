/**
 * P3-3 CI 检索评测集结构门禁：不连数据库 / LLM，纯静态校验检索评测集的规模、字段合法性与负例覆盖。
 * 真实检索指标（Hit Rate/MRR）需 embedding 服务，放本地跑（npm run eval:retrieval）；CI 内只做结构守门。
 * 注意：expectTitles 与 knowledge_base.title 的精确一致性依赖数据库，无法离线校验——
 * 修改知识库文档标题后须同步核对本评测集标注（否则正例会静默变成 miss）。
 *
 * 用法：npx tsx server/eval/checkRetrievalSet.ts [--min-count 24] [--min-negative 3] [--file <评测集路径>]
 * 退出码：0 = 通过；1 = 存在结构违规（CI 阻断合并）。
 */
import { loadRetrievalCases } from './retrievalRunner';

/** 允许的分层（与 retrievalCases.json 的 categories 一致） */
const REQUIRED_CATEGORIES = ['single_agg', 'multi_dim', 'subquery', 'time', 'compare', 'select_guide', 'negative'] as const;

export interface RetrievalGateArgs {
  minCount: number;
  minNegative: number;
  file?: string;
}

export function parseRetrievalGateArgs(argv: string[]): RetrievalGateArgs {
  const out: RetrievalGateArgs = { minCount: 24, minNegative: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-count') {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) out.minCount = Math.floor(v);
    } else if (a === '--min-negative') {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) out.minNegative = Math.floor(v);
    } else if (a === '--file') {
      out.file = argv[++i];
    }
  }
  return out;
}

export function checkRetrievalSet(minCount = 24, minNegative = 3, file?: string): string[] {
  const suite = loadRetrievalCases(file);
  const errors: string[] = [];

  // 1. 数据源与规模门槛
  if (!suite.dataSourceId.trim()) errors.push('缺少 dataSourceId（评测需绑定知识库所在数据源）');
  if (suite.cases.length < minCount) {
    errors.push(`评测集规模不足：${suite.cases.length} < ${minCount}`);
  }

  // 2. id 唯一且命名规范（rt + 数字）
  const ids = suite.cases.map((c) => c.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length > 0) errors.push(`用例 id 重复：${[...new Set(dup)].join(', ')}`);

  const allowed = new Set<string>(REQUIRED_CATEGORIES);
  let negativeCount = 0;
  for (const c of suite.cases) {
    if (!/^rt\d{2,}$/.test(c.id)) errors.push(`${c.id}: id 不符合 rt+数字 命名规范`);
    if (c.question.trim().length < 4) errors.push(`${c.id}: question 过短（<4 字符）`);
    if (!allowed.has(c.category)) errors.push(`${c.id}: category=${c.category} 不在允许集合`);
    const isNegative = c.category === 'negative';
    if (isNegative) {
      negativeCount++;
      if (c.expectTitles.length !== 0) errors.push(`${c.id}: 负例 expectTitles 必须为空数组（零注入验收）`);
    } else {
      if (c.expectTitles.length === 0) errors.push(`${c.id}: 正例 expectTitles 不能为空（标注期望命中的知识文档）`);
    }
    for (const t of c.expectTitles) {
      if (t.trim().length < 2) errors.push(`${c.id}: expectTitles 含过短标题「${t}」`);
    }
    if (new Set(c.expectTitles).size !== c.expectTitles.length) {
      errors.push(`${c.id}: expectTitles 存在重复项`);
    }
  }

  // 3. 负例覆盖（零注入防线 + 域外/危险问题边界）
  if (negativeCount < minNegative) {
    errors.push(`负例覆盖不足：${negativeCount} < ${minNegative}（域外/危险问题零注入验收）`);
  }
  // 4. 分层覆盖：每个允许分层至少 1 条（negative 由负例门槛约束）
  const byCategory = new Map<string, number>();
  for (const c of suite.cases) byCategory.set(c.category, (byCategory.get(c.category) || 0) + 1);
  for (const cat of REQUIRED_CATEGORIES) {
    if (!byCategory.get(cat)) errors.push(`分层缺失：category=${cat} 无用例`);
  }

  return errors;
}

// 直接运行（tsx server/eval/checkRetrievalSet.ts）时执行门禁并以退出码反馈
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('checkRetrievalSet.ts');
if (isDirectRun) {
  const args = parseRetrievalGateArgs(process.argv.slice(2));
  const suite = loadRetrievalCases(args.file);
  const errors = checkRetrievalSet(args.minCount, args.minNegative, args.file);
  const byCategory = new Map<string, number>();
  for (const c of suite.cases) byCategory.set(c.category, (byCategory.get(c.category) || 0) + 1);
  console.log(`[retrieval-gate] 检索评测集 ${args.file || '(默认)'} ${suite.cases.length} 条（门槛 ${args.minCount}，负例门槛 ${args.minNegative}）`);
  for (const cat of REQUIRED_CATEGORIES) {
    console.log(`[retrieval-gate]   ${cat}: ${byCategory.get(cat) || 0} 条`);
  }
  if (errors.length > 0) {
    console.error(`[retrieval-gate] 结构校验失败（${errors.length} 项）:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('[retrieval-gate] 结构校验通过');
}
