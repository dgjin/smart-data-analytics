#!/usr/bin/env node
/**
 * v0.9.78 embedding 存量向量备份/重嵌/恢复脚本
 *
 * 用途：切换 EMBED_MODEL（如 nomic-embed-text → qwen3-embedding:8b）后，把
 *       knowledge_base（知识库 RAG 块向量）与 sql_examples（few-shot 样例问题向量）的
 *       存量向量按当前模型全部重算——新旧向量混存时维度不一致，检索端会静默退化为纯词法。
 *
 * 执行方式：
 *   EMBED_MODEL=qwen3-embedding:8b npx tsx scripts/reembed-embeddings.ts   # 备份 + 重嵌
 *   npx tsx scripts/reembed-embeddings.ts --dry-run                        # 仅备份与体检（不改库）
 *   npx tsx scripts/reembed-embeddings.ts --restore backups/embeddings-xxx.json  # 从备份恢复
 *
 * 注意：重嵌前选好 EMBED_MODEL（命令行 env 优先于 .env.local），完成后重启服务；
 *       备份文件按「存量维度」标注（重嵌流程中 env 已是目标模型，记录模型名会张冠李戴）；
 *       与业务链路共用 callEmbeddingBatch，引擎解析/指令前缀/批大小与线上完全一致。
 */

import { createPool } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2/promise';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载 .env.local 中的 MySQL 与模型配置（命令行显式 env 优先，dotenv 不覆盖已有值）
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { callEmbeddingBatch, currentEmbedModelId } from '../server/llm/llmEmbedding';
import { initSchema } from '../server/infra/db';

const MYSQL_HOST = process.env.MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT || '3306');
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DB = process.env.MYSQL_DATABASE || process.env.MYSQL_DB || 'smart_analytics';
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

interface KbRow extends RowDataPacket {
  id: number;
  title: string | null;
  chunk_text: string | null;
  embedding_json: string | null;
}
interface SqlxRow extends RowDataPacket {
  id: number;
  question: string | null;
  embedding: string | null;
}

/** 向量维度集合（体检输出：确认存量向量与目标模型维度） */
function dimsOf(jsons: (string | null)[]): string {
  const dims = new Set<number>();
  let nullCount = 0;
  for (const j of jsons) {
    if (!j) {
      nullCount++;
      continue;
    }
    try {
      const v = JSON.parse(j);
      if (Array.isArray(v)) dims.add(v.length);
    } catch {
      nullCount++;
    }
  }
  const list = [...dims].sort((a, b) => a - b).join('/') || '无';
  return `维度 ${list}，空/损坏 ${nullCount} 条`;
}

