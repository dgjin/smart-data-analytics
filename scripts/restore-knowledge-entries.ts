#!/usr/bin/env node
/**
 * 数据资源库业务知识库恢复脚本
 *
 * 用途：将 seedDataResources.ts 中的 DATA_RESOURCE_KNOWLEDGE_BASE（kb_001~kb_005）
 *       写入 knowledge_base_entries 表，恢复知识库管理页面与问数链路的知识注入。
 *
 * 执行方式：npx tsx scripts/restore-knowledge-entries.ts
 *
 * 幂等设计：INSERT ... ON DUPLICATE KEY UPDATE，可重复执行不产生重复数据
 */

import { createPool } from 'mysql2/promise';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { DATA_RESOURCE_KNOWLEDGE_BASE, DATA_RESOURCE_DS_ID } from '../server/seedDataResources';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载 .env.local 中的 MySQL 配置
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const MYSQL_HOST = process.env.MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT || '3306');
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DB = process.env.MYSQL_DB || 'smart_analytics';

async function main() {
  console.log('📚 数据资源库业务知识库恢复脚本启动...\n');

  const pool = createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DB,
  });

  try {
    // 恢复前状态
    const [beforeRows]: any = await pool.query(
      'SELECT COUNT(*) AS cnt FROM knowledge_base_entries WHERE data_source_id = ?',
      [DATA_RESOURCE_DS_ID]
    );
    console.log(`恢复前条目数：${beforeRows[0].cnt}\n`);

    for (const kb of DATA_RESOURCE_KNOWLEDGE_BASE) {
      await pool.query(
        `INSERT INTO knowledge_base_entries
           (entry_id, data_source_id, title, content, tags, category, version, is_preset, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, '1.0', 1, 'system', 'system')
         ON DUPLICATE KEY UPDATE
           title = VALUES(title),
           content = VALUES(content),
           tags = VALUES(tags),
           category = VALUES(category),
           is_preset = 1,
           updated_by = 'system'`,
        [
          kb.id,
          DATA_RESOURCE_DS_ID,
          kb.title,
          kb.content,
          JSON.stringify(kb.tags),
          kb.category,
        ]
      );
      console.log(`  ✅ ${kb.id} ${kb.title}（${kb.content.length} 字符，分类：${kb.category}）`);
    }

    // 恢复后验证
    const [afterRows]: any = await pool.query(
      `SELECT entry_id, title, category, LENGTH(content) AS len, is_preset
       FROM knowledge_base_entries WHERE data_source_id = ? ORDER BY entry_id`,
      [DATA_RESOURCE_DS_ID]
    );
    console.log(`\n恢复后条目数：${afterRows.length}`);
    for (const row of afterRows) {
      console.log(`  • ${row.entry_id} | ${row.title} | ${row.category} | ${row.len} 字符 | preset=${row.is_preset}`);
    }

    console.log('\n✅ 知识库恢复完成！');
    console.log('💡 验证方式：');
    console.log('  1. 系统管理 → 知识库管理 → 选择「数据资源」数据源查看条目');
    console.log('  2. 智能问数选择「数据资源」提问，回答应引用知识库口径');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ 恢复失败:', err.message);
  console.error(err.stack);
  process.exit(1);
});
