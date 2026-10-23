#!/usr/bin/env node
/**
 * 数据库升级 SQL 生成器（v0.9.119）：
 * 从 server/infra/schema.ts（建表）+ taskQueue.ts / anomalyPatrol.ts / createAbTestTable.ts（按需建表）
 * + migration.ts / taskQueue.ts（存量列与索引迁移）抽取 DDL，生成累计式幂等脚本 deploy/sql/upgrade.sql。
 *
 * 设计要点：
 * - 用 TypeScript AST 读取字符串字面量，避免正则解析引号/转义出错（迁移语句含 ENUM('A','B') 与 DEFAULT ''）；
 * - 输出确定性内容（不含时间戳），`--check` 供门禁比对，防止源码与 SQL 漂移；
 * - 加列/加索引改写为 information_schema 判重 + PREPARE 动态执行，重复执行不报错且无需 CREATE ROUTINE 权限；
 * - 无法识别的 ALTER 直接报错退出，避免新迁移被静默漏掉。
 *
 * 用法：
 *   node scripts/generate-schema-sql.mjs           # 生成/覆盖 deploy/sql/upgrade.sql
 *   node scripts/generate-schema-sql.mjs --check   # 只校验产物是否与源码一致（不一致退出码 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_REL = 'deploy/sql/upgrade.sql';

/** 建表语句来源：按输出分组，组内文件按顺序抽取（AST 遍历顺序即源码顺序） */
const CREATE_GROUPS = [
  { label: '基础表（应用启动 initSchema 自动创建）', files: ['server/infra/schema.ts', 'server/infra/taskQueue.ts'] },
  { label: '按需表（巡检由启动时 ensurePatrolTables 创建；A/B 实验表按需手工创建）', files: ['server/anomalyPatrol.ts', 'server/infra/createAbTestTable.ts'] },
];

/** 存量迁移来源：只允许这两处出现 ALTER，新增迁移请继续放在 migration.ts */
const ALTER_FILES = ['server/infra/migration.ts', 'server/infra/taskQueue.ts'];

/** 读取一个 TS 文件中的字符串字面量（StringLiteral / 无插值模板串），注释与代码不参与 */
function collectStringLiterals(relFile) {
  const file = path.join(ROOT, relFile);
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const texts = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) texts.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return texts;
}

