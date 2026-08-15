/**
 * 评测 CLI 入口：npm run eval [-- --limit 5 | --case c01,c07 | --base-url http://...]
 */
import dotenv from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval } from './evalRunner';
import { initSchema } from '../db';

// golden SQL 走进程内安全执行层，需要 MySQL 连接配置与 DB 池（与 server.ts 同序：先 dotenv 再惰性读取）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
dotenv.config({ path: join(ROOT, '.env.local') });
dotenv.config({ path: join(ROOT, '.env') });

function parseArgs(argv: string[]) {
  const opts: { limit?: number; caseIds?: string[]; baseUrl?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') opts.limit = Number(argv[++i]) || undefined;
    else if (a === '--case') opts.caseIds = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--base-url') opts.baseUrl = argv[++i];
  }
  return opts;
}

(async () => {
  try {
    await initSchema();
  } catch (err: any) {
    console.warn('[eval] 数据库初始化失败（golden SQL 将逐条报错）:', err?.message || err);
  }
  return runEval(parseArgs(process.argv.slice(2)));
})()
  .then((s) => {
    // 存在失败/错误用例时以非零码退出，便于 CI 回归把关
    process.exit(s.fail + s.error > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('[eval] 运行失败:', err?.message || err);
    process.exit(2);
  });
