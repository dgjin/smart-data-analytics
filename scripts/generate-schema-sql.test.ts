import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 数据库升级脚本同步校验：
 * deploy/sql/upgrade.sql 是 scripts/generate-schema-sql.mjs 的生成产物，
 * 源码（schema.ts / migration.ts / taskQueue.ts / anomalyPatrol.ts / createAbTestTable.ts）改动后
 * 必须重新生成并一起提交，否则本用例失败，pre-push 的 npm test 即拦截，避免脚本与 initSchema() 漂移。
 */

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/generate-schema-sql.mjs');
const SQL_PATH = join(ROOT, 'deploy/sql/upgrade.sql');

describe('deploy/sql/upgrade.sql 与源码同步', () => {
  it('生成器 --check 通过（产物无漂移）', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('校验通过');
  });

  it('建表数量与脚本头部声明一致，且全部为 IF NOT EXISTS', () => {
    const sql = readFileSync(SQL_PATH, 'utf8');
    const declared = Number(sql.match(/-- 建表合计：(\d+) 张/)![1]);
    // 只统计行首语句，避免把头部说明里的「建表用 CREATE TABLE IF NOT EXISTS」计入
    expect(sql.match(/^CREATE TABLE (?:IF NOT EXISTS )?\w+/gm)).toHaveLength(declared);
    expect(sql.match(/^CREATE TABLE IF NOT EXISTS \w+/gm)).toHaveLength(declared);
  });

  it('加列/加索引不裸执行：ADD COLUMN 仅在 information_schema 判重块内出现，且不依赖存储过程', () => {
    const sql = readFileSync(SQL_PATH, 'utf8');
    // 裸 ALTER TABLE ... ADD COLUMN / ADD INDEX 一旦重跑会报重复列，这里确保没有
    expect(sql).not.toMatch(/^ALTER TABLE \w+ ADD (COLUMN|INDEX)/m);
    expect(sql).toContain('information_schema.COLUMNS');
    expect(sql).toContain('information_schema.STATISTICS');
    // 受限权限环境可能不具备 CREATE ROUTINE，脚本不得使用存储过程
    expect(sql).not.toMatch(/CREATE\s+(DEFINER\s*=\s*\S+\s+)?PROCEDURE/i);
  });
});