/** 去掉模板串的首尾空行与公共缩进，并补齐结尾分号 */
function normalizeSql(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indents = lines.filter((l) => l.trim()).map((l) => (l.match(/^ */) ?? [''])[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  const body = lines.map((l) => l.slice(Math.min(min, (l.match(/^ */) ?? [''])[0].length))).join('\n').trimEnd();
  return body.endsWith(';') ? body : `${body};`;
}

const escapeSqlString = (s) => s.replace(/'/g, "''");

/** 建表清单：名称唯一、语句以 CREATE TABLE IF NOT EXISTS 开头 */
function collectCreateStatements() {
  const groups = [];
  const seen = new Set();
  for (const group of CREATE_GROUPS) {
    const items = [];
    for (const file of group.files) {
      for (const text of collectStringLiterals(file)) {
        // 用未 trim 的原文计算公共缩进，否则首行缩进被抹掉会让 normalizeSql 的 min 变成 0
        const m = text.match(/^\s*CREATE TABLE IF NOT EXISTS\s+(\w+)/i);
        if (!m) continue;
        if (seen.has(m[1])) throw new Error(`建表语句重复：${m[1]}（${file}）`);
        seen.add(m[1]);
        items.push({ table: m[1], file, sql: normalizeSql(text) });
      }
    }
    if (items.length) groups.push({ label: group.label, items });
  }
  return { groups, total: seen.size };
}

/** 存量迁移：ADD COLUMN / ADD INDEX 改写为判重执行；MODIFY 幂等原样输出；其余一律报错 */
function collectAlterStatements() {
  const cols = [];
  const indexes = [];
  const modifies = [];
  const seen = new Set();
  for (const file of ALTER_FILES) {
    for (const text of collectStringLiterals(file)) {
      const raw = text.trim();
      if (!/^ALTER TABLE\s+\w+/i.test(raw)) continue;
      const sql = raw.replace(/;+$/, '');
      if (seen.has(sql)) continue;
      seen.add(sql);

      let m = sql.match(/^ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s+([\s\S]+)$/i);
      if (m) {
        const [, table, column, definition] = m;
        cols.push({
          table,
          column,
          ddl: `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`,
          file,
        });
        continue;
      }
      m = sql.match(/^ALTER TABLE\s+(\w+)\s+ADD INDEX\s+(\w+)\s*\(([\s\S]+)\)$/i);
      if (m) {
        const [, table, index, columns] = m;
        indexes.push({ table, index, ddl: `ALTER TABLE \`${table}\` ADD INDEX \`${index}\` (${columns})`, file });
        continue;
      }
      if (/^ALTER TABLE\s+\w+\s+MODIFY COLUMN\s+[\s\S]+$/i.test(sql)) {
        modifies.push({ table: sql.match(/^ALTER TABLE\s+(\w+)/i)[1], sql: `${sql};`, file });
        continue;
      }
      throw new Error(`无法识别的存量迁移语句（${file}）：${sql}`);
    }
  }
  return { cols, indexes, modifies };
}

/** 判重执行片段：不存在时才执行 ddl，存在时 DO 0 跳过（无需存储过程/额外权限） */
function guardedBlock({ table, key, ddl }, kind) {
  const meta = kind === 'column' ? 'COLUMNS' : 'STATISTICS';
  const keyName = kind === 'column' ? 'COLUMN_NAME' : 'INDEX_NAME';
  return [
    `-- ${table}.${key}`,
    `SET @schema_sql = (SELECT IF(COUNT(*) = 0, '${escapeSqlString(ddl)}', 'DO 0') FROM information_schema.${meta} WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND ${keyName} = '${key}');`,
    'PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;',
  ].join('\n');
}

function buildSql({ groups, total }, { cols, indexes, modifies }) {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const out = [];
  out.push(
    '-- ============================================================================',
    '-- 智能问数据分析系统 · 数据库升级脚本（累计式 / 幂等 / 生成产物）',
    '-- ============================================================================',
    `-- 适用版本：v${version}`,
    '-- 生成来源：server/infra/schema.ts、server/infra/taskQueue.ts、server/anomalyPatrol.ts、',
    '--           server/infra/createAbTestTable.ts（建表）',
    '--           server/infra/migration.ts、server/infra/taskQueue.ts（存量列/索引迁移）',
    '-- 生成命令：npm run db:sql（校验：npm run db:sql:check）；请勿手工修改本文件',
    '--',
    '-- 用法（先确认目标库，再执行；可对同一库重复执行）：',
    '--   mysql -h <host> -P <port> -u <user> -p <库名> < deploy/sql/upgrade.sql',
    '--',
    '-- 说明：',
    '--   1. 等价于应用启动时的 initSchema()：建表 + 存量结构迁移；不写种子数据（默认管理员、',
    '--      内置技能等由应用启动时的 seedInitialData 写入），也不做明文凭据加密等数据迁移；',
    '--   2. 全部语句幂等：建表用 CREATE TABLE IF NOT EXISTS；加列/加索引用 information_schema',
    '--      判重后动态执行；MODIFY 天然幂等；可在任意 ≤ 当前版本的存量库上重复执行；',
    '--   3. 执行账号需具备目标库的 CREATE / ALTER / INDEX 权限；本脚本使用 PREPARE 动态执行，',
    '--      不创建存储过程，无需 CREATE ROUTINE；',
    '--   4. 文件上传表（upl_*）与清洗中间表（ait_*）由应用运行时创建，不在本脚本范围内；',
    '--   5. 首选仍是启动应用自动迁移；本脚本供受限权限、离线交付或审计留档场景使用。',
    '-- ============================================================================',
    '',
    'SET NAMES utf8mb4;',
    '',
    `-- 建表合计：${total} 张（含按需表）`,
    '',
  );

  for (const group of groups) {
    out.push(`-- ────────────────────────────────────────────────────────────────────────────`);
    out.push(`-- ${group.label}`);
    out.push(`-- ────────────────────────────────────────────────────────────────────────────`, '');
    for (const item of group.items) {
      out.push(`-- 表：${item.table}（${item.file}）`, item.sql, '');
    }
  }

  out.push(
    '-- ────────────────────────────────────────────────────────────────────────────',
    '-- 存量结构迁移（与 initSchema 的 migrateSchema 同步；判重后执行，可重复运行）',
    '-- ────────────────────────────────────────────────────────────────────────────',
    '',
  );
  for (const col of cols) out.push(guardedBlock({ table: col.table, key: col.column, ddl: col.ddl }, 'column'), '');
  for (const idx of indexes) out.push(guardedBlock({ table: idx.table, key: idx.index, ddl: idx.ddl }, 'index'), '');
  for (const mod of modifies) out.push(`-- MODIFY（天然幂等）：${mod.table}`, mod.sql, '');
  out.push(
    '-- 结束：结构应与 initSchema() 启动后的 information_schema 保持一致。',
    '-- 提示：执行后重启应用，确认日志出现「[DB] MySQL ready」且无迁移告警。',
  );
  return `${out.join('\n').trimEnd()}\n`;
}

const creates = collectCreateStatements();
const alters = collectAlterStatements();
const sql = buildSql(creates, alters);
const outPath = path.join(ROOT, OUT_REL);

if (process.argv.includes('--check')) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  if (current !== sql) {
    console.error(`[db:sql] ${OUT_REL} 与源码不一致，请执行 npm run db:sql 重新生成并提交。`);
    process.exit(1);
  }
  console.log(`[db:sql] 校验通过：${OUT_REL}（${creates.total} 张表 / ${alters.cols.length} 加列 / ${alters.indexes.length} 加索引 / ${alters.modifies.length} MODIFY）`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, sql, 'utf8');
console.log(`[db:sql] 已生成 ${OUT_REL}：${creates.total} 张表 / ${alters.cols.length} 加列 / ${alters.indexes.length} 加索引 / ${alters.modifies.length} MODIFY`);
