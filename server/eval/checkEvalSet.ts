/**
 * P0-2 CI 评测集结构门禁：不连数据库 / LLM，纯静态校验评测集的规模、六类分层覆盖与字段合法性。
 * 真实 LLM 准确率评测放本地 / nightly（npm run eval -- --min-accuracy 85），CI 内只做结构与阈值守门。
 *
 * 用法：npx tsx server/eval/checkEvalSet.ts [--min-count 100] [--file <评测集路径>] [--require cat1,cat2,...]
 * 退出码：0 = 通过；1 = 存在结构违规（CI 阻断合并）。
 * P3-2：支持 --file 校验独立评测集（如数据资源库宽表集），--require 覆盖必检分层（宽表集以 multi_dim 对齐主集 join 层）。
 */
import { loadEvalCases } from './evalRunner';

/** 六类分层（与 docs/评测集标注规范.md 一致） */
const REQUIRED_CATEGORIES = ['single_agg', 'join', 'time', 'subquery', 'clarify', 'refuse'] as const;
/** result 类之外的 expect 取值（golden SQL 仅占位不执行） */
const NON_RESULT_EXPECTS = new Set(['clarify', 'refuse']);

export interface EvalGateArgs {
  minCount: number;
  /** 评测集文件路径（默认主集 evalCases.json） */
  file?: string;
  /** 必检分层覆盖（默认六类）；宽表集传 single_agg,multi_dim,subquery,time,clarify,refuse */
  require?: string[];
}

export function parseEvalGateArgs(argv: string[]): EvalGateArgs {
  const out: EvalGateArgs = { minCount: 100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min-count') {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) out.minCount = Math.floor(v);
    } else if (a === '--file') {
      out.file = argv[++i];
    } else if (a === '--require') {
      out.require = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

export function checkEvalSet(minCount = 100, file?: string, require?: string[]): string[] {
  const suite = loadEvalCases(file);
  const required = require && require.length > 0 ? require : [...REQUIRED_CATEGORIES];
  const errors: string[] = [];

  // 1. 规模门槛
  if (suite.cases.length < minCount) {
    errors.push(`评测集规模不足：${suite.cases.length} < ${minCount}`);
  }

  // 2. id 唯一
  const ids = suite.cases.map((c) => c.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length > 0) errors.push(`用例 id 重复：${[...new Set(dup)].join(', ')}`);

  // 3. 分层全覆盖（主集六类；宽表集经 --require 指定 multi_dim 等口径）
  const byCategory = new Map<string, number>();
  for (const c of suite.cases) {
    byCategory.set(c.category, (byCategory.get(c.category) || 0) + 1);
  }
  for (const cat of required) {
    if (!byCategory.get(cat)) errors.push(`分层缺失：category=${cat} 无用例`);
  }

  // 4. 逐用例字段合法性
  for (const c of suite.cases) {
    if (!c.question.trim()) errors.push(`${c.id}: question 为空`);
    if (!/^select\b/i.test(c.goldenSql.trim())) errors.push(`${c.id}: goldenSql 非 SELECT`);
    // clarify/refuse 类必须显式标注 expect，且 category 与 expect 一致
    if (NON_RESULT_EXPECTS.has(c.category) && c.expect !== c.category) {
      errors.push(`${c.id}: category=${c.category} 但 expect=${c.expect}（应一致）`);
    }
    if (NON_RESULT_EXPECTS.has(c.expect) && c.category !== c.expect) {
      errors.push(`${c.id}: expect=${c.expect} 但 category=${c.category}（应一致）`);
    }
  }

  return errors;
}

// 直接运行（tsx server/eval/checkEvalSet.ts）时执行门禁并以退出码反馈
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('checkEvalSet.ts');
if (isDirectRun) {
  const args = parseEvalGateArgs(process.argv.slice(2));
  const suite = loadEvalCases(args.file);
  const errors = checkEvalSet(args.minCount, args.file, args.require);
  const required = args.require && args.require.length > 0 ? args.require : [...REQUIRED_CATEGORIES];
  const byCategory = new Map<string, number>();
  for (const c of suite.cases) byCategory.set(c.category, (byCategory.get(c.category) || 0) + 1);
  console.log(`[eval-gate] 评测集 ${args.file || '(主集)'} ${suite.cases.length} 条（门槛 ${args.minCount}）`);
  for (const cat of required) {
    console.log(`[eval-gate]   ${cat}: ${byCategory.get(cat) || 0} 条`);
  }
  if (errors.length > 0) {
    console.error(`[eval-gate] 结构校验失败（${errors.length} 项）:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('[eval-gate] 结构校验通过');
}