async function makeBackup(pool: ReturnType<typeof createPool>): Promise<string> {
  const [kbRows] = await pool.query<any[]>('SELECT id, title, chunk_text, embedding_json FROM knowledge_base ORDER BY id');
  const [sqlxRows] = await pool.query<any[]>('SELECT id, question, embedding FROM sql_examples ORDER BY id');
  // 备份的是「切换前」的存量向量：此时 env 中的 EMBED_MODEL 已是本次重嵌的目标模型，
  // 旧模型名无从考证——改记录存量维度，恢复时按维度核对模型，避免按错误模型名操作
  const dump = {
    createdAt: new Date().toISOString(),
    storedDims: {
      knowledgeBase: dimsOf(kbRows.map((r) => r.embedding_json)),
      sqlExamples: dimsOf(sqlxRows.map((r) => r.embedding)),
    },
    knowledgeBase: kbRows.map((r) => ({ id: Number(r.id), embedding_json: r.embedding_json ?? null })),
    sqlExamples: sqlxRows.map((r) => ({ id: Number(r.id), embedding: r.embedding ?? null })),
  };
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `embeddings-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  console.log(`💾 备份完成：${path.relative(process.cwd(), file)}`);
  console.log(`   存量向量：knowledge_base ${dump.storedDims.knowledgeBase}；sql_examples ${dump.storedDims.sqlExamples}`);
  console.log(`   knowledge_base ${kbRows.length} 条 / sql_examples ${sqlxRows.length} 条`);
  return file;
}

async function reembedAll(pool: ReturnType<typeof createPool>, dryRun: boolean): Promise<void> {
  console.log(`\n🧠 目标模型：${currentEmbedModelId()}${dryRun ? '（--dry-run 仅体检不写库）' : ''}\n`);

  // 1) knowledge_base：输入与 saveKnowledgeDoc 完全一致（title\nchunk），role=document
  const [kbRows] = await pool.query<KbRow[]>('SELECT id, title, chunk_text, embedding_json FROM knowledge_base ORDER BY id');
  if (kbRows.length > 0) {
    console.log(`📚 knowledge_base：存量 ${dimsOf(kbRows.map((r) => r.embedding_json))}`);
    if (!dryRun) {
      const t0 = Date.now();
      const vecs = await callEmbeddingBatch(
        kbRows.map((r) => `${r.title || ''}\n${r.chunk_text || ''}`),
        'document'
      );
      let ok = 0;
      for (let i = 0; i < kbRows.length; i++) {
        const v = vecs[i];
        if (Array.isArray(v) && v.length > 0) {
          await pool.query('UPDATE knowledge_base SET embedding_json = ? WHERE id = ?', [JSON.stringify(v), kbRows[i].id]);
          ok++;
        }
      }
      console.log(`   ✅ 重嵌 ${ok}/${kbRows.length} 条（维度 ${(vecs.find(Boolean) as number[] | undefined)?.length || 0}，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      if (ok < kbRows.length) console.warn(`   ⚠️ ${kbRows.length - ok} 条未取得向量（保持原值），请检查引擎后重跑`);
    }
  } else {
    console.log('📚 knowledge_base：无存量数据');
  }

  // 2) sql_examples：输入与 embedExampleQuestion 完全一致（question 截断 500），role=document
  const [sqlxRows] = await pool.query<SqlxRow[]>('SELECT id, question, embedding FROM sql_examples ORDER BY id');
  if (sqlxRows.length > 0) {
    console.log(`🧩 sql_examples：存量 ${dimsOf(sqlxRows.map((r) => r.embedding))}`);
    if (!dryRun) {
      const t0 = Date.now();
      const vecs = await callEmbeddingBatch(
        sqlxRows.map((r) => String(r.question || '').slice(0, 500)),
        'document'
      );
      let ok = 0;
      for (let i = 0; i < sqlxRows.length; i++) {
        const v = vecs[i];
        if (Array.isArray(v) && v.length > 0) {
          await pool.query('UPDATE sql_examples SET embedding = ? WHERE id = ?', [JSON.stringify(v), sqlxRows[i].id]);
          ok++;
        }
      }
      console.log(`   ✅ 重嵌 ${ok}/${sqlxRows.length} 条（维度 ${(vecs.find(Boolean) as number[] | undefined)?.length || 0}，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      if (ok < sqlxRows.length) console.warn(`   ⚠️ ${sqlxRows.length - ok} 条未取得向量（保持原值），请检查引擎后重跑`);
    }
  } else {
    console.log('🧩 sql_examples：无存量数据');
  }

  if (!dryRun) {
    // 重嵌后校验：全库应为同一维度
    const [kbAfter] = await pool.query<any[]>('SELECT embedding_json FROM knowledge_base');
    const [sqlxAfter] = await pool.query<any[]>('SELECT embedding FROM sql_examples');
    console.log(`\n🔎 重嵌后体检：knowledge_base ${dimsOf(kbAfter.map((r) => r.embedding_json))}；sql_examples ${dimsOf(sqlxAfter.map((r) => r.embedding))}`);
    console.log('💡 下一步：确认 .env.local 的 EMBED_MODEL 与本次一致后重启服务；回滚用 --restore <备份文件>');
  }
}

async function restoreAll(pool: ReturnType<typeof createPool>, file: string): Promise<void> {
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(abs)) throw new Error(`备份文件不存在：${abs}`);
  const dump = JSON.parse(fs.readFileSync(abs, 'utf8')) as {
    /** 新版（v0.9.78 修正后）备份记录存量维度；旧格式误记目标模型名，已不再采信展示 */
    storedDims?: { knowledgeBase?: string; sqlExamples?: string };
    knowledgeBase?: { id: number; embedding_json: string | null }[];
    sqlExamples?: { id: number; embedding: string | null }[];
  };
  const dimsNote = dump.storedDims
    ? `（存量向量：knowledge_base ${dump.storedDims.knowledgeBase || '未知'}；sql_examples ${dump.storedDims.sqlExamples || '未知'}）`
    : '（旧格式备份，无维度标注）';
  console.log(`♻️ 从备份恢复：${path.relative(process.cwd(), abs)}${dimsNote}`);
  let kb = 0;
  for (const r of dump.knowledgeBase || []) {
    await pool.query('UPDATE knowledge_base SET embedding_json = ? WHERE id = ?', [r.embedding_json, r.id]);
    kb++;
  }
  let sqlx = 0;
  for (const r of dump.sqlExamples || []) {
    await pool.query('UPDATE sql_examples SET embedding = ? WHERE id = ?', [r.embedding, r.id]);
    sqlx++;
  }
  console.log(`   ✅ 已恢复 knowledge_base ${kb} 条 / sql_examples ${sqlx} 条`);
  console.log('⚠️ 请把 .env.local 的 EMBED_MODEL 设为与恢复后向量维度一致的模型后重启服务，否则检索会因维度不一致退化');
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const restoreIdx = argv.indexOf('--restore');
  const restoreFile = restoreIdx >= 0 ? argv[restoreIdx + 1] : '';

  console.log('🔁 embedding 存量向量重嵌脚本（v0.9.78）\n');
  // initSchema 初始化连接池（同时让用量埋点落库，与线上口径一致）
  try {
    await initSchema();
  } catch (err) {
    console.warn('⚠️ 数据库初始化失败:', (err as Error)?.message || err);
  }
  const pool = createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DB,
  });

  try {
    if (restoreIdx >= 0) {
      if (!restoreFile) throw new Error('用法：--restore <备份文件路径>');
      await restoreAll(pool, restoreFile);
      return;
    }
    await makeBackup(pool);
    await reembedAll(pool, dryRun);
  } finally {
    await pool.end();
  }
}

// initSchema 初始化的全局连接池会保持事件循环——成功路径必须显式退出，否则命令执行完不返回（v0.9.78 A/B 实测暴露）
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ 重嵌失败:', err.message);
    process.exit(1);
  });
