/**
 * 评测 CLI 入口：npm run eval [-- --limit 5 | --case c01,c07 | --file server/eval/evalCases.jichuang.json | --base-url http://... | --min-accuracy 85]
 * --file：指定评测集文件（默认 server/eval/evalCases.json），宽表评测集走独立文件
 * --min-accuracy：准确率阈值（0-100 百分比或 0-1 小数），低于阈值以非零码退出（P0-2 CI 门禁阻断依据）
 * --engine/--model：请求级引擎覆盖（本地 vs 云端对比评测用），同批用例在同一服务进程内分别指定引擎实跑
 * P0-4 稳定性治理：--runs 3（同集连跑取均值）、--max-drop 15（单跑跌幅上限，百分比或小数），
 * --category join,time（按分类定向评测）、--per-category-limit 3（每类取前 N 条）、
 * --ontology on|off（本体注入 A/B，off 时请求体发送 disableOntology，服务端仅对 ADMIN 生效）
 */
import dotenv from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval } from './evalRunner';
import { initSchema } from '../infra/db';

// golden SQL 走进程内安全执行层，需要 MySQL 连接配置与 DB 池（与 server.ts 同序：先 dotenv 再惰性读取）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: join(ROOT, '.env.local') });
dotenv.config({ path: join(ROOT, '.env') });

function parseArgs(argv: string[]) {
  const opts: {
    limit?: number; caseIds?: string[]; baseUrl?: string; minAccuracy?: number;
    casesFile?: string; engine?: string; model?: string;
    runs?: number; maxRunDrop?: number; categories?: string[]; perCategoryLimit?: number;
    ontology?: 'on' | 'off';
  } = {};
  // 百分比/小数双写法归一：>1 视为百分比（15 → 0.15）
  const ratio = (raw: string | undefined): number | undefined => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return undefined;
    return v > 1 ? v / 100 : v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') opts.limit = Number(argv[++i]) || undefined;
    else if (a === '--case') opts.caseIds = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--file') opts.casesFile = argv[++i];
    else if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--engine') opts.engine = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--runs') {
      const v = Math.floor(Number(argv[++i]));
      if (Number.isFinite(v) && v >= 1) opts.runs = v;
    } else if (a === '--max-drop') {
      opts.maxRunDrop = ratio(argv[++i]);
    } else if (a === '--category') {
      opts.categories = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--per-category-limit') {
      const v = Math.floor(Number(argv[++i]));
      if (Number.isFinite(v) && v >= 1) opts.perCategoryLimit = v;
    } else if (a === '--ontology') {
      const v = String(argv[++i] || '').trim().toLowerCase();
      if (v === 'on' || v === 'off') opts.ontology = v;
      else console.warn(`[eval] 忽略非法的 --ontology 取值：${v}（仅支持 on|off）`);
    } else if (a === '--min-accuracy') {
      // 支持 0-100 百分比或 0-1 小数两种写法
      opts.minAccuracy = ratio(argv[++i]);
    }
  }
  return opts;
}

(async () => {
  try {
    await initSchema();
  } catch (err) {
    console.warn('[eval] 数据库初始化失败（golden SQL 将逐条报错）:', (err as Error)?.message || String(err));
  }
  return runEval(parseArgs(process.argv.slice(2)));
})()
  .then((s) => {
    // 存在失败/错误用例，或准确率低于阈值（P0-2 CI 门禁）时以非零码退出，便于 CI 回归把关
    const failed = s.fail + s.error > 0 || s.belowThreshold === true;
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error('[eval] 运行失败:', err?.message || err);
    process.exit(2);
  });
